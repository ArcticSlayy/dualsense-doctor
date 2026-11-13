import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoachServer, CoachHost, batteryFromReport } from '../coach-host.js';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { CalibrationWorkflow } from '../calibration-workflow.js';
import { compareSessionReports } from '../session-comparison.js';

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

test('a fresh check after saved trial and confirmed restart starts a compatible live series',async()=>{
  const root=await mkdtemp(join(tmpdir(),'coach-round-epoch-'));
  try{
    const workflow=new CalibrationWorkflow(root),reports=new Map();
    const baseline={...savedRound('baseline',4),calibrationActions:[]};reports.set(baseline.id,baseline);
    const store={get:id=>structuredClone(reports.get(id)),report:id=>structuredClone(reports.get(id)),save:report=>reports.set(report.id,structuredClone(report)),log(){}};
    const before={controller:{productId:0x0ce6,serialNumber:'PRIVATE-FACTORY'},words:Array(12).fill(2000),nvsStatus:'locked(temporary)'};
    const after={...before,words:Array(12).fill(2001)};let actual=before;
    const operations=[],host=new CoachHost(store,{workflow,wait:async()=>{host.lastAt=performance.now();},worker:async input=>{
      operations.push(input.operation);
      if(input.operation==='inspect')return actual;
      if(input.operation==='trial'){
        actual=after;const report=store.get(baseline.id);
        report.calibrationActions.push({kind:'temporary_center',status:'applied',at:'2026-11-13T12:00:00Z',result:{after}});store.save(report);
        return {before,after};
      }
      if(input.operation==='save')return {saveAcknowledged:true,persistenceVerified:false};
      if(input.operation==='verify')return {persistenceVerified:true,calibrationMatches:true,restartEvidence:'owner_confirmed',snapshot:after};
      throw Error('Unexpected hardware fixture operation');
    }});
    host.connect=()=>{host.c={info:{productId:0x0ce6},close(){}};host.latest={mode:'usb'};host.lastAt=performance.now();};host.connect();
    host.sessionId=baseline.id;host.result={complete:true,report:baseline};host.status='complete';host.rememberRound(baseline,0);
    await host.prepareCalibrationResult(baseline);
    await host.control('calibration_trial',{confirm:'TRY_TEMPORARY_CENTER'});
    const retest=store.get(baseline.id);retest.captures.push(...savedRound('unused',2).captures.map(c=>({...c,number:c.number+5,calibrationEpoch:1})));store.save(retest);
    host.result={complete:true,report:retest};host.status='complete';host.rememberRound(retest,5);await host.prepareCalibrationResult(retest);
    const reviewId=host.calibrationState().reviewId;
    await host.control('calibration_save',{confirm:'SAVE_REVIEWED_CALIBRATION',reviewId});
    await host.control('calibration_verify',{restartConfirmed:true});
    assert.equal(store.get(baseline.id).calibrationPersistence.status,'verified');
    assert.equal(workflow.snapshot().stage,'verified');
    const fresh=savedRound('fresh-after-restart',3);store.save(fresh);host.sessionId=fresh.id;host.result={complete:true,report:fresh};host.rememberRound(fresh,0);await host.prepareCalibrationResult(fresh);
    const view=host.snapshot().measurements;
    assert.equal(view.rounds.length,1);assert.equal(view.comparison.acceptedRounds,1);assert.equal(view.comparison.left.observedPeakPercent,3);
    assert.equal(host.snapshot().status,'complete');assert.equal(host.calibrationState().stage,'measured');
    assert.equal(view.seriesReset,true);
    host.rememberRound(savedRound('repeat-same-state',1),0);
    assert.equal(host.snapshot().measurements.comparison.acceptedRounds,2);assert.equal(host.snapshot().measurements.comparison.left.observedPeakPercent,3);
    assert.equal(host.snapshot().measurements.seriesReset,true);
    assert.equal(store.get(baseline.id).captures.length,10);assert.equal(store.get(baseline.id).calibrationActions.length,1);
    assert.deepEqual(operations,['inspect','inspect','trial','inspect','inspect','save','verify','inspect']);
    assert.equal(compareSessionReports([retest,fresh]).comparable,false,'saved evidence remains incompatible outside the live series');
    await host.control('reset_rounds');assert.equal(host.snapshot().measurements.seriesReset,false);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('live series resets for valid controller, transport and full-history changes without pooling epochs',()=>{
  for(const change of [
    r=>{r.controller={...r.controller,path:'different-private-path'};},
    r=>{r.captures.forEach(c=>{c.metrics.mode='bt';});},
    r=>{r.calibrationActions=[{at:'different-action'}];},
  ]){
    const host=new CoachHost({}),previous={...savedRound('previous',5),calibrationActions:[{at:'first-action'}]};previous.captures.forEach(c=>{c.calibrationEpoch=1;});
    const next=structuredClone(previous);next.id='new-boundary';next.captures.forEach(c=>{c.metrics.left.peakRadiusPercent=2;c.metrics.left.p99RadiusPercent=2;});change(next);
    host.rememberRound(previous);host.rememberRound(next);
    assert.equal(host.snapshot().measurements.rounds.length,1);assert.equal(host.snapshot().measurements.comparison.acceptedRounds,1);
    assert.equal(host.snapshot().measurements.comparison.left.observedPeakPercent,2);
    assert.equal(compareSessionReports([previous,next]).comparable,false);
  }
});

test('invalid rounds cannot erase valid worst evidence and latest comparison remains separately available',()=>{
  const host=new CoachHost({}),worst=savedRound('worst',8),invalid=savedRound('invalid',1);invalid.controller.path='another-private-controller';invalid.captures.at(-1).metrics.valid=false;
  host.rememberRound(worst);host.rememberRound(invalid);
  let view=host.snapshot().measurements;
  assert.equal(view.rounds.length,2);assert.equal(view.comparison.left.observedPeakPercent,8);assert.equal(view.latestComparison.comparable,false);
  host.rememberRound(savedRound('latest',2));view=host.snapshot().measurements;
  assert.equal(view.comparison.acceptedRounds,2);assert.equal(view.comparison.left.observedPeakPercent,8);
  assert.equal(view.latestComparison.acceptedRounds,1);assert.equal(view.latestComparison.left.observedPeakPercent,2);
  assert.equal(host.snapshot().measurements.latestComparison,view.latestComparison);
  assert.doesNotMatch(JSON.stringify(view),/another-private-controller|fixture|"id"|calibrationActions/);
  host.disconnect();assert.equal(host.snapshot().measurements.latestComparison.acceptedRounds,0);assert.equal(host.snapshot().measurements.seriesReset,false);
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
