import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CalibrationWorkflow } from '../calibration-workflow.js';

const words = Array.from({length:12}, (_,i)=>2000+i);
const controller = {productId:0x0ce6,serialNumber:'factory-private'};
const snap = (offset=0, serial=controller.serialNumber) => ({controller:{...controller,serialNumber:serial},words:words.map(n=>n+offset),nvsStatus:'locked(temporary)'});
function report({epoch=0,peak=3}={}) {
  const captures=['rest','range','release','buttons','verify'].map((phase,i)=>({number:i+1+epoch*5,phase,calibrationEpoch:epoch,
    at:`2026-11-13T00:00:${String(i+epoch*5).padStart(2,'0')}Z`,metrics:{valid:true,mode:'usb',samples:1000,durationMs:5000,maxGapMs:4,
      left:{valid:true,peakRadiusPercent:peak,p99RadiusPercent:peak-.5},right:{valid:true,peakRadiusPercent:peak,p99RadiusPercent:peak-.5}}}));
  for(const side of ['left','right']) {
    captures[1].metrics[side]={valid:true,circularity:{coveredSectors:48,totalSectors:48,errorPercent:7,maxOppositeDifferencePercent:2}};
    captures[2].metrics[side]={valid:true,postReturnPeakPercent:20};
  }
  return {id:'session-one',complete:true,controller:{productId:0x0ce6,path:'private-path',serialNumber:'enumeration-id'},captures,
    calibrationActions:epoch?[{kind:'temporary_center',status:'applied',at:'2026-11-13T00:00:05Z',result:{after:{words:snap(1).words}}}]:[]};
}
function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'calibration-workflow-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let now=1804982400000;
  const flow=new CalibrationWorkflow(dir,{clock:()=>now});
  const baseline=report(),after=report({epoch:1,peak:2});
  let trials=0;
  const trial=()=>{
    if(trials++) {baseline.id=`session-one-${trials}`;after.id=baseline.id;}
    flow.measured(baseline,snap());flow.beginTrial({sessionId:baseline.id,baselineReport:baseline,snapshot:snap()});
    return flow.recordTrial({sessionId:baseline.id,before:snap(),after:snap(1),baselineReport:baseline});
  };
  const ready=()=>{trial();return flow.prepare(after,snap(1));};
  return {dir,flow,baseline,after,trial,ready,advance:n=>now+=n,clock:()=>now};
}

test('locked mode alone cannot fabricate saved or unsaved history',t=>{
  const {flow}=setup(t);assert.equal(flow.inspect(snap()).stage,'unknown');
  assert.equal(flow.snapshot().lastSavedAt,null);assert.equal(flow.snapshot().firmwareSaveTimestamp,null);
});

test('complete new-epoch retest produces exact private save candidate and sanitized comparison',t=>{
  const {flow,after,ready}=setup(t);const state=ready();assert.equal(state.stage,'ready_to_save');
  assert.equal(state.comparison.before.left.observedPeakPercent,3);assert.equal(state.comparison.after.left.observedPeakPercent,2);
  assert.equal(state.comparison.after.left.suggestedDeadzonePercent,3);
  const candidate=flow.assertSave({reviewId:state.reviewId,report:after,snapshot:snap(1)});
  assert.deepEqual(candidate.expectedWords,snap(1).words);assert.deepEqual(candidate.expectedController,controller);
  assert.doesNotMatch(JSON.stringify(state),/factory-private|private-path|enumeration-id|2001|session-one/);
});

test('new valid quiet peaks remain in comparison instead of being cherry-picked',t=>{
  const {flow,after,trial}=setup(t);trial();const extra=structuredClone(after.captures[0]);extra.number=11;
  extra.metrics.left.peakRadiusPercent=8;after.captures.at(-1).number=12;after.captures.push(extra);
  assert.equal(flow.prepare(after,snap(1)).comparison.after.left.suggestedDeadzonePercent,9);
});

