import test from 'node:test';
import assert from 'node:assert/strict';
import { CoachHost } from '../coach-host.js';

const sessionId='12345678-1234-4234-8234-123456789abc';
const candidate={expectedController:{productId:0x0ce6,serialNumber:'FACTORY'},expectedWords:Array(12).fill(321)};
const factorySnapshot={controller:candidate.expectedController,words:candidate.expectedWords,nvsStatus:'locked(temporary)'};
const report={id:sessionId,complete:true,captures:[]};
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture({stage='measured',trialSession=null,worker,wait,needsRestart=false,enableCalibration=true}={}) {
  const events=[],inputs=[];let pendingTrial=false,pendingSave=false;
  const state={stage,reviewId:stage==='ready_to_save'?'review-1':null,message:'Calibration evidence ready.',persistenceVerified:false};
  const workflow={
    snapshot:()=>({...state}),needsRestart:()=>needsRestart,getTrialSessionId:()=>trialSession,
    verificationCandidate:()=>{if(!['save_acknowledged','ambiguous','verified'].includes(state.stage))throw Error('No saved candidate.');return candidate;},
    inspect:s=>{events.push('workflow:inspect');assert.deepEqual(s,factorySnapshot);},
    measured:(r,s)=>{events.push('workflow:measured');assert.equal(r,report);assert.deepEqual(s,factorySnapshot);state.stage='measured';},
    beginTrial:({sessionId:id,baselineReport,snapshot})=>{events.push('workflow:beginTrial');assert.equal(id,sessionId);assert.equal(baselineReport,report);assert.deepEqual(snapshot,factorySnapshot);pendingTrial=true;return candidate;},
    recordTrial:result=>{events.push('workflow:recordTrial');assert.equal(result.sessionId,sessionId);assert.equal(pendingTrial,true);trialSession=sessionId;state.stage='trial_applied';},
    markTrialUncertain:()=>{events.push('workflow:uncertain');state.stage='ambiguous';trialSession=sessionId;},
    prepare:(r,s)=>{events.push('workflow:prepare');assert.equal(r,report);assert.deepEqual(s,factorySnapshot);state.stage='ready_to_save';state.reviewId='review-1';},
    beginSave:({reviewId,report:r,snapshot})=>{events.push('workflow:beginSave');assert.equal(r,report);assert.deepEqual(snapshot,factorySnapshot);if(reviewId!=='review-1')throw Error('Current review ID required.');pendingSave=true;return candidate;},
    finishSave:result=>{events.push('workflow:finishSave');assert.equal(pendingSave,true);state.stage=result.saveAcknowledged?'save_acknowledged':'ambiguous';state.persistenceVerified=false;},
    finishVerification:(result,snapshot)=>{events.push('workflow:finishVerification');assert.deepEqual(snapshot,factorySnapshot);state.stage=result.persistenceVerified?'verified':'mismatch';state.persistenceVerified=result.persistenceVerified;},
    abandonTrial:()=>{events.push('workflow:abandonTrial');trialSession=null;state.stage='unknown';},
    resolveInterruptedTrial:(s,confirmed)=>{assert.equal(confirmed,true);workflow.inspect(s);workflow.abandonTrial();},
  };
  let host;
  const fakeWorker=async input=>{
    assert.equal(host.c,null,'live HID must be closed before worker dispatch');
    inputs.push(input);events.push('worker:'+input.operation);
    if(input.operation==='trial')assert.equal(pendingTrial,true,'trial intent must precede the write worker');
    if(input.operation==='save')assert.equal(pendingSave,true,'pending save receipt must precede the write worker');
    if(worker)return worker(input,{host,events,state});
    if(input.operation==='inspect')return factorySnapshot;
    if(input.operation==='trial')return {before:factorySnapshot,after:factorySnapshot,temporaryApplied:true,permanentSaved:false};
    if(input.operation==='save')return {status:'save_acknowledged',saveAcknowledged:true,persistenceVerified:false};
    if(input.operation==='verify')return {persistenceVerified:true,snapshot:factorySnapshot};
    return {status:'reboot_command_sent',rebootObserved:false,persistenceVerified:false};
  };
  host=new CoachHost({report:id=>{assert.equal(id,sessionId);return report;}},{workflow,worker:fakeWorker,enableCalibration,wait:async ms=>{
    events.push('wait:'+ms);if(wait)await wait(ms,host);host.lastAt=performance.now();
  }});
  host.connect=()=>{assert.equal(host.c,null);events.push('connect');host.c={info:{productId:0x0ce6},close:()=>events.push('close')};host.latest={mode:'usb',lx:128,ly:128,rx:128,ry:128};host.lastAt=performance.now();};
  host.connect();host.calibrationInspectionPending=false;events.length=0;host.sessionId=sessionId;host.result={complete:true,report};host.status='complete';
  return {host,workflow,state,events,inputs};
}

