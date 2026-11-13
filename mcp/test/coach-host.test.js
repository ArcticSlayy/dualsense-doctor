import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoachServer, CoachHost, batteryFromReport } from '../coach-host.js';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function savedRound(id,peak=2) {
  return {id,complete:true,controller:{productId:3302,path:'fixture'},captures:['rest','range','release','buttons','verify'].map((phase,i)=>({number:i+1,phase,metrics:{valid:true,mode:'usb',samples:250,durationMs:5000,maxGapMs:20,left:{valid:true,peakRadiusPercent:peak,p99RadiusPercent:peak},right:{valid:true,peakRadiusPercent:peak,p99RadiusPercent:peak}}}))};
}

test('optional rendering timings are bounded, validated and compatible with old cards',async()=>{
 const host={snapshot(){return{};},disconnect(){}},app=createCoachServer({host,port:0,token:'a'.repeat(64)}),addr=await app.listen();
 const base=`http://127.0.0.1:${addr.port}`,send=m=>fetch(base+'/metrics?token='+app.token,{method:'POST',body:JSON.stringify(m)});
 try{const basic={fps:144,receiveHz:125,clientAgeMs:1};assert.equal((await send(basic)).status,200);assert.equal(host.clientMetrics.frameGapP95Ms,undefined);
 assert.equal((await send({...basic,frameGapP95Ms:7,frameGapMaxMs:70000,frameGapsOver50Ms:999,freshPlotFrames:10000,timingSamples:240,frameWorkP95Ms:.2,frameWorkMaxMs:1,privatePath:'SECRET'})).status,200);
 assert.equal(host.clientMetrics.frameGapMaxMs,60000);assert.equal(host.clientMetrics.frameGapsOver50Ms,239);assert.equal(host.clientMetrics.timingSamples,240);assert.ok(!JSON.stringify(host.clientMetrics).includes('SECRET'));
 for(const value of ['7',-1,null])assert.equal((await send({...basic,frameGapP95Ms:value})).status,400);
 assert.equal((await send({...basic,timingSamples:1.2})).status,400);
 assert.equal((await fetch(base+'/history')).status,403);assert.equal((await fetch(base+'/history?token='+app.token)).status,200);
 }finally{await app.close();}
});

test('explicit trigger capture reserves controls but sends no controller writes',async()=>{
 const host=new CoachHost({}),calls=[];host.c={info:{productId:0x0ce6},close(){calls.push('close');},applyLightbar(){calls.push('light');},applyTriggers(){calls.push('effect');}};host.latest={mode:'usb',lx:128,ly:128,rx:128,ry:128,l2:0,r2:0};host.lastAt=performance.now();
 await host.control('trigger_check_start');assert.equal(host.triggerCheckActive(),true);assert.equal(host.calibrationState().actions.inspect,false);
 for(const action of ['start','resume','lightbar','triggers','calibration_inspect','calibration_save','calibration_reboot'])await assert.rejects(host.control(action),/Finish or cancel/);
 assert.deepEqual(calls,[]);await host.control('trigger_check_stop');assert.equal(host.triggerCheckActive(),false);assert.equal(host.snapshot().triggerCheck.status,'cancelled');assert.deepEqual(calls,[]);
 host.status='paused';await assert.rejects(host.control('trigger_check_start'),/Finish or stop/);host.status='idle';host.calibrationRequiresRestart=true;await assert.rejects(host.control('trigger_check_start'),/restart/);
 host.calibrationRequiresRestart=false;await host.control('trigger_check_start');host.disconnect();assert.equal(host.snapshot().triggerCheck.status,'cancelled');assert.deepEqual(calls,['close']);
});

test('completed trigger observations persist locally without session identity or calibration changes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'trigger-host-'));
 try{const host=new CoachHost({root}),save=host.triggerCheck._saveReport;let done;const saved=new Promise(resolve=>{done=resolve;});host.triggerCheck._saveReport=async(...args)=>{await save(...args);done();};
 const started=performance.now();host.triggerCheck.start(started);
 for(let elapsed=20;elapsed<=15000;elapsed+=20){const t=Math.max(0,elapsed-3000),phase=t%4000,value=Math.round((phase<2000?phase:4000-phase)/2000*255);host.triggerCheck.feed({mode:'usb',l2:value,r2:value},started+elapsed);}
 await saved;await Promise.resolve();const files=await readdir(join(root,'trigger-checks'));assert.equal(files.length,1);assert.match(files[0],/\.json$/);
 const report=JSON.parse(await readFile(join(root,'trigger-checks',files[0]),'utf8'));assert.equal(report.kind,'trigger-check');assert.equal(report.analysis.quality.available,true);assert.ok(report.analysis.triggers.l2.cycles.slowSweeps>=2);assert.equal(report.controller,undefined);assert.equal(report.calibration,undefined);
 assert.equal(host.triggerCheck.snapshot().status,'complete');assert.equal(host.result,undefined);assert.equal(host.roundReports.length,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
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


test('directional assessment is cached with completed rounds and cleared on disconnect',()=>{
 const host=new CoachHost({});host.rememberRound(savedRound('directional-round'));
 const assessment=host.snapshot().measurements.tuning;
 assert.equal(assessment.available,true);assert.equal(assessment.scope,'current_check');
 assert.equal(assessment.sticks.left.center.available,false);
 assert.equal(host.snapshot().measurements.tuning,assessment);
 host.disconnect();assert.equal(host.snapshot().measurements.tuning.available,false);
 assert.equal(host.roundReports.length,0);
});