test('changed report evidence, epoch, controller, words or expired review refuses save',t=>{
  for(const corrupt of [r=>r.captures[0].metrics.left.peakRadiusPercent=4,r=>r.calibrationActions.push({...r.calibrationActions[0]}),r=>r.captures[0].at='later']) {
    const {flow,after,ready}=setup(t);const state=ready();corrupt(after);
    assert.throws(()=>flow.assertSave({reviewId:state.reviewId,report:after,snapshot:snap(1)}));
    assert.notEqual(flow.snapshot().stage,'ready_to_save');
  }
  for(const snapshot of [snap(2),snap(1,'another-factory')]) {
    const {flow,after,ready}=setup(t);const state=ready();
    assert.throws(()=>flow.assertSave({reviewId:state.reviewId,report:after,snapshot}));
  }
  const {flow,after,ready,advance}=setup(t);const state=ready();advance(600001);
  assert.throws(()=>flow.assertSave({reviewId:state.reviewId,report:after,snapshot:snap(1)}));
});

test('incomplete, old, mismatched or non-final trial evidence never prepares a save',t=>{
  for(const corrupt of [r=>r.complete=false,r=>r.captures[0].calibrationEpoch=0,r=>r.captures[0].number=1,
    r=>r.calibrationActions[0].status='failed',r=>r.calibrationActions[0].result.after.words[0]++,r=>r.captures.push({...structuredClone(r.captures[0]),number:11})]) {
    const {flow,after,trial}=setup(t);trial();corrupt(after);assert.throws(()=>flow.prepare(after,snap(1)));
    assert.notEqual(flow.snapshot().stage,'ready_to_save');
  }
});

test('trial retains the baseline report identity and requires USB post-trial measurement',t=>{
  for(const corrupt of [r=>r.controller.serialNumber='other-enumeration',r=>r.captures.forEach(c=>c.metrics.mode='bt')]) {
    const {flow,after,trial}=setup(t);trial();corrupt(after);assert.throws(()=>flow.prepare(after,snap(1)));
  }
});

test('private resume getters retain trial session and recorded candidate without exposing them in snapshot',t=>{
  const {dir,flow,after,ready}=setup(t);const state=ready();
  assert.equal(flow.getTrialSessionId(),'session-one');
  flow.beginSave({reviewId:state.reviewId,report:after,snapshot:snap(1)});
  const reopened=new CalibrationWorkflow(dir);assert.equal(reopened.getTrialSessionId(),null);
  assert.deepEqual(reopened.verificationCandidate().expectedWords,snap(1).words);
  assert.deepEqual(reopened.verificationCandidate(snap(1)).expectedController,controller);
  assert.throws(()=>reopened.verificationCandidate(snap(2)));
});

test('a restarted host retains the trial but requires a fresh explicit review',t=>{
  const {dir,after,ready}=setup(t);const state=ready();const reopened=new CalibrationWorkflow(dir);
  assert.equal(reopened.getTrialSessionId(),'session-one');assert.equal(reopened.inspect(snap(1)).stage,'trial_applied');
  assert.throws(()=>reopened.assertSave({reviewId:state.reviewId,report:after,snapshot:snap(1)}));
  assert.equal(reopened.prepare(after,snap(1)).stage,'ready_to_save');
});

test('a valid baseline can be recorded as measured without inventing a trial or receipt',t=>{
  const {flow,baseline}=setup(t);assert.equal(flow.measured(baseline,snap()).stage,'measured');
  assert.equal(flow.getTrialSessionId(),null);assert.equal(flow.snapshot().lastSavedAt,null);
  assert.throws(()=>flow.verificationCandidate());
});

test('save acknowledgement and owner-confirmed restart verification are separate local receipts',t=>{
  const {dir,flow,after,ready,advance,clock}=setup(t);const state=ready();
  flow.beginSave({reviewId:state.reviewId,report:after,snapshot:snap(1)});
  assert.equal(flow.snapshot().stage,'ambiguous');
  const restartedPending=new CalibrationWorkflow(dir);assert.equal(restartedPending.inspect(snap(1)).stage,'ambiguous');
  flow.finishSave({saveAcknowledged:true,persistenceVerified:false});
  const savedAt=new Date(clock()).toISOString();assert.equal(flow.snapshot().stage,'save_acknowledged');
  assert.equal(flow.snapshot().lastSavedAt,savedAt);assert.equal(flow.snapshot().verifiedAt,null);
  advance(1000);flow.finishVerification({persistenceVerified:true,calibrationMatches:true,restartEvidence:'owner_confirmed'},snap(1));
  assert.equal(flow.snapshot().stage,'verified');assert.equal(flow.snapshot().verifiedAt,new Date(clock()).toISOString());
  const reopened=new CalibrationWorkflow(dir);assert.equal(reopened.inspect(snap(1)).stage,'verified');
  assert.equal(reopened.snapshot().lastSavedAt,savedAt);
  assert.equal(reopened.inspect(snap(1,'other-controller')).lastSavedAt,null);
  assert.equal(reopened.inspect(snap(1)).stage,'verified');
});

