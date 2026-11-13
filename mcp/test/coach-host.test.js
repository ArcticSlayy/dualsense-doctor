import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoachServer, CoachHost, batteryFromReport } from '../coach-host.js';

function savedRound(id,peak=2) {
  return {id,complete:true,controller:{productId:3302,path:'fixture'},captures:['rest','range','release','buttons','verify'].map((phase,i)=>({number:i+1,phase,metrics:{valid:true,mode:'usb',samples:250,durationMs:5000,maxGapMs:20,left:{valid:true,peakRadiusPercent:peak,p99RadiusPercent:peak},right:{valid:true,peakRadiusPercent:peak,p99RadiusPercent:peak}}}))};
}
test('completed rounds accumulate conservatively without automatically starting another run',async()=>{
  const host=new CoachHost({});host.roundTarget=5;
  for(let i=0;i<5;i++)host.rememberRound(savedRound('round-'+i,2+i/2));
  host.rememberRound(savedRound('round-4',1));
  host.rememberRound({...savedRound('incomplete'),complete:false});
  const view=host.snapshot().measurements;
  assert.equal(view.targetRounds,5);assert.equal(view.rounds.length,5);assert.equal(view.comparison.acceptedRounds,5);
  assert.equal(view.comparison.left.suggestedDeadzonePercent,5);assert.equal(host.run,null);assert.equal(host.status,'idle');
  assert.doesNotMatch(JSON.stringify(view),/fixture|round-4/);
  host.status='running';await assert.rejects(host.control('reset_rounds'),/Stop/);
  host.status='complete';await host.control('reset_rounds');assert.equal(host.snapshot().measurements.rounds.length,0);
});
test('round targets validate before measurement and disconnect clears cross-device comparisons',async()=>{
  const host=new CoachHost({});await assert.rejects(host.control('start',{roundTarget:2}),/1, 3, or 5/);
  host.rememberRound(savedRound('one'));host.disconnect();
  assert.equal(host.snapshot().measurements.comparison.acceptedRounds,0);assert.equal(host.run,null);
});

test('separate retest runs in one session count as distinct rounds without reusing earlier captures',()=>{
  const host=new CoachHost({});
  const first=savedRound('same-session',4),second=savedRound('same-session',2);
  second.captures=second.captures.map(c=>({...c,number:c.number+5}));
  host.rememberRound(first,0);
  host.rememberRound({...second,captures:[...first.captures,...second.captures]},5);
  const view=host.snapshot().measurements;
  assert.equal(view.comparison.acceptedRounds,2);
  assert.equal(view.rounds[0].left.observedPeakPercent,4);
  assert.equal(view.rounds[1].left.observedPeakPercent,2);
  assert.equal(view.comparison.left.suggestedDeadzonePercent,5);
});

