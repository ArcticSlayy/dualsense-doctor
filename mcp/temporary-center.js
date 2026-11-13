// Center-only temporary calibration. No NVS unlock, lock, range or flash command.
// Protocol: dualshock-tools/js/controllers/ds5-controller.js (MIT).
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

export async function inspectCalibration(c) {
  c.readSticksOnce(800);
  if(c.mode!=='usb'||c.isEdge||c.info.productId!==0x0ce6) throw Error('Requires a standard DualSense over USB.');
  const nvsStatus=c._nvsStatus();
  c.dev.sendFeatureReport([0x80,12,2]);
  await sleep(100);
  const data=c.dev.getFeatureReport(0x81,64);
  if(!data||data.length<28||data[0]!==0x81||data[1]!==12||![2,4].includes(data[2])||data[3]!==2) throw Error('Invalid calibration response; no calibration attempted.');
  const words=Array.from({length:12},(_,i)=>data[4+i*2]|(data[5+i*2]<<8));
  return {at:new Date().toISOString(),nvsStatus,words,raw:Array.from(data),controller:c.info};
}

export async function temporaryCenter(c,{ready,checkpoint,pause=sleep}={}) {
  if(ready!==true) throw Error('User must be ready with both sticks untouched.');
  if(typeof checkpoint!=='function') throw Error('Durable calibration checkpoint is required.');
  const before=await inspectCalibration(c);
  if(before.nvsStatus!=='locked(temporary)') throw Error('NVS must already be locked in temporary mode. No calibration attempted.');
  if(!await c.waitForRest()) throw Error('Sticks did not settle; no calibration attempted.');
  const baseline=c.sampleSticks(250).frames;
  if(baseline.length<20) throw Error('Insufficient input before center calibration.');
  const axes=['lx','ly','rx','ry'];
  const anchor=Object.fromEntries(axes.map(a=>[a,baseline.reduce((n,f)=>n+f[a],0)/baseline.length]));
  function guard() {
    const frames=c.sampleSticks(250).frames;
    if(frames.length<20||frames.some(f=>axes.some(a=>!Number.isFinite(f[a])||Math.abs(f[a]-anchor[a])>4))) throw Error('Sticks moved or input was lost during center calibration. No permanent save; power cycle before retrying.');
  }
  await checkpoint(before);
  // Recheck mode after the rest gate and checkpoint, before the first mutation.
  if(c._nvsStatus()!=='locked(temporary)') throw Error('NVS mode changed; center write refused.');
  c._expect([0x82,1,1,1],0x83010101,'temporary center begin');
  for(let i=0;i<6;i++) {guard();c._expect([0x82,3,1,1],0x83010101,'temporary center sample');await pause(200);}
  guard();
  c._expect([0x82,2,1,1],0x83010102,'temporary center end');
  const after=await inspectCalibration(c);
  if(after.nvsStatus!=='locked(temporary)') throw Error('Unexpected NVS state after temporary calibration; do not save.');
  return {temporaryApplied:true,permanentSaved:false,before,after,next:'Keep USB connected. Repeat rest, range measurement and release tests before deciding. Power cycling discards unsaved calibration.'};
}

export async function runSessionTemporaryCenter(store,id,c,ready) {
  const lock=join(store.dir(id),'.lock');mkdirSync(lock);
  let action;
  try {
    const s=store.get(id);
    const same=s.controller.productId===c.info.productId && (s.controller.serialNumber?s.controller.serialNumber===c.info.serialNumber:s.controller.path===c.info.path);
    if(!same) throw Error('Controller does not match session.');
    const result=await temporaryCenter(c,{ready,checkpoint(before){
      const checkpointPath=join(store.dir(id),`calibration-before-${randomUUID()}.json`);
      writeFileSync(checkpointPath,JSON.stringify(before,null,2));
      action={at:new Date().toISOString(),kind:'temporary_center',status:'started',checkpointPath,permanentSaved:false};
      (s.calibrationActions??=[]).push(action);store.save(s);store.log(s);
    }});
    action.status='applied';action.result=result;store.save(s);store.log(s);
    return {...result,sessionId:id,checkpointPath:action.checkpointPath};
  } catch(e) {
    if(action){const s=store.get(id);const saved=s.calibrationActions.at(-1);saved.status='failed';saved.error=e.message;store.save(s);store.log(s);}
    throw e;
  } finally {rmSync(lock,{recursive:true});}
}