test('ambiguous or malformed save outcomes never acquire acknowledgement timestamps or auto-retry approval',t=>{
  for(const result of [{saveAcknowledged:false,persistenceVerified:false},{saveAcknowledged:true,persistenceVerified:true},{}]) {
    const {flow,after,ready}=setup(t);const state=ready();flow.beginSave({reviewId:state.reviewId,report:after,snapshot:snap(1)});
    flow.finishSave(result);assert.equal(flow.snapshot().stage,'ambiguous');assert.equal(flow.snapshot().lastSavedAt,null);
    assert.throws(()=>flow.assertSave({reviewId:state.reviewId,report:after,snapshot:snap(1)}));
  }
});

test('restart verification requires explicit owner evidence and matching factory identity and words',t=>{
  for(const [result,snapshot] of [[{persistenceVerified:true,calibrationMatches:true},snap(1)],
    [{persistenceVerified:true,calibrationMatches:true,restartEvidence:'owner_confirmed'},snap(2)],
    [{persistenceVerified:true,calibrationMatches:true,restartEvidence:'owner_confirmed'},snap(1,'other-controller')]]) {
    const {flow,after,ready}=setup(t);const state=ready();flow.beginSave({reviewId:state.reviewId,report:after,snapshot:snap(1)});
    flow.finishSave({saveAcknowledged:true,persistenceVerified:false});
    assert.throws(()=>flow.finishVerification(result,snapshot));assert.equal(flow.snapshot().verifiedAt,null);
  }
});

test('invalidation retains local receipts but removes approval and changed words remain changed',t=>{
  const {flow,after,ready}=setup(t);const state=ready();flow.beginSave({reviewId:state.reviewId,report:after,snapshot:snap(1)});
  flow.finishSave({saveAcknowledged:true,persistenceVerified:false});flow.invalidate();
  assert.equal(flow.inspect(snap(1)).stage,'save_acknowledged');assert.ok(flow.snapshot().lastSavedAt);
  assert.equal(flow.inspect(snap()).stage,'changed');assert.equal(flow.snapshot().reviewId,null);
});

test('a later uncertain attempt retains the earlier local acknowledged-save date',t=>{
  const {dir,flow,after,ready,clock,advance}=setup(t);let state=ready();
  flow.beginSave({reviewId:state.reviewId,report:after,snapshot:snap(1)});flow.finishSave({saveAcknowledged:true,persistenceVerified:false});
  const lastSavedAt=new Date(clock()).toISOString();advance(1000);state=ready();
  flow.beginSave({reviewId:state.reviewId,report:after,snapshot:snap(1)});flow.finishSave({saveAcknowledged:false,persistenceVerified:false});
  assert.equal(flow.snapshot().lastSavedAt,lastSavedAt);assert.equal(flow.snapshot().stage,'ambiguous');
  assert.equal(new CalibrationWorkflow(dir).inspect(snap(1)).lastSavedAt,lastSavedAt);
});

test('journal failure blocks hardware preconditions and corrupt journal fails closed without overwrite',t=>{
  const {dir,flow,after,ready}=setup(t);const state=ready();const file=readdirSync(dir).find(n=>n.endsWith('.json'));
  rmSync(join(dir,file));mkdirSync(join(dir,file));
  assert.throws(()=>flow.beginSave({reviewId:state.reviewId,report:after,snapshot:snap(1)}));
  assert.equal(flow.snapshot().stage,'ambiguous');assert.equal(flow.snapshot().reviewId,null);
  assert.throws(()=>flow.beginSave({reviewId:state.reviewId,report:after,snapshot:snap(1)}));
  assert.equal(new CalibrationWorkflow(dir).snapshot().stage,'ambiguous');
});