test('calibration capabilities and explicit confirmations reject unavailable writes',async()=>{
  const f=fixture();
  for(const [action,input] of [['calibration_trial',{}],['calibration_reboot',{}],['calibration_save',{confirm:'SAVE_REVIEWED_CALIBRATION',reviewId:'review-1'}],['calibration_verify',{restartConfirmed:true}]])await assert.rejects(f.host.control(action,input));
  assert.deepEqual(f.inputs,[]);assert.deepEqual(f.events,[]);
  for(const configure of [h=>{h.latest.mode='bt';},h=>{h.c.info.productId=0x0df2;},h=>{h.lastAt=performance.now()-1000;},h=>{h.status='paused';},h=>{h.calibrationRequiresRestart=true;}]) {
    const g=fixture();configure(g.host);assert.equal(g.host.calibrationState().actions.trial,false);await assert.rejects(g.host.control('calibration_trial',{confirm:'TRY_TEMPORARY_CENTER'}));assert.deepEqual(g.inputs,[]);
  }
  const disabled=fixture({enableCalibration:false});assert.equal(disabled.host.calibrationState().actions.inspect,false);await assert.rejects(disabled.host.control('calibration_inspect'));
});

test('a worker operation excludes every other control and restores live ownership afterward',async()=>{
  const gate=deferred();const f=fixture({worker:()=>gate.promise});
  const operation=f.host.control('calibration_inspect');
  assert.deepEqual(f.events,['close','worker:inspect']);assert.equal(f.host.calibrationState().busy,true);
  for(const action of ['connect','disconnect','lightbar','triggers','start','reset_rounds','pause','resume','stop','calibration_inspect','calibration_trial'])await assert.rejects(f.host.control(action),/operation.*progress/i);
  gate.resolve(factorySnapshot);await operation;
  assert.deepEqual(f.events,['close','worker:inspect','workflow:inspect','workflow:measured','connect']);assert.ok(f.host.c);assert.equal(f.host.calibrationState().busy,false);
});

test('temporary trial awaits three seconds then records intent before exact candidate dispatch',async()=>{
  const gate=deferred();const f=fixture({wait:ms=>{assert.equal(ms,3000);return gate.promise;}});
  const action=f.host.control('calibration_trial',{confirm:'TRY_TEMPORARY_CENTER'});
  assert.deepEqual(f.events,['wait:3000']);assert.ok(f.host.c);assert.deepEqual(f.inputs,[]);
  assert.equal(f.host.calibrationState().operation,'trial');
  gate.resolve();await action;
  assert.deepEqual(f.events,['wait:3000','close','worker:inspect','workflow:beginTrial','worker:trial','workflow:recordTrial','connect']);
  assert.deepEqual(f.inputs[1],{operation:'trial',sessionId,confirm:'TRY_TEMPORARY_CENTER',countdownConfirmed:true,...candidate});
  assert.equal(f.host.result,null);assert.equal(f.host.calibrationState().actions.retest,true);
});

test('failed trial marks uncertainty, requires restart and restores handle without retry',async()=>{
  const f=fixture({worker:input=>{if(input.operation==='trial')throw Error('transport lost');return factorySnapshot;}});
  await assert.rejects(f.host.control('calibration_trial',{confirm:'TRY_TEMPORARY_CENTER'}),/transport lost/);
  assert.equal(f.host.calibrationRequiresRestart,true);assert.equal(f.state.stage,'ambiguous');assert.equal(f.host.result,null);assert.ok(f.host.c);
  assert.deepEqual(f.inputs.map(i=>i.operation),['inspect','trial']);assert.ok(f.events.indexOf('workflow:uncertain')>f.events.indexOf('worker:trial'));
  assert.equal(f.host.calibrationState().actions.trial,false);assert.equal(f.host.calibrationState().actions.retest,false);assert.equal(f.host.calibrationOperation,null);
});

