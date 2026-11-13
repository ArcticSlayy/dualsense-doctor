// Private one-operation HID process. Importing this module never enumerates or opens HID.
import { spawn as spawnProcess } from 'node:child_process';
import { openSync, closeSync, fsyncSync, writeFileSync, readFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const MODULE_PATH=fileURLToPath(import.meta.url);
const MAX_INPUT=16*1024,MAX_OUTPUT=2*1024*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WRITES=new Set(['trial','save','reboot']);
const ALLOWED={inspect:['operation'],trial:['operation','sessionId','confirm','countdownConfirmed','expectedController','expectedWords'],save:['operation','confirm','expectedController','expectedWords'],verify:['operation','expectedController','expectedWords','restartConfirmed'],reboot:['operation','confirm']};

function failure(message,outcomeUnknown=false) {
  return Object.assign(new Error(message),{outcomeUnknown,stage:outcomeUnknown?'unknown_after_write_attempt':'failed_before_write',automaticRetryAllowed:false});
}
function validateCandidate(input) {
  const c=input.expectedController;
  if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['productId','serialNumber'].includes(k))||c.productId!==0x0ce6||typeof c.serialNumber!=='string'||c.serialNumber.length<1||c.serialNumber.length>17) throw failure('Invalid standard DualSense factory identity.');
  const serial=c.serialNumber.replace(/\0+$/,'');
  if(!serial.trim()||/[^\x20-\x7e]/.test(serial)) throw failure('Invalid factory serial identity.');
  const words=input.expectedWords;
  if(!Array.isArray(words)||words.length!==12||Array.from(words).some(n=>!Number.isInteger(n)||n<0||n>65535)) throw failure('Expected calibration requires twelve unsigned 16-bit words.');
}
function validate(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||!Object.hasOwn(ALLOWED,input.operation)) throw failure('Invalid calibration operation.');
  if(Object.keys(input).some(k=>!ALLOWED[input.operation].includes(k))) throw failure('Unexpected calibration argument; caller paths are not accepted.');
  if(input.operation==='trial'&&(!UUID.test(input.sessionId)||typeof input.sessionId!=='string'||input.confirm!=='TRY_TEMPORARY_CENTER'||input.countdownConfirmed!==true)) throw failure('Trial requires a valid session, explicit confirmation and completed host countdown.');
  if(input.operation==='save'&&input.confirm!=='SAVE_REVIEWED_CALIBRATION') throw failure('Explicit SAVE_REVIEWED_CALIBRATION confirmation is required.');
  if(input.operation==='verify'&&input.restartConfirmed!==true) throw failure('Owner-confirmed controller restart is required.');
  if(input.operation==='reboot'&&input.confirm!=='REBOOT_CONTROLLER') throw failure('Explicit REBOOT_CONTROLLER confirmation is required.');
  if(['trial','save','verify'].includes(input.operation)) validateCandidate(input);
}

function syncFile(path) {const fd=openSync(path,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}}
function syncDirectory(path) {
  // Windows does not expose directory handles through fs.open. Flush both the
  // temporary file and renamed file there; do not silently ignore file fsync errors.
  if(process.platform==='win32') return;
  const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
}
function durableJson(path,value) {
  mkdirSync(dirname(path),{recursive:true});
  const temporary=path+'.'+randomUUID()+'.tmp';
  let fd;
  try {
    fd=openSync(temporary,'wx',0o600);writeFileSync(fd,JSON.stringify(value,null,2));fsyncSync(fd);closeSync(fd);fd=undefined;
    renameSync(temporary,path);syncFile(path);syncDirectory(dirname(path));
  } catch(error) {if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch{}throw error;}
}
function durableTrialStore(store,sessionId) {
  const wrapper=Object.create(store);
  wrapper.save=function(session) {
    const action=session.calibrationActions?.at(-1);
    if(action?.status==='started') {
      const checkpoint=action.checkpointPath;
      if(typeof checkpoint!=='string'||dirname(resolve(checkpoint))!==resolve(store.dir(sessionId))||!/^calibration-before-[0-9a-f-]+\.json$/i.test(checkpoint.split(/[\\/]/).at(-1))) throw Error('Unexpected temporary calibration checkpoint.');
      // The existing session operation creates the snapshot synchronously. Make
      // that internally generated checkpoint atomic and flushed before it resumes.
      durableJson(checkpoint,JSON.parse(readFileSync(checkpoint,'utf8')));
    }
    store.save(session);
    syncFile(join(store.dir(sessionId),'session.json'));syncDirectory(store.dir(sessionId));
  };
  return wrapper;
}
async function realDependencies() {
  const [{SessionStore,withController},{listControllers},reviewed,temporary]=await Promise.all([
    import('./guided.js'),import('./hid/dualsense.js'),import('./reviewed-calibration.js'),import('./temporary-center.js'),
  ]);
  return {store:new SessionStore(),withController,listControllers,inspect:reviewed.inspectReviewedCalibration,save:reviewed.saveReviewedCalibration,verify:reviewed.verifyCalibrationAfterRestart,trial:temporary.runSessionTemporaryCenter};
}
function trackWrites(c,onWrite) {
  const original=c.dev;
  c.dev=new Proxy(original,{get(target,key){
    const value=Reflect.get(target,key,target);
    if(key==='sendFeatureReport') return packet=>{
      if(packet?.[0]===0x82||(packet?.[0]===0x80&&((packet[1]===3&&[1,2].includes(packet[2]))||(packet[1]===1&&packet[2]===1)))) onWrite();
      return value.call(target,packet);
    };
    return typeof value==='function'?value.bind(target):value;
  }});
  return ()=>{c.dev=original;};
}

