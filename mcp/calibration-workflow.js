// Private local provenance only. This module never opens or writes a controller.
import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { compareSessionReports } from './session-comparison.js';

const LOCKED='locked(temporary)', TTL=10*60*1000;
const copy=value=>structuredClone(value);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fresh=()=>({version:1,current:null,receipts:{},usedBaselines:[]});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const STAGES=new Set(['measured','trial_pending','trial_interrupted','trial_applied','ready_to_save','pending','ambiguous','changed','save_acknowledged','verified']);
function canonical(snapshot) {
  const serial=snapshot?.controller?.serialNumber;
  if(snapshot?.controller?.productId!==0x0ce6||typeof serial!=='string'||serial.length<1||serial.length>17)
    throw Error('A standard DualSense factory identity is required.');
  const serialNumber=serial.replace(/\0+$/,'');
  if(!serialNumber.trim()||/[^\x20-\x7e]/.test(serialNumber))throw Error('A valid factory identity is required.');
  const words=snapshot.words;
  if(!Array.isArray(words)||words.length!==12||Array.from(words).some(n=>!Number.isInteger(n)||n<0||n>65535))
    throw Error('Exactly twelve calibration words are required.');
  const controller={productId:0x0ce6,serialNumber};
  return {controller,words:[...words],key:hash(controller),mode:snapshot.nvsStatus};
}
function summary(report) {
  const result=compareSessionReports([report]);
  if(!result.comparable||result.acceptedRounds!==1)throw Error('A complete valid measurement report is required.');
  return result;
}
// Bind full saved captures/history/identity, rather than only rounded UI values.
function fingerprint(report) {
  return hash({id:report.id,controller:report.controller,complete:report.complete,
    captures:report.captures,calibrationActions:report.calibrationActions??[]});
}
function validateJournal(state) {
  if(!object(state)||state.version!==1||!Object.hasOwn(state,'current')||!object(state.receipts))throw Error('Invalid journal.');
  if(state.usedBaselines!==undefined&&(!Array.isArray(state.usedBaselines)||state.usedBaselines.some(v=>!digest(v))))throw Error('Invalid journal.');
  function candidate(value,key) {
    if(!object(value))throw Error('Invalid journal.');
    const checked=canonical({...value,nvsStatus:value.mode});
    if(checked.key!==key)throw Error('Invalid journal.');
  }
  for(const [key,receipts] of Object.entries(state.receipts)) {
    if(!digest(key)||!Array.isArray(receipts))throw Error('Invalid journal.');
    for(const receipt of receipts) {
      candidate(receipt,key);
      if(typeof receipt.id!=='string'||!receipt.id||!['pending','ambiguous','save_acknowledged','verified'].includes(receipt.status)||
        !date(receipt.startedAt)||!(receipt.acknowledgedAt===null||date(receipt.acknowledgedAt))||
        !(receipt.verifiedAt===null||date(receipt.verifiedAt)))throw Error('Invalid journal.');
    }
  }
  const current=state.current;
  if(current!==null) {
    candidate(current,current?.key);
    if(!STAGES.has(current.stage)||typeof current.mode!=='string'||
      !(current.review===null||object(current.review))||!(current.comparison===undefined||current.comparison===null||object(current.comparison)))throw Error('Invalid journal.');
    if(current.review&&(!digest(current.review.fingerprint)||typeof current.review.id!=='string'||!current.review.id||
      !Number.isFinite(current.review.createdAt)||!Number.isFinite(current.review.expiresAt)))throw Error('Invalid journal.');
    if(['trial_pending','trial_interrupted'].includes(current.stage)&&(!object(current.trialIntent)||
      !digest(current.trialIntent.baselineFingerprint)||typeof current.trialIntent.sessionId!=='string'||!current.trialIntent.sessionId))throw Error('Invalid journal.');
    if(current.trialIntent!==undefined&&!object(current.trialIntent))throw Error('Invalid journal.');
    if(current.trialIntent!==undefined&&!['trial_pending','trial_interrupted'].includes(current.stage))throw Error('Invalid journal.');
    if(current.stage==='measured'&&(!digest(current.baselineFingerprint)||typeof current.sessionId!=='string'||!current.sessionId))throw Error('Invalid journal.');
    if(current.receiptId!==undefined&&(typeof current.receiptId!=='string'||
      !state.receipts[current.key]?.some(r=>r.id===current.receiptId&&same(r.words,current.words))))throw Error('Invalid journal.');
    if(['pending','ambiguous','save_acknowledged','verified'].includes(current.stage)&&!current.receiptId)throw Error('Invalid journal.');
    if(['trial_applied','ready_to_save'].includes(current.stage)&&(!Number.isInteger(current.epoch)||current.epoch<1||
      !Number.isInteger(current.captureFloor)||!Array.isArray(current.baselineActions)||typeof current.sessionId!=='string'||!object(current.reportController)))throw Error('Invalid journal.');
  }
}
function replaceDurably(directory,file,state) {
  const temp=join(directory,`.calibration-${randomUUID()}.tmp`);
  let fd;
  try {
    fd=openSync(temp,'wx',0o600);writeFileSync(fd,JSON.stringify(state));fsyncSync(fd);closeSync(fd);fd=undefined;
    renameSync(temp,file);
    // Windows does not expose directory fsync through Node. File data is flushed
    // before atomic replace; on platforms supporting it, flush the directory too.
    if(process.platform!=='win32') {
      fd=openSync(directory,'r');fsyncSync(fd);closeSync(fd);fd=undefined;
    }
  } finally {
    if(fd!==undefined)closeSync(fd);
    rmSync(temp,{force:true});
  }
}

