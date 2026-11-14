import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { Controller, parseSticks, listControllers, TRIGGER_PRESETS, effFeedback } from './hid/dualsense.js';
import { SessionStore } from './guided.js';
import { runGuided, RUN_STEPS } from './coach-runner.js';
import { compareSessionReports } from './session-comparison.js';
import { join } from 'node:path';
import { CalibrationWorkflow } from './calibration-workflow.js';
import { runCalibrationWorker } from './calibration-worker.js';
import { startFeedClock } from './feed-clock.js';
import { readSessionHistory } from './session-insights.js';
import { TriggerCheck } from './trigger-check.js';
import { assessStickTuning } from './stick-tuning.js';

// Sony's battery nibble reports 10% intervals; use midpoint estimates except full.
export function batteryFromReport(buf,mode) {
  const index=mode==='usb'?53:mode==='bt'?54:-1;
  if(index<0||buf.length<=index)return null;
  const value=buf[index],status=value>>4;
  if(status===2)return {level:100,status:'full',estimated:true};
  if(status===0||status===1)return {level:Math.min(100,(value&15)*10+5),status:status?'charging':'discharging',estimated:true};
  return {level:null,status:[10,11].includes(status)?'not charging':'unknown',estimated:true};
}

export class CoachHost {
  constructor(store=new SessionStore(),{workflow,worker=runCalibrationWorker,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),enableCalibration=true}={}) {
    this.store=store;this.c=null;this.queue=[];this.latest=null;this.lastAt=0;this.events=[];this.run=null;this.status='idle';this.instruction='Connect your controller, then start the guided check.';this.warning=null;this.progress=0;this.currentIndex=0;this.resumeIndex=0;this.completedSteps=new Set();this.sequence=0;this.inputCount=0;this.rateAt=performance.now();this.inputHz=0;
    this.effects={lightbar:null,triggers:null};this.battery=null;this.firmware=null;
    this.roundReports=[];this.roundTarget=1;this.roundGeneration=0;this.seriesReset=false;this.refreshMeasurements();
    this.calibrationWorkflow=workflow??(store.root?new CalibrationWorkflow(join(store.root,'calibration-history')):null);
    this.calibrationWorker=worker;this.wait=wait;this.enableCalibration=enableCalibration;
    this.calibrationOperation=null;this.calibrationCountdownUntil=0;this.calibrationRequiresRestart=this.calibrationWorkflow?.needsRestart?.()||false;
    this.calibrationInspectionPending=true;this.calibrationControllerPath=null;
    this.triggerCheck=new TriggerCheck({saveReport:async(report,{isCurrent})=>{
      if(!this.store.root)throw Error('Session storage unavailable.');
      const directory=join(this.store.root,'trigger-checks'),id=randomUUID(),temporary=join(directory,id+'.tmp'),destination=join(directory,id+'.json');
      await mkdir(directory,{recursive:true});
      try{await writeFile(temporary,JSON.stringify({...report,created:new Date().toISOString()},null,2),{flag:'wx'});if(!isCurrent())return;await rename(temporary,destination);}
      finally{await unlink(temporary).catch(()=>{});}
    }});
  }
  triggerCheckActive(){return this.triggerCheck.active;}
  calibrationState() {
    let state=this.calibrationWorkflow?.snapshot()??{stage:'unknown',message:'Calibration workflow is unavailable.',lastSavedAt:null,verifiedAt:null,firmwareSaveTimestamp:null,historySource:'this_app'};
    if(this.calibrationInspectionPending){
      state={...state,lastSavedAt:null,verifiedAt:null,reviewId:null,saveReview:null,comparison:null,diagnostics:null};
      if(!this.calibrationRequiresRestart)state={...state,stage:'unknown',message:'Inspect calibration history for this connection before using saved status.'};
    }
    const busy=!!this.calibrationOperation,idle=!busy&&!this.run&&!this.triggerCheckActive()&&!['running','paused'].includes(this.status);
    const fresh=!!this.c&&!!this.latest&&performance.now()-this.lastAt<300;
    const standard=fresh&&this.latest.mode==='usb'&&this.c.info.productId===0x0ce6;
    const ready=idle&&this.enableCalibration&&!!this.calibrationWorkflow;
    const trial=!!this.calibrationWorkflow?.getTrialSessionId();
    let canVerify=false;try{canVerify=!!this.calibrationWorkflow?.verificationCandidate();}catch{}
    return {...state,inspectionNeeded:this.calibrationInspectionPending,busy,operation:this.calibrationOperation,countdownSeconds:Math.max(0,(this.calibrationCountdownUntil-performance.now())/1000),
      blockedReason:busy?'Controller operation in progress.':!this.enableCalibration?'Calibration actions are disabled.':!idle?'Finish or stop the current check first.':this.calibrationRequiresRestart?'Restart the controller, then confirm the restart before continuing.':!standard?'Connect a standard DualSense with a USB data cable.':null,
      actions:{inspect:ready,trial:ready&&standard&&!this.calibrationRequiresRestart&&!trial&&this.result?.complete===true&&state.stage==='measured',retest:ready&&fresh&&trial&&!this.calibrationRequiresRestart&&!this.calibrationInspectionPending,
        save:ready&&standard&&!this.calibrationRequiresRestart&&state.stage==='ready_to_save'&&!!state.reviewId,reboot:ready&&standard,
        verify:ready&&((canVerify&&!this.calibrationInspectionPending)||this.calibrationRequiresRestart)}};
  }
  noteCalibrationInspection(snapshot){this.calibrationInspectionPending=false;this.calibrationControllerPath=snapshot.controller?.path??null;}
  async inspectForCalibration(){this.calibrationInspectionPending=true;const snapshot=await this.calibrationWorker({operation:'inspect'});this.noteCalibrationInspection(snapshot);return snapshot;}
  releaseLiveHandle() {
    const c=this.c;this.c=null;c?.close();this.latest=null;this.queue=[];this.battery=null;this.firmware=null;this.effects={lightbar:null,triggers:null};
  }
  recordPersistence(status) {
    const context=this.calibrationWorkflow?.saveSessionContext?.();
    if(!context)return;
    try{
      const session=this.store.get(context.sessionId);
      if((session.calibrationActions?.length||0)!==context.epoch)throw Error('Session calibration changed after this save attempt.');
      const view=this.calibrationWorkflow.snapshot();
      session.calibrationPersistence={epoch:context.epoch,status,lastSavedAt:view.lastSavedAt,verifiedAt:view.verifiedAt};
      this.store.save(session);this.store.log(session);
    }catch(error){this.warning=`Save history is in the calibration journal, but the session log could not be updated: ${error.message}`;}
  }
  async calibrationAction(action,input={}) {
    const key=action.replace('calibration_',''),caps=this.calibrationState();
    if(!caps.actions[key])throw Error(caps.blockedReason||'This calibration action is not available yet.');
    if(key==='retest'){await this.launch(false,this.roundTarget,true);return this.snapshot();}
    if(key==='trial'&&input.confirm!=='TRY_TEMPORARY_CENTER')throw Error('Confirm the temporary center adjustment with hands off both sticks.');
    if(key==='save'&&input.confirm!=='SAVE_REVIEWED_CALIBRATION')throw Error('Review the measured result and confirm saving this calibration.');
    if(key==='reboot'&&input.confirm!=='REBOOT_CONTROLLER')throw Error('Confirm restarting the controller.');
    const rawStage=this.calibrationWorkflow?.snapshot().stage;
    if(key==='reboot'&&['trial_applied','ready_to_save'].includes(rawStage)&&input.discardUnsaved!==true)throw Error('Restarting will discard the unsaved adjustment. Confirm discarding it.');
    if(key==='verify'&&input.restartConfirmed!==true)throw Error('Confirm that you actually restarted or power-cycled the controller.');
    const workflow=this.calibrationWorkflow,hadConnection=!!this.c;
    this.calibrationOperation=key;this.warning=null;
    let saveStarted=false,trialStarted=false;
    try {
      if(key==='trial'){
        const baselineReport=this.store.report(this.sessionId);
        this.calibrationCountdownUntil=performance.now()+3000;this.instruction='Hands off both sticks. Temporary center adjustment starts in three seconds.';
        await this.wait(3000);this.calibrationCountdownUntil=0;
        if(!this.c||!this.latest||performance.now()-this.lastAt>300)throw Error('Controller input was lost before the adjustment.');
        this.releaseLiveHandle();this.instruction='Keep both sticks untouched while the center is sampled.';
        const snapshot=await this.inspectForCalibration();
        const candidate=workflow.beginTrial({sessionId:this.sessionId,baselineReport,snapshot});trialStarted=true;
        const result=await this.calibrationWorker({operation:'trial',sessionId:this.sessionId,confirm:input.confirm,countdownConfirmed:true,...candidate});
        workflow.recordTrial({sessionId:this.sessionId,before:result.before,after:result.after,baselineReport});
        this.noteCalibrationInspection(result.after);
        this.clearRounds();this.result=null;this.status='idle';this.instruction='Temporary center adjustment applied. Retest it before deciding whether to save.';
      } else {
        this.releaseLiveHandle();
        if(key==='inspect'){
          const snapshot=await this.inspectForCalibration();workflow.inspect(snapshot);
          if(this.result?.complete&&!workflow.getTrialSessionId()&&!this.calibrationRequiresRestart&&!['ambiguous','save_acknowledged','verified'].includes(workflow.snapshot().stage))workflow.measured(this.store.report(this.sessionId),snapshot);
          this.instruction='Calibration inspected. Save history shown here records actions made by this app.';
        } else if(key==='save'){
          const snapshot=await this.inspectForCalibration();
          const candidate=workflow.beginSave({reviewId:input.reviewId,report:this.store.report(this.sessionId),snapshot});saveStarted=true;
          this.recordPersistence('pending');
          this.instruction='Saving the reviewed calibration. Keep USB connected.';
          const result=await this.calibrationWorker({operation:'save',confirm:input.confirm,...candidate});
          workflow.finishSave(result);this.recordPersistence(result.saveAcknowledged?'save_acknowledged':'ambiguous');this.instruction=result.saveAcknowledged?'Save acknowledged. Restart and verify before claiming persistence.':'Save outcome is uncertain. Do not repeat it automatically; restart and verify the recorded values.';
        } else if(key==='verify'){
          if(this.calibrationRequiresRestart){
            const snapshot=await this.inspectForCalibration();workflow.resolveInterruptedTrial(snapshot,true);this.calibrationRequiresRestart=false;this.result=null;this.status='idle';
          }else{
            const candidate=workflow.verificationCandidate();
            const result=await this.calibrationWorker({operation:'verify',...candidate,restartConfirmed:true});
            workflow.finishVerification(result,result.snapshot);
            this.noteCalibrationInspection(result.snapshot);
            this.recordPersistence('verified');
          }
          this.instruction=workflow.snapshot().message;
        } else if(key==='reboot'){
          const result=await this.calibrationWorker({operation:'reboot',confirm:input.confirm});
          if(['trial_applied','ready_to_save'].includes(rawStage)){workflow.abandonTrial();this.result=null;this.status='idle';}
          this.calibrationInspectionPending=true;
          this.clearRounds();this.instruction=result.status==='ambiguous'?'Restart request outcome is uncertain. Reconnect, then confirm an actual restart before verification.':'Restart requested. Reconnect, then confirm the restart to verify saved calibration.';
        }
      }
    }catch(error){
      if(key==='trial'&&trialStarted){this.calibrationRequiresRestart=true;try{workflow.markTrialUncertain();}catch{}this.result=null;this.status='idle';}
      if(key==='save'&&saveStarted){try{workflow.finishSave({saveAcknowledged:false,persistenceVerified:false,status:'ambiguous',issues:[{stage:'worker',message:error.message}]});this.recordPersistence('ambiguous');}catch{}}
      this.warning=error.message;throw error;
    }finally{
      this.calibrationCountdownUntil=0;
      if(hadConnection&&key!=='reboot'){const instruction=this.instruction;try{this.connect({resumeInspection:true});this.instruction=instruction;}catch(error){this.calibrationInspectionPending=true;this.warning=this.warning||`Reconnect the controller: ${error.message}`;}}
      this.calibrationOperation=null;
    }
    return this.snapshot();
  }
  async prepareCalibrationResult(report) {
    if(!this.calibrationWorkflow||!this.enableCalibration||this.calibrationOperation)return;
    this.calibrationOperation='prepare';const hadConnection=!!this.c;
    try{
      this.releaseLiveHandle();const snapshot=await this.inspectForCalibration();
      if(this.calibrationWorkflow.getTrialSessionId())this.calibrationWorkflow.prepare(report,snapshot);
      else this.calibrationWorkflow.measured(report,snapshot);
    }catch(error){this.warning=`Calibration review is unavailable: ${error.message}`;}
    finally{if(hadConnection){try{this.connect({resumeInspection:true});}catch(error){this.calibrationInspectionPending=true;this.warning=this.warning||error.message;}}this.instruction=this.calibrationWorkflow.snapshot().message;this.calibrationOperation=null;}
  }
  refreshMeasurements() {
    // Compute only when the round set changes; fixed explanatory prose stays in
    // reports rather than being repeated in the high-rate live feed.
    const {note,...tuning}=assessStickTuning(this.roundReports.at(-1));
    this.measurements={targetRounds:this.roundTarget,comparison:compareSessionReports(this.roundReports),latestComparison:compareSessionReports(this.roundReports.slice(-1)),seriesReset:this.seriesReset,tuning,rounds:this.roundReports.map((report,i)=>{
      const summary=compareSessionReports([report]);
      return {number:i+1,complete:summary.acceptedRounds===1,...Object.fromEntries(['left','right'].map(side=>[side,{observedPeakPercent:summary[side]?.observedPeakPercent??null,suggestedDeadzonePercent:summary[side]?.suggestedDeadzonePercent??null,circularityPercent:summary[side]?.circularity?.latest??null}]))};
    })};
  }
  rememberRound(report,afterCaptureNumber) {
    if(report&&Number.isInteger(afterCaptureNumber))report={...report,id:`${report.id}@${afterCaptureNumber}`,captures:report.captures.filter(c=>c.number>afterCaptureNumber)};
    if(!report?.complete||!report.id||this.roundReports.some(r=>r.id===report.id))return;
    // Histories belong to individual sessions: a post-save fresh session may have
    // no actions while the reviewed retest retains its trial history. Let the
    // strict comparator define compatibility, then begin a new live series rather
    // than pooling them. Invalid incoming evidence must not erase a valid worst
    // round; saved session evidence is never changed by this live-series reset.
    if(compareSessionReports([report]).comparable&&this.roundReports.some(previous=>compareSessionReports([previous]).comparable&&!compareSessionReports([previous,report]).comparable)){
      this.clearRounds();this.seriesReset=true;
    }
    if(this.roundReports.length>=10)return;
    this.roundReports.push(report);this.refreshMeasurements();
  }
  clearRounds(){this.roundReports=[];this.roundGeneration++;this.seriesReset=false;this.refreshMeasurements();}
  event(e) {
    if(e.type==='instruction') {this.currentIndex=RUN_STEPS.findIndex(s=>s.phase===e.phase&&s.direction===e.direction);this.warning=null;this.details={};this.prepareDurationSeconds=e.countdownSeconds||0;this.prepareUntil=performance.now()+this.prepareDurationSeconds*1000;this.secondsRemaining=null;this.phaseProgress=0;this.progress=this.currentIndex/RUN_STEPS.length;}
    if(e.type==='phase_start')this.prepareUntil=0;
    if(e.type==='phase_complete'){this.completedSteps.add(this.currentIndex);this.phaseProgress=1;this.progress=(this.currentIndex+1)/RUN_STEPS.length;}
    this.sessionId=e.sessionId||this.sessionId;
    if(e.message)this.instruction=e.message;
    if(e.type==='correction')this.warning=e.message;
    if(e.type==='progress'){this.warning=e.warning||null;this.phaseProgress=e.phaseProgress||0;this.progress=(this.currentIndex+this.phaseProgress)/RUN_STEPS.length;this.secondsRemaining=e.secondsRemaining;this.details=e.details;}
    if(e.type!=='progress'){this.events.push({at:e.at||new Date().toISOString(),message:e.message});this.events=this.events.slice(-30);}
  }
  connect({resumeInspection=false}={}) {
    if(this.c)return;
    if(!resumeInspection)this.calibrationInspectionPending=true;
    const devices=listControllers();
    if(devices.length!==1)throw Error('Connect exactly one DualSense for this live card.');
    if(this.calibrationControllerPath&&devices[0].path!==this.calibrationControllerPath)this.calibrationInspectionPending=true;
    const c=new Controller(devices[0]);c.open();this.c=c;this.effects={lightbar:null,triggers:null};this.firmware=c.readFirmware();
    c.dev.on('data',buf=>{
      if(this.c!==c)return;
      const f=parseSticks(buf);if(!f)return;
      this.battery=batteryFromReport(buf,f.mode);
      this.latest=f;this.lastAt=performance.now();c._mode=f.mode;this.sequence++;this.inputCount++;
      if(this.triggerCheckActive())this.triggerCheck.feed(f,this.lastAt);
      if(this.lastAt-this.rateAt>=1000){this.inputHz=Math.round(this.inputCount*1000/(this.lastAt-this.rateAt));this.inputCount=0;this.rateAt=this.lastAt;}
      if(this.run){this.queue.push({s:f});if(this.queue.length>250)this.queue.shift();}
    });
    c.dev.on('error',e=>{if(this.c!==c)return;this.warning=`Controller input lost: ${e.message}`;this.disconnect();this.status='error';});
    this.instruction='Live view connected. Start once; follow the changing instructions.';
  }
  disconnect(){this.triggerCheck.cancel('disconnected');this.calibrationInspectionPending=true;this.result=null;this.abort?.abort();const c=this.c;this.c=null;c?.close();this.latest=null;this.queue=[];this.battery=null;this.firmware=null;this.effects={lightbar:null,triggers:null};this.clearRounds();if(this.status==='running')this.status='paused';}
  async launch(resume=false,roundTarget=this.roundTarget,retest=false) {
    if(this.triggerCheckActive())throw Error('Finish or cancel the trigger input check first.');
    if(this.run)throw Error('A guided check is already running.');
    if(![1,3,5].includes(roundTarget))throw Error('Choose 1, 3, or 5 comparison rounds.');
    if(!resume&&this.roundReports.length>=10)throw Error('Ten rounds are saved. Start a new comparison to continue.');
    if(!this.c||performance.now()-this.lastAt>300)throw Error('Waiting for fresh controller input.');
    if(this.calibrationRequiresRestart)throw Error('Restart the controller and confirm it before starting another check.');
    const trialSession=this.calibrationWorkflow?.getTrialSessionId();
    if(trialSession&&!resume&&!retest)throw Error('Use Retest adjustment to measure the temporary calibration in its original session.');
    this.roundTarget=roundTarget;this.refreshMeasurements();const generation=this.roundGeneration;
    this.queue=[];this.abort=new AbortController();this.status='running';this.warning=null;this.result=null;
    const startIndex=resume?this.resumeIndex:0;
    if(!resume){this.progress=0;this.sessionId=retest?trialSession:null;this.events=[];this.completedSteps.clear();}
    else for(const i of this.completedSteps)if(i>=startIndex)this.completedSteps.delete(i);
    if(!resume)this.roundStartCaptureNumber=retest?Math.max(0,...this.store.get(trialSession).captures.map(c=>c.number)):0;
    const proxy={info:this.c.info,_readOnce:()=>this.queue.shift()||null};
    const task=runGuided(proxy,this.store,{signal:this.abort.signal,steps:RUN_STEPS.slice(startIndex),existingSession:resume||retest?this.sessionId:undefined,onEvent:e=>this.event(e)});
    this.run=task;
    task.then(async result=>{if(generation!==this.roundGeneration)return;this.result=result;this.status=result.complete?'complete':'paused';if(!result.complete){this.warning=result.reason;this.resumeIndex=this.currentIndex===2?1:this.currentIndex;}else{this.progress=1;this.warning=null;this.rememberRound(result.report,this.roundStartCaptureNumber??0);await this.prepareCalibrationResult(result.report);}}).catch(e=>{
      if(this.status!=='paused'&&this.status!=='idle'){this.status='error';this.warning=e.message;}
    }).finally(()=>{if(this.run===task)this.run=null;});
  }
  async control(action,input={}) {
    if(this.calibrationOperation)throw Error('A controller operation is in progress. Wait for its result.');
    if(this.triggerCheckActive())this.triggerCheck.poll(performance.now());
    if(this.triggerCheckActive()&&!['trigger_check_stop','disconnect'].includes(action))throw Error('Finish or cancel the trigger input check first.');
    if(action==='trigger_check_start'){
      if(this.run||['running','paused'].includes(this.status)||this.calibrationRequiresRestart)throw Error('Finish or stop the stick check and resolve any required restart first.');
      if(!this.c||!this.latest||performance.now()-this.lastAt>300)throw Error('Connect the controller and wait for fresh input.');
      this.triggerCheck.start();return this.snapshot();
    }
    if(action==='trigger_check_stop'){this.triggerCheck.cancel();return this.snapshot();}
    if(action.startsWith('calibration_'))return this.calibrationAction(action,input);
    if(action==='connect')this.connect();
    else if(action==='disconnect'){this.disconnect();this.status='idle';}
    else if(action==='lightbar') {
      const {r,g,b}=input;
      if(![r,g,b].every(v=>Number.isInteger(v)&&v>=0&&v<=255))throw Error('RGB values must be integers from 0 to 255.');
      if(!this.c||!this.latest||performance.now()-this.lastAt>300)throw Error('Connect the controller and wait for fresh input before sending a color.');
      this.c.applyLightbar(r,g,b);this.effects.lightbar={r,g,b,commandSent:true,deviceConfirmed:false,sentAt:new Date().toISOString()};
    } else if(action==='triggers') {
      if(this.status==='running')throw Error('Pause the guided check before changing trigger resistance.');
      const {preset,target='both',position=2,strength=6}=input;
      if(!['off','light','firm','max','weapon','custom'].includes(preset)||!['both','left','right'].includes(target))throw Error('Choose a supported trigger preset and target.');
      if(!Number.isInteger(position)||position<0||position>9||!Number.isInteger(strength)||strength<1||strength>8)throw Error('Trigger position must be 0–9 and strength 1–8.');
      if(!this.c||!this.latest||performance.now()-this.lastAt>300)throw Error('Connect the controller and wait for fresh input before sending trigger effects.');
      const effect=preset==='custom'?effFeedback(position,strength):TRIGGER_PRESETS[preset]();
      this.c.applyTriggers(target==='right'?null:effect,target==='left'?null:effect);
      this.effects.triggers={preset,target,position,strength,commandSent:true,deviceConfirmed:false,sentAt:new Date().toISOString()};
    }
    else if(action==='start')await this.launch(false,input.roundTarget??this.roundTarget);
    else if(action==='reset_rounds'){
      if(this.run||['running','paused'].includes(this.status))throw Error('Stop the current check before starting a new comparison.');
      this.clearRounds();this.instruction='Comparison cleared. Saved session logs are retained.';
    }
    else if(action==='pause'){
      if(this.status!=='running')throw Error('No active guided check to pause.');
      this.resumeIndex=this.currentIndex===2?1:this.currentIndex;this.status='paused';this.abort.abort();
      this.instruction='Paused. Resume restarts the interrupted phase with a countdown.';await this.run.catch(()=>{});
    } else if(action==='resume')await this.launch(true);
    else if(action==='stop'){this.status='idle';this.abort?.abort();if(this.run)await this.run.catch(()=>{});this.instruction='Stopped. Captured phases remain logged; start a new check when ready.';this.warning=null;}
    else throw Error('Unknown control action.');
    return this.snapshot();
  }
  snapshot() {
    if(this.triggerCheckActive())this.triggerCheck.poll(performance.now());
    const ageMs=this.lastAt?performance.now()-this.lastAt:null;
    const active=['running','paused'].includes(this.status),step=active?RUN_STEPS[this.currentIndex]:null;
    const preparing=this.status==='running'&&this.prepareUntil>performance.now();
    const prepareSecondsRemaining=preparing?Math.max(0,(this.prepareUntil-performance.now())/1000):0;
    const labels=['Rest','Clockwise','Counterclockwise','Release','Buttons','Verify'];
    return {connected:!!this.c,status:this.status,latest:ageMs!==null&&ageMs<300?this.latest:null,ageMs,sequence:this.sequence,inputHz:this.inputHz,publishHz:125,clientMetrics:this.clientMetrics||null,battery:this.battery,firmware:this.firmware,effects:this.effects,controller:this.c?{product:this.c.info.product,productId:this.c.info.productId}:null,
      phase:step?.phase||null,direction:step?.direction||null,phaseProgress:this.phaseProgress||0,preparing,prepareSecondsRemaining,prepareDurationSeconds:this.prepareDurationSeconds||0,
      measurements:this.measurements,triggerCheck:this.triggerCheck.snapshot(),
      calibration:this.calibrationState(),
      instruction:this.instruction,warning:this.warning,progress:this.progress,secondsRemaining:active?(preparing?Math.ceil(prepareSecondsRemaining):this.secondsRemaining??null):null,details:active?(this.details||{}):{},sessionId:this.sessionId||null,result:this.result?{complete:this.result.complete,logPath:this.result.report?.logPath,reason:this.result.reason}:null,events:this.events,
      stepIndex:this.currentIndex,steps:RUN_STEPS.map((s,i)=>({id:s.direction?`range-${s.direction}`:s.phase,label:labels[i],status:this.completedSteps.has(i)?'complete':i===this.currentIndex&&['running','paused'].includes(this.status)?'current':'pending'}))};
  }
}