/** Injectable hardware-free entry point. Production callers use the parent helper.
 * A process dispatches one operation; no caller-controlled file path is accepted.
 */
export async function dispatchCalibrationOperation(input,injected) {
  validate(input);
  let attempted=false;
  try {
    const deps=injected??await realDependencies();
    const {store}=deps;
    let session;
    if(input.operation==='trial') {
      session=store.get(input.sessionId);
      if(session?.id!==input.sessionId||session.controller?.productId!==0x0ce6||typeof session.controller.path!=='string'||!session.controller.path||!Array.isArray(session.captures)) throw Error('Invalid session controller evidence.');
    }
    const available=await deps.listControllers();
    const matches=available.filter(c=>c.productId===0x0ce6&&c.isEdge!==true&&c.transport==='usb');
    if(matches.length!==1||typeof matches[0].path!=='string'||!matches[0].path) throw failure('Calibration requires exactly one standard USB DualSense.');
    const selected=matches[0];
    if(session&&(session.controller.serialNumber?session.controller.serialNumber!==selected.serialNumber:session.controller.path!==selected.path)) throw Error('Session controller is not the connected controller.');
    return await deps.withController(selected.path,async c=>{
      const restore=trackWrites(c,()=>{attempted=true;});
      try {
        if(input.operation==='inspect') return await deps.inspect(c);
        if(input.operation==='trial') {
          const before=await deps.inspect(c);
          if(before.controller?.productId!==input.expectedController.productId||before.controller?.serialNumber!==input.expectedController.serialNumber.replace(/\0+$/,'')||!Array.isArray(before.words)||before.words.length!==12||!before.words.every((n,i)=>n===input.expectedWords[i])) throw Error('Factory identity or calibration changed before temporary trial.');
          const result=await deps.trial(durableTrialStore(store,input.sessionId),input.sessionId,c,true);
          const after=await deps.inspect(c);
          return {...result,before,after,report:store.report(input.sessionId)};
        }
        if(input.operation==='save') {
          let checkpointPath;
          const result=await deps.save(c,{confirm:input.confirm,expectedController:input.expectedController,expectedWords:input.expectedWords,checkpoint:async snapshot=>{
            checkpointPath=join(store.root,'calibration-checkpoints',randomUUID()+'.json');
            durableJson(checkpointPath,snapshot);
          }});
          return {...result,checkpointPath};
        }
        if(input.operation==='verify') {
          const result=await deps.verify(c,{expectedController:input.expectedController,expectedWords:input.expectedWords,restartConfirmed:true});
          const snapshot=await deps.inspect(c);
          // A second read must not attach a changed snapshot to a passing check.
          if(snapshot.controller.productId!==input.expectedController.productId||snapshot.controller.serialNumber!==input.expectedController.serialNumber.replace(/\0+$/,'')||snapshot.nvsStatus!=='locked(temporary)'||snapshot.words.length!==12||!snapshot.words.every((n,i)=>n===input.expectedWords[i])) return {...result,status:'mismatch',persistenceVerified:false,calibrationMatches:false,snapshot};
          return {...result,snapshot};
        }
        const before=await deps.inspect(c);
        if(c.mode!=='usb'||c.isEdge||c.info.productId!==0x0ce6||before.nvsStatus!=='locked(temporary)') throw Error('Reboot requires standard USB DualSense in known locked mode.');
        try {
          const sent=c.dev.sendFeatureReport([0x80,1,1]);
          if(!Number.isInteger(sent)||sent<3||sent>64) throw Error('Reset transfer incomplete.');
          return {status:'reboot_command_sent',rebootObserved:false,persistenceVerified:false,outcomeUnknown:false,automaticRetryAllowed:false};
        } catch {
          return {status:'ambiguous',rebootObserved:false,persistenceVerified:false,outcomeUnknown:true,automaticRetryAllowed:false,next:'The controller may have rebooted. Reconnect and inspect; do not automatically retry.'};
        }
      } finally {restore();}
    });
  } catch(error) {
    if(error?.stage&&!attempted) throw error;
    throw failure(attempted?'Calibration operation failed after a controller write attempt; outcome is unknown. Do not automatically retry.':'Calibration operation failed before a controller write attempt.',attempted);
  }
}