test('save requires current review ID and creates pending receipt before write worker',async()=>{
  const f=fixture({stage:'ready_to_save',trialSession:sessionId});
  await assert.rejects(f.host.control('calibration_save',{confirm:'SAVE_REVIEWED_CALIBRATION'}),/review ID/);
  assert.deepEqual(f.inputs.map(i=>i.operation),['inspect']);assert.ok(f.host.c);
  f.events.length=0;f.inputs.length=0;
  await f.host.control('calibration_save',{confirm:'SAVE_REVIEWED_CALIBRATION',reviewId:'review-1'});
  assert.deepEqual(f.events,['close','worker:inspect','workflow:beginSave','worker:save','workflow:finishSave','connect']);
  assert.deepEqual(f.inputs[1],{operation:'save',confirm:'SAVE_REVIEWED_CALIBRATION',...candidate});assert.equal(f.state.stage,'save_acknowledged');assert.equal(f.state.persistenceVerified,false);
});

test('save process failure and structured ambiguity both retain uncertain save outcome',async()=>{
  for(const throws of [true,false]) {
    const f=fixture({stage:'ready_to_save',trialSession:sessionId,worker:input=>{
      if(input.operation==='inspect')return factorySnapshot;
      if(throws)throw Object.assign(Error('worker exited'),{outcomeUnknown:true});
      return {status:'ambiguous',saveAcknowledged:false,persistenceVerified:false};
    }});
    const action=f.host.control('calibration_save',{confirm:'SAVE_REVIEWED_CALIBRATION',reviewId:'review-1'});
    if(throws)await assert.rejects(action,/worker exited/);else await action;
    assert.equal(f.state.stage,'ambiguous');assert.equal(f.state.persistenceVerified,false);assert.ok(f.host.c);assert.deepEqual(f.inputs.map(i=>i.operation),['inspect','save']);assert.equal(f.events.filter(e=>e==='workflow:finishSave').length,1);
  }
});

test('reboot requires unsaved-discard confirmation and never verifies persistence automatically',async()=>{
  const f=fixture({stage:'ready_to_save',trialSession:sessionId});
  await assert.rejects(f.host.control('calibration_reboot',{confirm:'REBOOT_CONTROLLER'}),/discard/);assert.deepEqual(f.inputs,[]);
  await f.host.control('calibration_reboot',{confirm:'REBOOT_CONTROLLER',discardUnsaved:true});
  assert.deepEqual(f.inputs,[{operation:'reboot',confirm:'REBOOT_CONTROLLER'}]);assert.equal(f.host.c,null);assert.equal(f.state.persistenceVerified,false);assert.ok(f.events.includes('workflow:abandonTrial'));assert.ok(!f.events.includes('workflow:finishVerification'));
  const g=fixture({stage:'save_acknowledged'});await g.host.control('calibration_reboot',{confirm:'REBOOT_CONTROLLER'});assert.deepEqual(g.inputs.map(i=>i.operation),['reboot']);assert.equal(g.state.stage,'save_acknowledged');assert.equal(g.state.persistenceVerified,false);
});

test('persistence verification requires owner restart confirmation and uses recorded candidate',async()=>{
  const f=fixture({stage:'save_acknowledged'});
  await assert.rejects(f.host.control('calibration_verify',{restartConfirmed:false}),/actually restarted/);assert.deepEqual(f.inputs,[]);
  await f.host.control('calibration_verify',{restartConfirmed:true});
  assert.deepEqual(f.inputs,[{operation:'verify',...candidate,restartConfirmed:true}]);assert.deepEqual(f.events,['close','worker:verify','workflow:finishVerification','connect']);assert.equal(f.state.persistenceVerified,true);
});