export function createCoachServer({host=new CoachHost(),port=27892,token=randomBytes(32).toString('hex')}={}) {
  const clients=new Set();
  let historyPending=null;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Private-Network','true');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
    res.setHeader('Cache-Control','no-store');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    const hostname=(req.headers.host||'').split(':')[0];
    if(!['127.0.0.1','localhost'].includes(hostname)){res.writeHead(403);res.end();return;}
    let url;try{url=new URL(req.url,'http://127.0.0.1');}catch{res.writeHead(400);res.end('Invalid request URL');return;}
    if(url.pathname==='/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({service:'dualsense-coach',version:1}));return;}
    const supplied=url.searchParams.get('token')||'';
    if(!/^[0-9a-f]{64}$/.test(supplied)||supplied.length!==token.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token))){res.writeHead(403);res.end('Invalid local capability');return;}
    if(req.method==='GET'&&url.pathname==='/events'){
      res.socket?.setNoDelay(true);res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();res.write(`event: state\ndata: ${JSON.stringify(host.snapshot())}\n\n`);clients.add(res);req.on('close',()=>clients.delete(res));return;
    }
    res.setHeader('Content-Type','application/json');
    if(req.method==='POST'&&url.pathname==='/metrics'){
      try{let body='';for await(const chunk of req){body+=chunk;if(body.length>2048)throw Error('Too large');}const m=JSON.parse(body);
        if(!['fps','receiveHz','clientAgeMs'].every(k=>Number.isFinite(m[k])&&m[k]>=0))throw Error('Invalid metrics');
        const optional={};for(const [key,max,integer] of [['frameGapP95Ms',60000],['frameGapMaxMs',60000],['frameWorkP95Ms',60000],['frameWorkMaxMs',60000],['frameGapsOver50Ms',239,true],['freshPlotFrames',Number.MAX_SAFE_INTEGER,true],['timingSamples',240,true]]){
          if(m[key]===undefined)continue;if(!Number.isFinite(m[key])||m[key]<0||(integer&&!Number.isInteger(m[key])))throw Error('Invalid metrics');optional[key]=Math.min(max,m[key]);
        }
        host.clientMetrics={fps:Math.min(1000,m.fps),receiveHz:Math.min(500,m.receiveHz),clientAgeMs:Math.min(60000,m.clientAgeMs),...optional,at:new Date().toISOString()};res.end('{"ok":true}');
      }catch{res.writeHead(400);res.end('{"error":"Invalid metrics"}');}return;
    }
    if(req.method==='GET'&&url.pathname==='/history'){
      try{historyPending??=readSessionHistory(host.store).finally(()=>{historyPending=null;});res.end(JSON.stringify(await historyPending));}
      catch{res.writeHead(503);res.end('{"error":"Saved checks are unavailable."}');}return;
    }
    if(req.method==='GET'&&url.pathname==='/state'){res.end(JSON.stringify(host.snapshot()));return;}
    if(req.method==='POST'&&url.pathname==='/control'){
      try{
        let body='';for await(const chunk of req){body+=chunk;if(body.length>2048)throw Error('Control request too large.');}
        const input=JSON.parse(body);const result=await host.control(input.action,input);res.end(JSON.stringify(result));
      }catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}));}return;
    }
    res.writeHead(404);res.end(JSON.stringify({error:'Not found'}));
  });
  const stopFeed=startFeedClock(()=>{if(!clients.size)return;const data=`event: state\ndata: ${JSON.stringify(host.snapshot())}\n\n`;for(const res of clients){if(res.writableLength>65536){clients.delete(res);res.end();}else res.write(data);}});
  server.on('close',()=>{stopFeed();host.disconnect();for(const c of clients)c.end();});
  return {server,host,token,port,listen:()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve(server.address()));}),close:()=>new Promise(resolve=>{for(const c of clients)c.end();server.close(resolve);})};
}