export class CalibrationWorkflow {
  #directory; #file; #clock; #state=fresh(); #observed=null; #fault=false;
  constructor(directory,{clock=()=>Date.now()}={}) {
    if(typeof directory!=='string'||!directory.trim())throw Error('A private journal directory is required.');
    if(typeof clock!=='function')throw Error('A clock function is required.');
    this.#directory=resolve(directory);this.#file=join(this.#directory,'calibration-workflow.json');this.#clock=clock;
    mkdirSync(this.#directory,{recursive:true,mode:0o700});
    try {
      const state=JSON.parse(readFileSync(this.#file,'utf8'));
      validateJournal(state);state.usedBaselines??=[];
      this.#state=state;
      if(state.current?.stage==='pending')state.current.stage='ambiguous';
      if(state.current?.stage==='trial_pending')state.current.stage='trial_interrupted';
      // A new process cannot inherit an approval from an old live host.
      if(state.current?.review){state.current.review=null;state.current.stage='trial_applied';}
    } catch(error) { if(error.code!=='ENOENT')this.#fault=true; }
  }
  #now() { const n=this.#clock();if(!Number.isFinite(n))throw Error('Invalid local clock.');return n; }
  #commit(state) {
    if(this.#fault)throw Error('Calibration journal unavailable; inspect local history before continuing.');
    try {replaceDurably(this.#directory,this.#file,state);this.#state=state;}
    catch {this.#fault=true;throw Error('Calibration journal could not be durably updated; no further save is authorized.');}
  }
  #requireHealthy() {if(this.#fault)throw Error('Calibration journal unavailable; save refused.');}
  #requireResolved() {
    if(this.needsRestart())throw Error('A temporary trial may have been interrupted. Confirm a controller restart before more calibration.');
    const current=this.#state.current,receipt=current?.receiptId&&this.#state.receipts[current.key]?.find(r=>r.id===current.receiptId);
    if(receipt&&['pending','ambiguous'].includes(receipt.status))throw Error('Resolve or explicitly abandon the uncertain save workflow before starting a new measurement workflow.');
  }
  #receipt(key) {return this.#state.receipts[key]?.at(-1)??null;}
  #changed() {
    const next=copy(this.#state);
    if(next.current){next.current.review=null;next.current.stage='changed';this.#commit(next);}
  }
  inspect(snapshot) {
    const actual=canonical(snapshot);this.#observed=actual;
    const current=this.#state.current;
    if(!this.#fault&&!this.needsRestart()&&current&&current.stage!=='changed'&&(!same(current.controller,actual.controller)||!same(current.words,actual.words)||actual.mode!==LOCKED))this.#changed();
    return this.snapshot();
  }
  measured(report,snapshot) {
    this.#requireHealthy();this.#requireResolved();const actual=canonical(snapshot),before=summary(report);
    this.#observed=actual;
    const next=copy(this.#state);next.current={...actual,stage:'measured',sessionId:report.id,baselineFingerprint:fingerprint(report),comparison:{before,after:null},review:null};
    this.#commit(next);return this.snapshot();
  }
  beginTrial({sessionId,baselineReport,snapshot}) {
    this.#requireHealthy();this.#requireResolved();const actual=canonical(snapshot),current=this.#state.current;
    summary(baselineReport);const baselineFingerprint=fingerprint(baselineReport);
    if(current?.stage!=='measured'||sessionId!==current.sessionId||baselineReport.id!==sessionId||
      baselineFingerprint!==current.baselineFingerprint||!same(current.controller,actual.controller)||
      !same(current.words,actual.words)||current.mode!==LOCKED||actual.mode!==LOCKED||this.#state.usedBaselines.includes(baselineFingerprint))
      throw Error('A fresh unchanged measured baseline and matching locked controller are required before a temporary trial.');
    const next=copy(this.#state);next.current.stage='trial_pending';next.current.trialIntent={sessionId,baselineFingerprint};
    next.current.review=null;next.usedBaselines.push(baselineFingerprint);this.#observed=actual;this.#commit(next);
    return {expectedController:copy(actual.controller),expectedWords:[...actual.words]};
  }
  needsRestart() {return ['trial_pending','trial_interrupted'].includes(this.#state.current?.stage);}
  markTrialUncertain() {
    this.#requireHealthy();if(!this.needsRestart())throw Error('No pending temporary trial exists.');
    const next=copy(this.#state);next.current.stage='trial_interrupted';next.current.review=null;this.#commit(next);return this.snapshot();
  }
  recordTrial({sessionId,before,after,baselineReport}) {
    this.#requireHealthy();const prior=canonical(before),candidate=canonical(after);
    const pending=this.#state.current;
    if(pending?.stage!=='trial_pending'||pending.trialIntent?.sessionId!==sessionId||baselineReport?.id!==sessionId||
      pending.trialIntent.baselineFingerprint!==fingerprint(baselineReport)||!same(pending.controller,prior.controller)||!same(pending.words,prior.words))
      throw Error('Temporary trial result does not match the durable pending baseline and controller.');
    if(!same(prior.controller,candidate.controller)||prior.mode!==LOCKED||candidate.mode!==LOCKED)throw Error('Trial requires the same factory controller in locked mode.');
    if(typeof sessionId!=='string'||baselineReport?.id!==sessionId)throw Error('Baseline must belong to the trial session.');
    const baseline=summary(baselineReport),actions=baselineReport.calibrationActions??[];
    const captureFloor=Math.max(...baselineReport.captures.map(c=>c.number));
    const next=copy(this.#state);
    next.current={...candidate,stage:'trial_applied',sessionId,epoch:actions.length+1,captureFloor,
      baselineActions:copy(actions),reportController:copy(baselineReport.controller),comparison:{before:baseline,after:null,note:'Before and after measurements; no guaranteed improvement.'},review:null};
    this.#observed=candidate;this.#commit(next);return this.snapshot();
  }
  #checkReport(report,current) {
    const actions=report?.calibrationActions,action=actions?.at(-1);
    if(report?.id!==current.sessionId||!same(report.controller,current.reportController)||!Array.isArray(actions)||actions.length!==current.epoch||
      !same(actions.slice(0,-1),current.baselineActions)||action.kind!=='temporary_center'||action.status!=='applied'||
      !same(action.result?.after?.words,current.words))throw Error('Retest does not match the recorded temporary trial.');
    const captures=report.captures;
    if(!Array.isArray(captures)||captures.some(c=>!Number.isInteger(c?.number)||c.number<1))throw Error('Retest capture order is invalid.');
    const currentCaptures=captures.filter(c=>(c.calibrationEpoch??0)===current.epoch);
    if(currentCaptures.some(c=>c.metrics?.mode!=='usb'))throw Error('Post-trial retest requires the same USB connection.');
    if(currentCaptures.some(c=>c.number<=current.captureFloor))throw Error('New post-trial captures are required.');
    const latest=[...captures].sort((a,b)=>a.number-b.number).at(-1);
    if(latest?.phase!=='verify'||latest.calibrationEpoch!==current.epoch)throw Error('Final verification must be the latest capture after the trial.');
    return summary(report);
  }
  prepare(report,snapshot) {
    this.#requireHealthy();this.#requireResolved();this.inspect(snapshot);const current=this.#state.current;
    if(!current||!['trial_applied','ready_to_save'].includes(current.stage))throw Error('Apply and retest a temporary trial before reviewing a save.');
    try {
      const after=this.#checkReport(report,current),next=copy(this.#state);
      const at=this.#now();next.current.review={id:randomUUID(),fingerprint:fingerprint(report),createdAt:at,expiresAt:at+TTL};
      next.current.stage='ready_to_save';next.current.comparison.after=after;this.#commit(next);
    } catch(error) {if(!this.#fault)this.invalidate();throw error;}
    return this.snapshot();
  }
  assertSave({reviewId,report,snapshot}) {
    this.#requireHealthy();this.inspect(snapshot);const current=this.#state.current,review=current?.review;
    try {
      if(current?.stage!=='ready_to_save'||!review||review.id!==reviewId||this.#now()<review.createdAt||this.#now()>=review.expiresAt)
        throw Error('Review approval is absent or expired. Review a fresh retest before saving.');
      this.#checkReport(report,current);
      if(fingerprint(report)!==review.fingerprint)throw Error('Measurement evidence changed after review; prepare a fresh review.');
    } catch(error) {if(!this.#fault)this.invalidate();throw error;}
    return {expectedController:copy(current.controller),expectedWords:[...current.words]};
  }
  beginSave(args) {
    const expected=this.assertSave(args),next=copy(this.#state),current=next.current;
    const receipt={id:randomUUID(),controller:copy(current.controller),words:[...current.words],status:'pending',sessionId:current.sessionId,epoch:current.epoch,
      startedAt:new Date(this.#now()).toISOString(),acknowledgedAt:null,verifiedAt:null,comparison:copy(current.comparison)};
    (next.receipts[current.key]??=[]).push(receipt);
    current.receiptId=receipt.id;current.stage='pending';current.review=null;this.#commit(next);
    return expected;
  }
  finishSave(result) {
    this.#requireHealthy();const next=copy(this.#state),current=next.current;
    const receipt=current&&next.receipts[current.key]?.find(r=>r.id===current.receiptId);
    if(!receipt||receipt.status!=='pending')throw Error('No pending save attempt exists.');
    const acknowledged=result?.saveAcknowledged===true&&result.persistenceVerified===false;
    receipt.status=acknowledged?'save_acknowledged':'ambiguous';
    receipt.acknowledgedAt=acknowledged?new Date(this.#now()).toISOString():null;
    current.stage=receipt.status;this.#commit(next);return this.snapshot();
  }
  getTrialSessionId() {
    const current=this.#state.current;
    return !this.#fault&&['trial_applied','ready_to_save'].includes(current?.stage)?current.sessionId:null;
  }
  saveSessionContext() {
    const current=this.#state.current,receipt=current&&this.#state.receipts[current.key]?.find(r=>r.id===current.receiptId);
    return receipt?.sessionId&&Number.isInteger(receipt.epoch)?{sessionId:receipt.sessionId,epoch:receipt.epoch}:null;
  }
  verificationCandidate(snapshot) {
    this.#requireHealthy();const actual=snapshot?canonical(snapshot):this.#observed??this.#state.current;
    if(!actual)throw Error('Inspect a controller before restart verification.');
    const receipt=this.#receipt(actual.key);
    if(!receipt||!same(receipt.words,actual.words)||actual.mode!==LOCKED)throw Error('No matching local save attempt is available for restart verification.');
    return {expectedController:copy(receipt.controller),expectedWords:[...receipt.words]};
  }
  finishVerification(result,snapshot) {
    this.#requireHealthy();if(this.needsRestart())throw Error('Explicitly resolve the interrupted temporary trial before verifying earlier save history.');
    const actual=canonical(snapshot);this.#observed=actual;
    const receipt=this.#receipt(actual.key);
    if(!receipt||!same(receipt.controller,actual.controller)||!same(receipt.words,actual.words)||actual.mode!==LOCKED||
      result?.persistenceVerified!==true||result.calibrationMatches!==true||result.restartEvidence!=='owner_confirmed')
      throw Error('Verification requires the matching saved candidate after an owner-confirmed controller restart.');
    const next=copy(this.#state),saved=next.receipts[actual.key].at(-1);
    saved.status='verified';saved.verifiedAt=new Date(this.#now()).toISOString();
    next.current={...actual,stage:'verified',receiptId:saved.id,review:null,comparison:copy(saved.comparison)};
    this.#commit(next);return this.snapshot();
  }
  invalidate() {
    this.#requireHealthy();const next=copy(this.#state);
    if(next.current){next.current.review=null;if(next.current.stage==='ready_to_save')next.current.stage='trial_applied';this.#commit(next);}
    return this.snapshot();
  }
  abandonTrial() {
    this.#requireHealthy();const next=copy(this.#state);
    if(next.current){next.current.review=null;next.current.stage='changed';delete next.current.sessionId;
      delete next.current.trialIntent;delete next.current.baselineFingerprint;delete next.current.receiptId;this.#commit(next);}
    return this.snapshot();
  }
  resolveInterruptedTrial(snapshot,restartConfirmed) {
    this.#requireHealthy();const actual=canonical(snapshot),current=this.#state.current;
    if(restartConfirmed!==true||!this.needsRestart()||!same(current.controller,actual.controller)||actual.mode!==LOCKED)
      throw Error('Confirm a restart of the same controller in locked mode to resolve the interrupted trial.');
    this.#observed=actual;return this.abandonTrial();
  }
  snapshot() {
    const current=this.#state.current,actual=this.#observed,receipt=actual?this.#receipt(actual.key):null;
    const acknowledged=actual?this.#state.receipts[actual.key]?.findLast(r=>r.acknowledgedAt):null;
    const matches=receipt&&same(receipt.words,actual.words)&&actual.mode===LOCKED;
    const active=current&&(!actual||same(current.controller,actual.controller));
    let stage=this.#fault?'ambiguous':active&&!(current.stage==='changed'&&matches)?current.stage:matches?receipt.status:receipt?'changed':'unknown';
    if(stage==='pending'||this.needsRestart())stage='ambiguous';
    const review=active&&current.review;
    if(stage==='ready_to_save'&&(!review||this.#now()>=review.expiresAt||this.#now()<review.createdAt))stage='trial_applied';
    const messages={unknown:'No calibration save history from this app is known for this controller.',measured:'Baseline checked. A temporary center adjustment can be tested next.',
      trial_applied:'Temporary center adjustment recorded. Complete a new check before reviewing a save.',ready_to_save:'Review these before and after measurements before saving the exact tested candidate.',
      save_acknowledged:'Save acknowledged locally. Confirm a real controller power cycle, then verify readback.',verified:'Calibration matched after the owner-confirmed controller restart.',
      ambiguous:'Save history is uncertain. Inspect the controller and local history; do not automatically repeat a save.',changed:'Controller identity, calibration words or mode changed. A fresh trial and review are required.'};
    return {stage,message:this.needsRestart()?'A temporary center adjustment may have been interrupted. Confirm a real controller restart before another trial or save.':messages[stage]??messages.unknown,reviewId:stage==='ready_to_save'?review.id:null,
      lastSavedAt:acknowledged?.acknowledgedAt??null,verifiedAt:matches?receipt.verifiedAt:null,
      historySource:'this_app',firmwareSaveTimestamp:null,comparison:copy(active?current.comparison??null:matches?receipt.comparison??null:null)};
  }
}