test('a journal failure after the save starts keeps the outcome ambiguous',t=>{
  const {dir,flow,after,ready}=setup(t);const state=ready();flow.beginSave({reviewId:state.reviewId,report:after,snapshot:snap(1)});
  const file=readdirSync(dir).find(n=>n.endsWith('.json'));rmSync(join(dir,file));mkdirSync(join(dir,file));
  assert.throws(()=>flow.finishSave({saveAcknowledged:true,persistenceVerified:false}));
  assert.equal(flow.snapshot().stage,'ambiguous');assert.equal(flow.snapshot().lastSavedAt,null);
  assert.equal(flow.snapshot().reviewId,null);
});

test('trial intent is durable before hardware and a process interruption requires an explicit restart boundary',t=>{
  const {dir,flow,baseline}=setup(t);flow.measured(baseline,snap());
  const expected=flow.beginTrial({sessionId:baseline.id,baselineReport:baseline,snapshot:snap()});
  assert.deepEqual(expected,{expectedController:controller,expectedWords:words});assert.equal(flow.needsRestart(),true);
  const reopened=new CalibrationWorkflow(dir);assert.equal(reopened.needsRestart(),true);
  for(const inspected of [snap(),snap(1),snap(1,'other-factory')]) {
    const status=reopened.inspect(inspected);assert.equal(status.stage,'ambiguous');assert.match(status.message,/restart/i);
    assert.equal(reopened.needsRestart(),true);assert.throws(()=>reopened.measured(baseline,inspected));
  }
  reopened.invalidate();assert.equal(reopened.needsRestart(),true);
  assert.throws(()=>reopened.beginTrial({sessionId:baseline.id,baselineReport:baseline,snapshot:snap()}));
  assert.throws(()=>reopened.prepare(report({epoch:1}),snap(1)));
  reopened.abandonTrial();assert.equal(reopened.needsRestart(),false);assert.equal(reopened.getTrialSessionId(),null);
  assert.equal(new CalibrationWorkflow(dir).needsRestart(),false);
});

test('trial refuses changed measured evidence, different controller or words, unlocked mode and repeated baseline',t=>{
  for(const mutate of [args=>args.baselineReport.captures[0].metrics.left.peakRadiusPercent=9,
    args=>args.snapshot=snap(1),args=>args.snapshot=snap(0,'other-factory'),args=>args.snapshot.nvsStatus='unlocked(permanent)',
    args=>args.sessionId='different-session']) {
    const {flow,baseline}=setup(t);flow.measured(baseline,snap());const args={sessionId:baseline.id,baselineReport:structuredClone(baseline),snapshot:snap()};
    mutate(args);assert.throws(()=>flow.beginTrial(args));assert.equal(flow.needsRestart(),false);
  }
  const {flow,baseline,trial}=setup(t);trial();flow.abandonTrial();flow.measured(baseline,snap());
  assert.throws(()=>flow.beginTrial({sessionId:baseline.id,baselineReport:baseline,snapshot:snap()}));
});

test('recording a trial consumes only its exact pending identity, words and baseline fingerprint',t=>{
  for(const mutate of [args=>args.before=snap(2),args=>args.before=snap(0,'other-factory'),
    args=>args.baselineReport.captures[0].at='changed',args=>args.sessionId='wrong']) {
    const {flow,baseline}=setup(t);flow.measured(baseline,snap());flow.beginTrial({sessionId:baseline.id,baselineReport:baseline,snapshot:snap()});
    const args={sessionId:baseline.id,before:snap(),after:snap(1),baselineReport:structuredClone(baseline)};mutate(args);
    assert.throws(()=>flow.recordTrial(args));assert.equal(flow.needsRestart(),true);
  }
  const {flow,baseline,trial}=setup(t);assert.throws(()=>flow.recordTrial({sessionId:baseline.id,before:snap(),after:snap(1),baselineReport:baseline}));
  trial();assert.equal(flow.needsRestart(),false);
});

test('explicit uncertain-trial marker and failed prewrite durability cannot authorize another trial',t=>{
  const {dir,flow,baseline}=setup(t);flow.measured(baseline,snap());flow.beginTrial({sessionId:baseline.id,baselineReport:baseline,snapshot:snap()});
  flow.markTrialUncertain();assert.equal(flow.needsRestart(),true);assert.equal(new CalibrationWorkflow(dir).needsRestart(),true);
  const other=setup(t);other.flow.measured(other.baseline,snap());
  const file=join(other.dir,'calibration-workflow.json');rmSync(file);mkdirSync(file);
  assert.throws(()=>other.flow.beginTrial({sessionId:other.baseline.id,baselineReport:other.baseline,snapshot:snap()}));
  assert.equal(other.flow.snapshot().stage,'ambiguous');
});

