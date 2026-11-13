import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as spawnProcess } from 'node:child_process';
import { dispatchCalibrationOperation, runCalibrationWorker } from '../calibration-worker.js';

const id='12345678-1234-4234-8234-123456789abc';
const expectedController={productId:0x0ce6,serialNumber:'FACTORY'};
const expectedWords=Array(12).fill(123);
const trialInput={operation:'trial',sessionId:id,confirm:'TRY_TEMPORARY_CENTER',countdownConfirmed:true,expectedController,expectedWords};
const snapshot={controller:expectedController,words:expectedWords,nvsStatus:'locked(temporary)',factorySerialNumber:'FACTORY'};
function fixture(overrides={}) {
  let opened=0,closed=0;const packets=[];
  const controller={info:{productId:0x0ce6,path:'fake',serialNumber:'ENUM'},mode:'usb',isEdge:false,dev:{sendFeatureReport(p){packets.push(p);return p.length;}}};
  return {controller,packets,get opened(){return opened;},get closed(){return closed;},
    deps:{listControllers:()=>[{...controller.info,transport:'usb'}],withController:async(p,fn)=>{opened++;try{return await fn(controller);}finally{closed++;}},inspect:async()=>snapshot,...overrides}};
}
test('invalid operations, confirmations, paths and candidates fail before HID access',async()=>{
  const f=fixture();
  for(const input of [{operation:'other'},{operation:'inspect',path:'fake'},{operation:'trial',sessionId:'../x',confirm:'TRY_TEMPORARY_CENTER',countdownConfirmed:true},{operation:'trial',sessionId:id,confirm:'TRY_TEMPORARY_CENTER'},{operation:'save',confirm:'SAVE_REVIEWED_CALIBRATION',expectedController,expectedWords:[1]},{operation:'verify',expectedController,expectedWords,restartConfirmed:false}]) {
    await assert.rejects(dispatchCalibrationOperation(input,f.deps),e=>e.outcomeUnknown===false);
  }
  assert.equal(f.opened,0);
});
test('inspection returns factory snapshot and closes awaited handle',async()=>{
  const f=fixture();assert.deepEqual(await dispatchCalibrationOperation({operation:'inspect'},f.deps),snapshot);assert.equal(f.closed,1);
});
test('multiple matching standard controllers fail closed without opening',async()=>{
  const f=fixture({listControllers:()=>[{productId:0x0ce6,path:'a',transport:'usb'},{productId:0x0ce6,path:'b',transport:'usb'}]});
  await assert.rejects(dispatchCalibrationOperation({operation:'inspect'},f.deps),/exactly one/i);assert.equal(f.opened,0);
});
test('save uses fixed checkpoint directory and preserves lowlevel ambiguity',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cal-worker-'));
  try {
    const f=fixture({store:{root},save:async(c,o)=>{await o.checkpoint(snapshot);c.dev.sendFeatureReport([0x80,3,2]);return {status:'ambiguous',persistenceVerified:false};}});
    const result=await dispatchCalibrationOperation({operation:'save',confirm:'SAVE_REVIEWED_CALIBRATION',expectedController,expectedWords},f.deps);
    assert.equal(result.status,'ambiguous');assert.equal(result.persistenceVerified,false);
    assert.match(result.checkpointPath,/calibration-checkpoints/);assert.deepEqual(JSON.parse(readFileSync(result.checkpointPath,'utf8')),snapshot);
    assert.equal(readdirSync(join(root,'calibration-checkpoints')).length,1);assert.equal(f.closed,1);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('write throw records uncertainty but prewrite inspection throw does not',async()=>{
  const before=fixture({inspect:async()=>{throw Error('private detail');}});
  await assert.rejects(dispatchCalibrationOperation({operation:'reboot',confirm:'REBOOT_CONTROLLER'},before.deps),e=>!e.outcomeUnknown&&!e.message.includes('private detail'));
  const after=fixture();after.controller.dev.sendFeatureReport=()=>{throw Error('disconnected');};
  const result=await dispatchCalibrationOperation({operation:'reboot',confirm:'REBOOT_CONTROLLER'},after.deps);
  assert.equal(result.status,'ambiguous');assert.equal(result.outcomeUnknown,true);assert.equal(result.rebootObserved,false);assert.equal(after.closed,1);
});
test('reboot emits only reset packet and makes no persistence claim',async()=>{
  const f=fixture();const result=await dispatchCalibrationOperation({operation:'reboot',confirm:'REBOOT_CONTROLLER'},f.deps);
  assert.deepEqual(f.packets,[[0x80,1,1]]);assert.equal(result.status,'reboot_command_sent');assert.equal(result.rebootObserved,false);assert.equal(result.persistenceVerified,false);
  const unknown=fixture({inspect:async()=>({...snapshot,nvsStatus:'pending_reboot'})});
  await assert.rejects(dispatchCalibrationOperation({operation:'reboot',confirm:'REBOOT_CONTROLLER'},unknown.deps));assert.deepEqual(unknown.packets,[]);
});
test('verify is readonly and returns canonical snapshot',async()=>{
  const f=fixture({verify:async(c,o)=>{assert.equal(o.restartConfirmed,true);return {persistenceVerified:true};}});
  const result=await dispatchCalibrationOperation({operation:'verify',expectedController,expectedWords,restartConfirmed:true},f.deps);
  assert.equal(result.persistenceVerified,true);assert.deepEqual(result.snapshot,snapshot);assert.deepEqual(f.packets,[]);
});
test('trial returns factory snapshots and report after durable session checkpoint',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cal-trial-'));const dir=join(root,id);mkdirSync(dir);
  const session={id,controller:{productId:0x0ce6,path:'fake',serialNumber:'ENUM'},captures:[]};
  const store={root,dir:()=>dir,get:()=>session,save:s=>writeFileSync(join(dir,'session.json'),JSON.stringify(s)),report:()=>({id,complete:false})};
  try {
    let calls=0;
    const f=fixture({store,inspect:async()=>({...snapshot,inspection:++calls}),trial:async(s,sessionId,c,ready)=>{
      assert.equal(ready,true);assert.equal(sessionId,id);
      const checkpointPath=join(dir,'calibration-before-12345678-1234-4234-8234-123456789abc.json');
      writeFileSync(checkpointPath,JSON.stringify(snapshot));
      session.calibrationActions=[{status:'started',checkpointPath}];s.save(session);
      assert.deepEqual(JSON.parse(readFileSync(checkpointPath,'utf8')),snapshot);
      assert.deepEqual(readdirSync(dir).sort(),['calibration-before-12345678-1234-4234-8234-123456789abc.json','session.json']);
      c.dev.sendFeatureReport([0x82,1,1,1]);
      return {temporaryApplied:true,permanentSaved:false,sessionId:id,checkpointPath};
    }});
    const result=await dispatchCalibrationOperation(trialInput,f.deps);
    assert.equal(result.before.inspection,1);assert.equal(result.after.inspection,2);assert.equal(result.report.id,id);assert.equal(f.closed,1);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('trial session validation and controller mismatch happen before open',async()=>{
  for(const session of [null,{id,controller:{productId:0x0df2,path:'fake'},captures:[]},{id,controller:{productId:0x0ce6,path:'elsewhere'},captures:[]}]) {
    const f=fixture({store:{get:()=>session}});
    await assert.rejects(dispatchCalibrationOperation(trialInput,f.deps));
    assert.equal(f.opened,0);
  }
});
test('trial requires reviewed factory identity and exact words before any calibration command',async()=>{
  const session={id,controller:{productId:0x0ce6,path:'fake',serialNumber:null},captures:[]};
  for(const changed of [{...snapshot,controller:{...expectedController,serialNumber:'OTHER'}},{...snapshot,words:[124,...expectedWords.slice(1)]},{...snapshot,words:expectedWords.slice(1)}]) {
    let trialCalled=false;
    const f=fixture({store:{get:()=>session},inspect:async()=>changed,trial:async()=>{trialCalled=true;}});
    await assert.rejects(dispatchCalibrationOperation(trialInput,f.deps),e=>e.outcomeUnknown===false&&e.stage==='failed_before_write');
    assert.equal(trialCalled,false);assert.deepEqual(f.packets,[]);assert.equal(f.closed,1);
  }
  const f=fixture();
  await assert.rejects(dispatchCalibrationOperation({operation:'trial',sessionId:id,confirm:'TRY_TEMPORARY_CENTER',countdownConfirmed:true},f.deps));
  assert.equal(f.opened,0);
});
test('postwrite failure is unknown and handle closes; Bluetooth and Edge never open',async()=>{
  const f=fixture({save:async c=>{c.dev.sendFeatureReport([0x80,3,2]);throw Error('private failure');}});
  await assert.rejects(dispatchCalibrationOperation({operation:'save',confirm:'SAVE_REVIEWED_CALIBRATION',expectedController,expectedWords},f.deps),e=>e.outcomeUnknown===true&&e.stage==='unknown_after_write_attempt');assert.equal(f.closed,1);
  for(const device of [{productId:0x0ce6,path:'bt',transport:'bt'},{productId:0x0df2,path:'edge',transport:'usb'}]) {
    const g=fixture({listControllers:()=>[device]});await assert.rejects(dispatchCalibrationOperation({operation:'inspect'},g.deps));assert.equal(g.opened,0);
  }
});
function fakeSpawn(response,{code=0}={}) {
  let args,options,input='';
  function spawn(executable,a,o){args=[executable,...a];options=o;const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin.on('data',b=>input+=b);child.stdin.on('finish',()=>queueMicrotask(()=>{child.stdout.end(response);child.emit('close',code,null);}));child.kill=()=>{throw Error('Must never kill write process');};return child;}
  return {spawn,get args(){return args;},get options(){return options;},get input(){return JSON.parse(input);}};
}
test('parent sends private JSON over stdin without shell and returns structured ambiguity',async()=>{
  const f=fakeSpawn(JSON.stringify({ok:true,result:{status:'ambiguous'}}));
  const input={operation:'reboot',confirm:'REBOOT_CONTROLLER'};
  assert.deepEqual(await runCalibrationWorker(input,{spawn:f.spawn}),{status:'ambiguous'});
  assert.deepEqual(f.input,input);assert.equal(f.options.windowsHide,true);assert.equal(f.options.shell,false);assert.ok(f.args.includes('--calibration-worker'));assert.ok(!f.args.includes('REBOOT_CONTROLLER'));
});
test('parent marks write process/protocol failure unknown and never retries',async()=>{
  const f=fakeSpawn('invalid JSON',{code:1});
  await assert.rejects(runCalibrationWorker({operation:'reboot',confirm:'REBOOT_CONTROLLER'},{spawn:f.spawn}),e=>e.outcomeUnknown===true);
  const g=fakeSpawn(JSON.stringify({ok:false,error:{message:'failed before controller write attempt',outcomeUnknown:false,stage:'failed_before_write'}}),{code:1});
  await assert.rejects(runCalibrationWorker({operation:'reboot',confirm:'REBOOT_CONTROLLER'},{spawn:g.spawn}),e=>e.outcomeUnknown===false);
});
test('bounded output drains without killing and process errors remain uncertain for writes',async()=>{
  const f=fakeSpawn('x'.repeat(2*1024*1024+1));
  await assert.rejects(runCalibrationWorker({operation:'reboot',confirm:'REBOOT_CONTROLLER'},{spawn:f.spawn}),e=>e.outcomeUnknown===true);
  await assert.rejects(runCalibrationWorker({operation:'inspect'},{spawn:()=>{throw Error('private');}}),e=>e.outcomeUnknown===false&&!e.message.includes('private'));
});

test('pipe and process errors retain ownership until the child closes',async()=>{
  for(const channel of ['stdout','stderr','stdin','process','end']) {
    let child,settled=false;
    const task=runCalibrationWorker({operation:'reboot',confirm:'REBOOT_CONTROLLER'},{spawn:()=>{
      child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.kill=()=>{throw Error('Never interrupt a possible write');};
      if(channel==='end')child.stdin.end=()=>{throw Error('private pipe detail');};
      return child;
    }});
    const observed=task.then(()=>{settled=true;assert.fail('A failed transport cannot succeed');},e=>{settled=true;assert.equal(e.outcomeUnknown,true);});
    if(channel!=='end')(channel==='process'?child:child[channel]).emit('error',Error('private pipe detail'));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false,channel+' must wait for close');
    child.stdout.end(JSON.stringify({ok:true,result:{saveAcknowledged:true}}));child.emit('close',0,null);
    await observed;
  }
});

test('real worker uses the configured session directory before any HID enumeration',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cal-worker-config-')),configured=join(root,'custom-sessions');
  try {
    // The valid UUID is deliberately absent: SessionStore.get fails before
    // listControllers can be called. Importing node-hid does not enumerate HID.
    await assert.rejects(runCalibrationWorker(trialInput,{spawn:(exe,args,options)=>spawnProcess(exe,args,{...options,env:{...process.env,DUALSENSE_SESSION_DIR:configured}})}),e=>e.stage==='failed_before_write');
    assert.deepEqual(readdirSync(configured),[]);
  } finally {rmSync(root,{recursive:true,force:true});}
});