test('preparation, phase progress and current corrections remain distinct in snapshots',()=>{
  const host=new CoachHost({});host.status='running';
  host.event({type:'instruction',phase:'range',direction:'clockwise',countdownSeconds:3,message:'Clockwise'});
  let s=host.snapshot();assert.equal(s.preparing,true);assert.equal(s.direction,'clockwise');assert.ok(s.prepareSecondsRemaining>2);assert.equal(s.phaseProgress,0);
  host.event({type:'phase_start'});
  host.event({type:'progress',phaseProgress:.4,warning:'Left: slow down',details:{left:{cueCode:'too_fast'}}});
  s=host.snapshot();assert.equal(s.preparing,false);assert.equal(s.warning,'Left: slow down');assert.equal(s.phaseProgress,.4);
  host.event({type:'progress',phaseProgress:.5,warning:null,details:{left:{cueCode:'keep_going'}}});assert.equal(host.snapshot().warning,null);
  host.event({type:'phase_complete'});assert.equal(host.snapshot().phaseProgress,1);
  host.event({type:'instruction',phase:'range',direction:'counterclockwise',countdownSeconds:3});
  s=host.snapshot();assert.equal(s.phaseProgress,0);assert.deepEqual(s.details,{});assert.equal(s.direction,'counterclockwise');
  host.status='idle';s=host.snapshot();assert.equal(s.preparing,false);assert.equal(s.phase,null);assert.equal(s.secondsRemaining,null);assert.deepEqual(s.details,{});
});
test('battery reporting uses Sony status and does not invent a level for unknown reports',()=>{
  const usb=Array(64).fill(0);usb[53]=0x29;
  assert.equal(batteryFromReport(usb,'usb').level,100);
  usb[53]=0x15;assert.equal(batteryFromReport(usb,'usb').level,55);
  usb[53]=0xf0;assert.equal(batteryFromReport(usb,'usb').level,null);
  assert.equal(batteryFromReport(Array(10).fill(0),'bt-compat'),null);
});
test('trigger effects validate parameters and are blocked during measurement',async()=>{
  const sent=[],host=new CoachHost({});host.c={info:{},applyTriggers(...effects){sent.push(effects);}};host.latest={mode:'usb'};host.lastAt=performance.now();
  await assert.rejects(host.control('triggers',{preset:'custom',position:20,strength:2}),/position/);
  host.status='running';await assert.rejects(host.control('triggers',{preset:'firm'}),/Pause/);assert.equal(sent.length,0);
  host.status='idle';await host.control('triggers',{preset:'custom',position:2,strength:4,target:'left'});
  assert.equal(sent.length,1);assert.equal(sent[0][0][0],0x21);assert.equal(sent[0][1],null);
  assert.equal(host.snapshot().effects.triggers.deviceConfirmed,false);
});
test('live lightbar control validates RGB and sends only a temporary output command',async()=>{
  const writes=[],host=new CoachHost({});host.c={info:{},_mode:'usb',applyLightbar(...rgb){writes.push(rgb);}};host.latest={mode:'usb'};host.lastAt=performance.now();
  await assert.rejects(host.control('lightbar',{r:300,g:0,b:0}),/RGB/);
  await assert.rejects(host.control('lightbar',{r:1.5,g:0,b:0}),/RGB/);
  assert.equal(writes.length,0);
  const s=await host.control('lightbar',{r:10,g:20,b:30});assert.deepEqual(writes,[[10,20,30]]);
  assert.equal(s.effects.lightbar.commandSent,true);assert.equal(s.effects.lightbar.deviceConfirmed,false);
});
test('live relay requires a capability for state/control and does not accept calibration commands',async()=>{
  const host={snapshot(){return {connected:false,latest:null};},disconnect(){},control(action){if(action==='calibrate')throw Error('Unknown control action');return this.snapshot();}};
  const app=createCoachServer({host,port:0,token:'a'.repeat(64)});const addr=await app.listen();const base=`http://127.0.0.1:${addr.port}`;
  try {
    assert.equal((await fetch(base+'/state')).status,403);
    assert.equal((await fetch(base+'/state?token='+encodeURIComponent('é'.repeat(64)))).status,403);
    const r=await fetch(base+'/state?token='+app.token);assert.equal(r.status,200);assert.equal(r.headers.get('access-control-allow-origin'),'*');
    const bad=await fetch(base+'/control?token='+app.token,{method:'POST',body:JSON.stringify({action:'calibrate'})});assert.equal(bad.status,400);
    const preflight=await fetch(base+'/control',{method:'OPTIONS'});assert.equal(preflight.status,204);
  } finally {await app.close();}
});

test('live relay streams complete snapshots and closes its feed without hardware',async()=>{
  let snapshots=0,disconnects=0;
  const host={snapshot(){return {connected:false,sequence:++snapshots,calibration:{stage:'unknown'}};},disconnect(){disconnects++;}};
  const app=createCoachServer({host,port:0,token:'a'.repeat(64)}),addr=await app.listen();
  const abort=new AbortController(),timeout=setTimeout(()=>abort.abort(),2000);
  let closed=false;
  try {
    const response=await fetch(`http://127.0.0.1:${addr.port}/events?token=${app.token}`,{signal:abort.signal});
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'text/event-stream');
    const reader=response.body.getReader(),decoder=new TextDecoder();let received='';
    while((received.match(/event: state\n/g)||[]).length<2){const {value,done}=await reader.read();assert.equal(done,false);received+=decoder.decode(value,{stream:true});}
    const states=received.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
    assert.ok(states.length>=2);assert.equal(states[0].sequence,1);assert.ok(states[1].sequence>1);
    assert.ok(states.every(state=>state.calibration.stage==='unknown'));
    await app.close();closed=true;
    while(!(await reader.read()).done){}
    assert.equal(disconnects,1);
  } finally {clearTimeout(timeout);abort.abort();if(!closed)await app.close();}
});
