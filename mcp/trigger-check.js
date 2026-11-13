// Passive lifecycle: host input/polls drive time; only the injected callback saves.
import { analyzeTriggerSweep } from './trigger-diagnostics.js';

const PREPARE_MS=3000,RECORD_MS=12000,MAX_GAP_MS=300,MAX_FRAMES=4000;
const ACTIVE=new Set(['preparing','recording','saving']);
const MODES=new Set(['usb','bt','bt-compat']);
const REASONS=new Set(['cancelled','input_lost','invalid_clock','capture_limit','disconnected','restarted']);
const raw=value=>Number.isInteger(value)&&value>=0&&value<=255;
const validFrame=frame=>MODES.has(frame?.mode)&&raw(frame?.l2)&&raw(frame?.r2);

/**
 * Timer-free, read-only trigger capture. feed receives a freshly parsed report;
 * its now argument (or injected clock) is monotonic milliseconds, not frame.t.
 * poll advances deadlines/freshness when no reports arrive. snapshot never advances
 * time and contains no raw frames. No report is saved after an incomplete capture.
 * saveReport(report,{isCurrent}) runs once after a complete capture. Async savers
 * should check isCurrent immediately before committing: cancelling cannot retract
 * an already-dispatched external save, but prevents stale completion/rejection
 * from changing this check or a later generation. saveStatus is 'abandoned' if
 * cancellation invalidates a dispatched save; its report may already be committing
 * and may remain on disk. No automatic retry occurs.
 */
export class TriggerCheck {
  get active(){return ACTIVE.has(this._status);}
  constructor({clock=()=>performance.now(),saveReport}={}) {
    if(typeof clock!=='function'||typeof saveReport!=='function')throw TypeError('Trigger check requires a clock and save callback.');
    this._clock=clock;this._saveReport=saveReport;this._generation=0;
    this._status='idle';this._saveStatus='not_started';this._reason=null;
    this._frames=[];this._sampleCount=0;this._analysis=null;this._lastNow=null;
  }

  start(now=this._clock()) {
    if(ACTIVE.has(this._status))throw Error('Trigger check is already active.');
    if(!Number.isFinite(now)||now<0)throw TypeError('Invalid trigger-check clock.');
    this._generation++;this._status='preparing';this._saveStatus='not_started';this._reason=null;
    this._frames=[];this._sampleCount=0;this._analysis=null;this._saveDispatched=false;
    this._startedAt=now;this._recordAt=now+PREPARE_MS;this._finishAt=this._recordAt+RECORD_MS;
    this._lastNow=now;this._lastFreshAt=now;this._lastFrameAt=null;
    return this.snapshot();
  }

  _advance(now) {
    if(this._status!=='preparing'&&this._status!=='recording')return false;
    if(!Number.isFinite(now)||now<0||now<this._lastNow){this.cancel('invalid_clock');return false;}
    this._lastNow=now;
    if(now-this._lastFreshAt>MAX_GAP_MS){this.cancel('input_lost');return false;}
    if(this._status==='preparing'&&now>=this._recordAt)this._status='recording';
    return true;
  }

  feed(frame,now=this._clock()) {
    if(!this._advance(now))return this.snapshot();
    if((this._lastFrameAt!==null&&now<=this._lastFrameAt)||!validFrame(frame))return this.snapshot();
    this._lastFrameAt=now;this._lastFreshAt=now;
    if(this._status==='recording'&&now<=this._finishAt) {
      if(this._frames.length>=MAX_FRAMES)return this.cancel('capture_limit');
      this._frames.push({t:now-this._recordAt,mode:frame.mode,l2:frame.l2,r2:frame.r2});
      this._sampleCount=this._frames.length;
    }
    if(this._status==='recording'&&now>=this._finishAt)this._finish();
    return this.snapshot();
  }

  poll(now=this._clock()) {
    if(this._advance(now)&&this._status==='recording'&&now>=this._finishAt)this._finish();
    return this.snapshot();
  }

  cancel(reason='cancelled') {
    if(!ACTIVE.has(this._status))return this.snapshot();
    const abandoned=this._status==='saving'&&this._saveDispatched;
    this._generation++;this._status='cancelled';this._reason=REASONS.has(reason)?reason:'cancelled';
    this._frames=[];this._sampleCount=0;this._analysis=null;this._saveStatus=abandoned?'abandoned':'not_started';
    return this.snapshot();
  }

  _finish() {
    const analysis=analyzeTriggerSweep(this._frames);
    this._frames=[];
    if(!analysis.quality.available||!analysis.triggers.l2.available||!analysis.triggers.r2.available) {
      this._status='error';this._reason='incomplete_capture';this._sampleCount=0;return;
    }
    this._status='saving';this._saveStatus='pending';
    const generation=this._generation;
    const isCurrent=()=>this._generation===generation&&this._status==='saving';
    const report={kind:'trigger-check',version:1,capture:{durationMs:RECORD_MS,sampleCount:this._sampleCount},analysis};
    Promise.resolve().then(()=>{
      if(!isCurrent())return;
      this._saveDispatched=true;
      return this._saveReport(structuredClone(report),{isCurrent});
    }).then(()=>{
      if(!isCurrent())return;
      this._analysis=analysis;this._status='complete';this._saveStatus='saved';
    }).catch(()=>{
      if(!isCurrent())return;
      this._status='error';this._reason='save_failed';this._saveStatus='failed';this._analysis=null;
    });
  }

  snapshot() {
    let remainingSeconds=0,progress=0,instruction='Start a trigger check when connected.';
    if(this._status==='preparing') {
      remainingSeconds=Math.ceil(Math.max(0,this._recordAt-this._lastNow)/1000);
      instruction='Leave both triggers released. Get ready to slowly pull and release both triggers.';
    } else if(this._status==='recording') {
      const elapsed=Math.max(0,this._lastNow-this._recordAt);
      remainingSeconds=Math.ceil(Math.max(0,RECORD_MS-elapsed)/1000);
      progress=Math.min(1,elapsed/RECORD_MS);
      instruction=Math.floor(elapsed/2000)%2===0?
        'Slowly pull BOTH triggers fully over 2 seconds.':
        'Slowly release BOTH triggers fully over 2 seconds.';
    } else if(this._status==='saving') {progress=1;instruction='Saving trigger observations.';}
    else if(this._status==='complete') {progress=1;instruction='Trigger observations saved. These measurements do not establish physical health.';}
    else if(this._status==='cancelled')instruction='Trigger check cancelled. Start again for a complete capture.';
    else if(this._status==='error')instruction=this._reason==='save_failed'?'Trigger observations could not be saved. Start again to retry.':'Trigger capture was incomplete. Start again.';
    return {status:this._status,remainingSeconds,progress,instruction,saveStatus:this._saveStatus,
      reason:this._reason,samples:this._sampleCount,analysis:this._status==='complete'?structuredClone(this._analysis):null};
  }
}