test('ambiguous reboot remains unverified; confirmed restart clears uncertain trial through read-only inspection',async()=>{
  const reboot=fixture({stage:'save_acknowledged',worker:()=>({status:'ambiguous',outcomeUnknown:true,rebootObserved:false,persistenceVerified:false})});
  await reboot.host.control('calibration_reboot',{confirm:'REBOOT_CONTROLLER'});
  assert.deepEqual(reboot.inputs.map(i=>i.operation),['reboot']);assert.equal(reboot.state.persistenceVerified,false);assert.match(reboot.host.instruction,/uncertain/);assert.equal(reboot.host.c,null);
  const trial=fixture({stage:'ambiguous',trialSession:sessionId,needsRestart:true});
  await assert.rejects(trial.host.control('calibration_verify',{}));assert.deepEqual(trial.inputs,[]);
  await trial.host.control('calibration_verify',{restartConfirmed:true});
  assert.deepEqual(trial.inputs,[{operation:'inspect'}]);assert.deepEqual(trial.events,['close','worker:inspect','workflow:inspect','workflow:abandonTrial','connect']);assert.equal(trial.host.calibrationRequiresRestart,false);assert.equal(trial.state.persistenceVerified,false);assert.equal(trial.host.result,null);
});

test('post-measurement review dispatches only read-only inspection for baseline and trial',async()=>{
  for(const trialSession of [null,sessionId]) {
    const f=fixture({stage:trialSession?'trial_applied':'unknown',trialSession});
    await f.host.prepareCalibrationResult(report);
    assert.deepEqual(f.inputs,[{operation:'inspect'}]);assert.deepEqual(f.events,['close','worker:inspect',trialSession?'workflow:prepare':'workflow:measured','connect']);assert.ok(f.host.c);assert.equal(f.state.persistenceVerified,false);
  }
});

test('failed read-only review restores live input and does not manufacture reviewed evidence',async()=>{
  const f=fixture({stage:'unknown',worker:()=>{throw Error('read failed');}});
  await f.host.prepareCalibrationResult(report);
  assert.deepEqual(f.inputs,[{operation:'inspect'}]);assert.deepEqual(f.events,['close','worker:inspect','connect']);assert.equal(f.state.stage,'unknown');assert.match(f.host.warning,/read failed/);assert.ok(f.host.c);assert.equal(f.host.calibrationOperation,null);
});

test('reconnection hides previous controller verification until an explicit inspection',async()=>{
  const f=fixture({stage:'verified'});f.state.lastSavedAt='2026-01-01T00:00:00.000Z';f.state.verifiedAt='2026-01-02T00:00:00.000Z';
  f.state.diagnostics={available:true,sticks:{left:{rows:[{id:'quiet_peak',after:2}]}}};
  assert.equal(f.host.calibrationState().stage,'verified');
  f.host.disconnect();f.host.connect();f.host.c.info.path='another-controller';
  const view=f.host.calibrationState();assert.equal(view.stage,'unknown');assert.equal(view.lastSavedAt,null);assert.equal(view.verifiedAt,null);assert.equal(view.inspectionNeeded,true);
  assert.equal(view.diagnostics,null);
  assert.equal(view.actions.save,false);assert.equal(view.actions.verify,false);assert.equal(view.actions.inspect,true);
  assert.equal(f.inputs.length,0,'reconnection must not send commands');
});

test('a completed baseline cannot be reused for a trial after disconnecting',async()=>{
  const f=fixture();assert.equal(f.host.calibrationState().actions.trial,true);
  f.host.disconnect();f.host.connect();await f.host.control('calibration_inspect');
  assert.equal(f.host.result,null);assert.equal(f.host.calibrationState().actions.trial,false);
  assert.deepEqual(f.inputs.map(i=>i.operation),['inspect']);assert.ok(!f.events.includes('workflow:measured'));
});

test('interrupted trial keeps its restart requirement but hides old-controller diagnostics after reconnection',async()=>{
  const f=fixture({stage:'ambiguous',trialSession:sessionId,needsRestart:true});
  f.state.comparison={before:{left:{observedPeakPercent:4}},after:null};
  f.state.diagnostics={available:true,sticks:{left:{rows:[{id:'quiet_peak',before:4,after:null}]}}};
  f.state.lastSavedAt='2026-01-01T00:00:00.000Z';
  f.host.disconnect();f.host.connect();f.host.c.info.path='another-controller';
  const view=f.host.calibrationState();assert.equal(view.stage,'ambiguous');assert.equal(view.inspectionNeeded,true);
  assert.equal(f.host.calibrationRequiresRestart,true);assert.match(view.blockedReason,/Restart/);
  assert.equal(view.comparison,null);assert.equal(view.diagnostics,null);assert.equal(view.lastSavedAt,null);
  assert.equal(view.actions.trial,false);assert.equal(view.actions.save,false);assert.deepEqual(f.inputs,[]);
});