test('valid JSON with malformed journal current or receipt values fails closed without leaking or overwriting',t=>{
  for(const malformed of [{version:1,current:'private-path',receipts:{}},
    {version:1,current:{stage:'ready_to_save',review:{}},receipts:{}},
    {version:1,current:null,receipts:{bad:{}}},
    {version:1,current:null,receipts:{['a'.repeat(64)]:[null]}},
    {version:1,current:null,receipts:{['a'.repeat(64)]:[{status:'verified',controller,words}]}}]) {
    const {dir,baseline}=setup(t),file=join(dir,'calibration-workflow.json'),raw=JSON.stringify(malformed);writeFileSync(file,raw);
    const reopened=new CalibrationWorkflow(dir);assert.equal(reopened.snapshot().stage,'ambiguous');
    assert.equal(reopened.inspect(snap()).stage,'ambiguous');assert.throws(()=>reopened.measured(baseline,snap()));
    assert.doesNotMatch(JSON.stringify(reopened.snapshot()),/factory-private|private-path/);assert.equal(readFileSync(file,'utf8'),raw);
  }
});

test('uncertain save receipts block silent workflow replacement until explicit abandonment',t=>{
  const {flow,after,baseline,ready}=setup(t);const state=ready();flow.beginSave({reviewId:state.reviewId,report:after,snapshot:snap(1)});
  flow.finishSave({saveAcknowledged:false,persistenceVerified:false});flow.inspect(snap());
  assert.throws(()=>flow.measured(baseline,snap()));flow.abandonTrial();assert.equal(flow.measured(baseline,snap()).stage,'measured');
});

test('restart verification of an older receipt cannot silently clear a pending temporary trial',t=>{
  const {flow,after,baseline,ready}=setup(t);const state=ready();flow.beginSave({reviewId:state.reviewId,report:after,snapshot:snap(1)});
  flow.finishSave({saveAcknowledged:true,persistenceVerified:false});baseline.id='next-baseline';
  flow.measured(baseline,snap(1));flow.beginTrial({sessionId:baseline.id,baselineReport:baseline,snapshot:snap(1)});
  assert.throws(()=>flow.finishVerification({persistenceVerified:true,calibrationMatches:true,restartEvidence:'owner_confirmed'},snap(1)));
  assert.equal(flow.needsRestart(),true);
});

test('interrupted trial recovery requires the same controller, locked mode and owner restart confirmation',t=>{
  const {flow,baseline}=setup(t);flow.measured(baseline,snap());flow.beginTrial({sessionId:baseline.id,baselineReport:baseline,snapshot:snap()});
  flow.markTrialUncertain();
  for(const [snapshot,confirmed] of [[snap(0,'another-factory'),true],[{...snap(),nvsStatus:'unlocked(permanent)'},true],[snap(),false]]) {
    assert.throws(()=>flow.resolveInterruptedTrial(snapshot,confirmed),/same controller/);assert.equal(flow.needsRestart(),true);
  }
  flow.resolveInterruptedTrial(snap(),true);assert.equal(flow.needsRestart(),false);assert.equal(flow.getTrialSessionId(),null);
});

test('review diagnostics describe independent metrics without changing save authorization',t=>{
  const {flow,after,ready}=setup(t);const state=ready(),reviewId=state.reviewId;
  const diagnostics=state.diagnostics;assert.equal(diagnostics.available,true);assert.equal(diagnostics.complete,true);
  const rows=diagnostics.sticks.left.rows;
  assert.equal(rows.find(r=>r.id==='quiet_peak').delta,-1);assert.equal(rows.find(r=>r.id==='circularity').delta,0);
  assert.equal(rows.find(r=>r.id==='symmetry').delta,0);assert.equal(rows.find(r=>r.id==='release_peak').after,20);
  assert.doesNotMatch(JSON.stringify(diagnostics),/factory-private|private-path|enumeration-id|session-one/);
  rows[0].after=999;state.comparison.after.left.observedPeakPercent=999;
  assert.equal(flow.snapshot().diagnostics.sticks.left.rows[0].after,2);
  assert.deepEqual(flow.assertSave({reviewId,report:after,snapshot:snap(1)}).expectedWords,snap(1).words);
});