/** Launch once, transfer private JSON over pipes, and wait through hardware writes.
 * There is deliberately no generic timeout or automatic retry/kill policy.
 */
export async function runCalibrationWorker(input,{spawn=spawnProcess}={}) {
  validate(input);
  const payload=JSON.stringify(input);
  if(Buffer.byteLength(payload)>MAX_INPUT) throw failure('Calibration input exceeds protocol limit.');
  return await new Promise((resolveResult,reject)=>{
    let child;
    const processFailure=()=>failure('Calibration worker process failed; inspect state before any further write.',WRITES.has(input.operation));
    try {child=spawn(process.execPath,[MODULE_PATH,'--calibration-worker'],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});} catch {reject(processFailure());return;}
    let output=[],bytes=0,overflow=false,settled=false,protocolFailed=false;
    const fail=error=>{if(!settled){settled=true;reject(error);}};
    child.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>MAX_OUTPUT){overflow=true;output=[];}else if(!overflow)output.push(Buffer.from(chunk));});
    // Drain private stderr without forwarding serial numbers, paths or capabilities.
    child.stderr.on('data',()=>{});
    // A broken pipe does not mean the process (or its HID operation) has ended.
    // Node emits close after process errors too. Keep ownership until then.
    const rememberFailure=()=>{protocolFailed=true;};
    child.stdout.on('error',rememberFailure);
    child.stderr.on('error',rememberFailure);
    child.on('error',rememberFailure);
    child.stdin.on('error',rememberFailure);
    child.on('close',(code,signal)=>{
      if(settled)return;
      try {
        if(protocolFailed||overflow||signal) throw Error('Protocol failure');
        const message=JSON.parse(Buffer.concat(output).toString('utf8'));
        if(message?.ok===false&&code!==0&&typeof message.error?.outcomeUnknown==='boolean'&&message.error.stage===(message.error.outcomeUnknown?'unknown_after_write_attempt':'failed_before_write')) {
          fail(failure(message.error.outcomeUnknown?'Calibration worker failed after a write attempt; outcome is unknown. Do not automatically retry.':'Calibration worker failed before a controller write attempt.',message.error.outcomeUnknown));return;
        }
        if(code!==0||message?.ok!==true||!Object.hasOwn(message,'result')) throw Error('Protocol failure');
        settled=true;resolveResult(message.result);
      } catch {fail(processFailure());}
    });
    try{child.stdin.end(payload);}catch{rememberFailure();child.stdin.destroy();}
  });
}

async function cli() {
  let size=0,parts=[],completedWrite=false;
  try {
    for await(const chunk of process.stdin){size+=chunk.length;if(size>MAX_INPUT)throw failure('Calibration input exceeds protocol limit.');parts.push(chunk);}
    let input;try{input=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw failure('Invalid calibration JSON.');}
    const result=await dispatchCalibrationOperation(input);
    completedWrite=WRITES.has(input.operation);
    const output=JSON.stringify({ok:true,result});
    if(Buffer.byteLength(output)>MAX_OUTPUT)throw failure('Calibration result exceeds protocol limit.',WRITES.has(input.operation));
    process.stdout.write(output+'\n');
  } catch(error) {
    process.exitCode=1;
    const unknown=completedWrite||error?.outcomeUnknown===true;
    process.stdout.write(JSON.stringify({ok:false,error:{message:unknown?'Operation outcome is unknown after write attempt.':'Operation failed before write attempt.',outcomeUnknown:unknown,stage:unknown?'unknown_after_write_attempt':'failed_before_write',automaticRetryAllowed:false}})+'\n');
  }
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(MODULE_PATH)&&process.argv[2]==='--calibration-worker') await cli();
