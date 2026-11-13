import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../guided.js';
import { CalibrationWorkflow } from '../calibration-workflow.js';
import { CoachHost } from '../coach-host.js';

const identity={productId:0x0ce6,serialNumber:'factory-private'};
const originalWords=Array.from({length:12},(_,i)=>4200+i);
const adjustedWords=originalWords.map(n=>n+1);
function snapshot(words){return {controller:{...identity},words:[...words],nvsStatus:'locked(temporary)'};}
function captures(epoch,peak) {
  return ['rest','range','release','buttons','verify'].map((phase,i)=>{
    const quiet={valid:true,peakRadiusPercent:peak,p99RadiusPercent:peak-.5,deadzonePercent:Math.ceil(peak+1),offsetRaw:1,jitterRaw:.2};
    const side=phase==='range'?{valid:true,circularity:{coveredSectors:48,totalSectors:48,errorPercent:7,maxOppositeDifferencePercent:2}}:phase==='release'?{valid:true,postReturnPeakPercent:20}:quiet;
    return {number:epoch*5+i+1,phase,calibrationEpoch:epoch,at:new Date(1804982400000+(epoch*5+i)*1000).toISOString(),metrics:{valid:true,mode:'usb',samples:1000,durationMs:5000,maxGapMs:4,left:structuredClone(side),right:structuredClone(side)}};
  });
}
function setup(t,{failTrial=false}={}) {
  const root=mkdtempSync(join(tmpdir(),'calibration-lifecycle-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=new SessionStore(join(root,'sessions'));
  const session=store.start({productId:0x0ce6,path:'private-hid-path',serialNumber:null});
  const saved=store.get(session.id);saved.captures=captures(0,3);store.save(saved);
  const history=join(root,'history');let now=1804982400000,words=[...originalWords],host;
  const workflow=new CalibrationWorkflow(history,{clock:()=>now}),operations=[],mutations=[];
  const worker=async input=>{
    assert.equal(host.c,null,'live owner must release HID before every isolated operation');operations.push(structuredClone(input));
    if(input.operation==='inspect')return snapshot(words);
    assert.deepEqual(input.expectedController,identity);
    assert.deepEqual(input.expectedWords,words);
    if(input.operation==='trial') {
      assert.equal(input.sessionId,session.id);assert.equal(input.confirm,'TRY_TEMPORARY_CENTER');assert.equal(input.countdownConfirmed,true);
      assert.equal(new CalibrationWorkflow(history).needsRestart(),true,'trial intent must already be on disk');
      mutations.push('temporary_center');if(failTrial)throw Object.assign(Error('simulated write transport failure'),{outcomeUnknown:true});
      const before=snapshot(words);words=[...adjustedWords];const after=snapshot(words);
      const s=store.get(session.id);(s.calibrationActions??=[]).push({kind:'temporary_center',status:'applied',at:new Date(now).toISOString(),permanentSaved:false,result:{before,after}});store.save(s);
      return {before,after,temporaryApplied:true,permanentSaved:false,sessionId:session.id};
    }
    if(input.operation==='save') {
      assert.equal(input.confirm,'SAVE_REVIEWED_CALIBRATION');
      const persisted=new CalibrationWorkflow(history);assert.equal(persisted.snapshot().stage,'ambiguous','pending save receipt must exist before hardware write');
      assert.deepEqual(persisted.verificationCandidate(),{expectedController:identity,expectedWords:adjustedWords});
      mutations.push('save');return {status:'save_acknowledged',saveAcknowledged:true,persistenceVerified:false};
    }
    assert.equal(input.operation,'verify');assert.equal(input.restartConfirmed,true);
    return {status:'verified_after_owner_confirmed_restart',persistenceVerified:true,calibrationMatches:true,restartEvidence:'owner_confirmed',restartAutomaticallyDetected:false,snapshot:snapshot(words)};
  };
  host=new CoachHost(store,{workflow,worker,wait:async ms=>{assert.equal(ms,3000);host.lastAt=performance.now();}});
  host.connect=()=>{assert.equal(host.c,null);host.c={info:{productId:0x0ce6},close(){}};host.latest={mode:'usb'};host.lastAt=performance.now();};
  host.connect();host.sessionId=session.id;host.status='complete';host.result={complete:true,report:store.report(session.id)};
  const prepareBaseline=async()=>{await host.prepareCalibrationResult(store.report(session.id));assert.equal(host.calibrationState().stage,'measured');};
  const trial=async()=>{await prepareBaseline();await host.control('calibration_trial',{confirm:'TRY_TEMPORARY_CENTER'});assert.equal(host.calibrationState().stage,'trial_applied');};
  const prepareRetest=async()=>{
    await trial();const s=store.get(session.id);s.captures.push(...captures(1,2));store.save(s);
    const post=store.report(session.id);assert.equal(post.complete,true);host.result={complete:true,report:post};host.status='complete';
    await host.prepareCalibrationResult(post);assert.equal(host.calibrationState().stage,'ready_to_save');return host.calibrationState().reviewId;
  };
  return {host,store,workflow,history,sessionId:session.id,operations,mutations,prepareBaseline,prepareRetest,advance:ms=>{now+=ms;},clock:()=>now};
}
function assertPublicState(state,sessionId) {
  const text=JSON.stringify(state);
  for(const privateValue of ['factory-private','private-hid-path',sessionId])assert.equal(text.includes(privateValue),false);
  for(const forbidden of ['"expectedWords"','"words"','"expectedController"','"controller"','"serialNumber"','"sessionId"'])assert.equal(text.includes(forbidden),false);
}

test('actual host, workflow and session store complete measured trial, review, save and restart verification',async t=>{
  const f=setup(t);const reviewId=await f.prepareRetest();assert.ok(reviewId);
  assert.deepEqual(f.operations.map(o=>o.operation),['inspect','inspect','trial','inspect']);assert.deepEqual(f.mutations,['temporary_center']);
  assert.equal(f.workflow.snapshot().comparison.before.left.observedPeakPercent,3);assert.equal(f.workflow.snapshot().comparison.after.left.observedPeakPercent,2);
  assertPublicState(f.host.calibrationState(),f.sessionId);
  const trialActions=f.store.get(f.sessionId).calibrationActions;assert.equal(trialActions.length,1);assert.deepEqual(trialActions[0].result.after.words,adjustedWords);
  await f.host.control('calibration_save',{confirm:'SAVE_REVIEWED_CALIBRATION',reviewId});
  const acknowledged=f.host.calibrationState();assert.equal(acknowledged.stage,'save_acknowledged');assert.equal(acknowledged.lastSavedAt,new Date(f.clock()).toISOString());assert.equal(acknowledged.verifiedAt,null);assert.equal(acknowledged.firmwareSaveTimestamp,null);
  assert.match(f.store.report(f.sessionId).recommendation.note,/save acknowledged; persistence after restart has not been verified/);
  assert.deepEqual(f.mutations,['temporary_center','save']);assertPublicState(acknowledged,f.sessionId);
  await assert.rejects(f.host.control('calibration_verify',{}),/restart/i);assert.equal(f.operations.at(-1).operation,'save');
  f.advance(1000);await f.host.control('calibration_verify',{restartConfirmed:true});
  const verified=f.host.calibrationState();assert.equal(verified.stage,'verified');assert.equal(verified.verifiedAt,new Date(f.clock()).toISOString());assert.equal(verified.lastSavedAt,acknowledged.lastSavedAt);assert.equal(verified.historySource,'this_app');assert.equal(verified.firmwareSaveTimestamp,null);
  assert.match(f.store.report(f.sessionId).recommendation.note,/persistence verified/);
  assert.deepEqual(f.operations.map(o=>o.operation),['inspect','inspect','trial','inspect','inspect','save','verify']);assert.deepEqual(f.mutations,['temporary_center','save']);assertPublicState(verified,f.sessionId);
  const reopened=new CalibrationWorkflow(f.history);reopened.inspect(snapshot(adjustedWords));assert.equal(reopened.snapshot().stage,'verified');assert.equal(reopened.snapshot().verifiedAt,verified.verifiedAt);
});

test('actual workflow rejects stale reviewed evidence before the save worker can run',async t=>{
  const f=setup(t),reviewId=await f.prepareRetest();
  const changed=f.store.get(f.sessionId);changed.captures.at(-1).metrics.left.peakRadiusPercent=4;f.store.save(changed);
  await assert.rejects(f.host.control('calibration_save',{confirm:'SAVE_REVIEWED_CALIBRATION',reviewId}),/evidence changed/i);
  assert.equal(f.operations.at(-1).operation,'inspect');assert.equal(f.operations.some(o=>o.operation==='save'),false);assert.deepEqual(f.mutations,['temporary_center']);assert.equal(f.workflow.snapshot().lastSavedAt,null);assert.notEqual(f.workflow.snapshot().stage,'ready_to_save');assert.ok(f.host.c);
});

test('failed trial leaves durable restart requirement across workflow and host reconstruction',async t=>{
  const f=setup(t,{failTrial:true});await f.prepareBaseline();
  await assert.rejects(f.host.control('calibration_trial',{confirm:'TRY_TEMPORARY_CENTER'}),/transport failure/);
  assert.equal(f.host.calibrationRequiresRestart,true);assert.equal(f.workflow.needsRestart(),true);assert.deepEqual(f.mutations,['temporary_center']);
  const reopened=new CalibrationWorkflow(f.history);assert.equal(reopened.needsRestart(),true);assert.equal(reopened.snapshot().stage,'ambiguous');
  const host=new CoachHost(f.store,{workflow:reopened,worker:()=>{throw Error('No retry worker may run.');},wait:async()=>{throw Error('No countdown may run.');}});
  assert.equal(host.calibrationRequiresRestart,true);assert.equal(host.calibrationState().actions.trial,false);assert.equal(host.calibrationState().actions.save,false);
  await assert.rejects(host.control('calibration_trial',{confirm:'TRY_TEMPORARY_CENTER'}));assertPublicState(host.calibrationState(),f.sessionId);
});
