import test from 'node:test';
import assert from 'node:assert/strict';
import { TriggerCheck } from '../trigger-check.js';

const flush=()=>new Promise(setImmediate);
const input=()=>({mode:'usb',l2:0,r2:0});
function setup(saveReport=async()=>{}) {
  let now=0;
  const check=new TriggerCheck({clock:()=>now,saveReport});
  return {check,set:value=>{now=value;},feed:at=>{now=at;return check.feed(input());}};
}
function record(check,{from=0,to=15000,step=20}={}) {
  for(let now=from;now<=to;now+=step) {
    const elapsed=Math.max(0,now-3000)%4000;
    const raw=Math.round((elapsed<=2000?elapsed/2000:2-elapsed/2000)*255);
    check.feed({mode:'usb',l2:raw,r2:raw},now);
  }
}

test('starts idle, prepares three seconds, then records twelve seconds',()=>{
  const {check,feed}=setup();
  assert.equal(check.snapshot().status,'idle');
  assert.equal(check.start().status,'preparing');
  assert.equal(check.snapshot().remainingSeconds,3);
  for(let t=0;t<=2980;t+=20)feed(t);
  assert.equal(check.snapshot().status,'preparing');
  feed(3000);
  assert.equal(check.snapshot().status,'recording');
  assert.equal(check.snapshot().remainingSeconds,12);
  assert.equal(check.snapshot().progress,0);
  assert.match(check.snapshot().instruction,/pull/i);
  for(let t=3020;t<=5000;t+=20)feed(t);
  assert.match(check.snapshot().instruction,/release/i);
});

test('complete recording invokes save once and completes only after resolution',async()=>{
  let releaseSave,report,calls=0;
  const saved=new Promise(resolve=>{releaseSave=resolve;});
  const {check}=setup(async value=>{calls++;report=value;await saved;});
  check.start();record(check);await flush();
  assert.equal(check.snapshot().status,'saving');
  assert.equal(check.snapshot().saveStatus,'pending');
  assert.equal(check.snapshot().analysis,null);
  assert.equal(calls,1);
  assert.equal(report.analysis.triggers.l2.cycles.slowSweeps,3);
  check.poll(15020);check.feed(input(),15020);await flush();
  assert.equal(calls,1);
  releaseSave();await flush();
  assert.equal(check.snapshot().status,'complete');
  assert.equal(check.snapshot().saveStatus,'saved');
  assert.equal(check.snapshot().analysis.triggers.r2.cycles.slowSweeps,3);
  assert.equal(check.snapshot().progress,1);
});

test('preparation input loss and late recording stall cancel without saving',async()=>{
  for(const duringRecording of [false,true]) {
    let calls=0;const {check}=setup(()=>{calls++;});
    check.start();
    if(duringRecording)record(check,{to:5000});
    check.poll(duringRecording?15000:301);
    assert.equal(check.snapshot().status,'cancelled');
    assert.equal(check.snapshot().reason,'input_lost');
    assert.equal(check.snapshot().samples,0);
    await flush();assert.equal(calls,0);
  }
});

test('duplicate input does not refresh freshness or count as another sample',()=>{
  const {check}=setup();check.start();record(check,{to:3200});
  const before=check.snapshot().samples;
  check.feed(input(),3200);
  assert.equal(check.snapshot().samples,before);
  check.poll(3501);
  assert.equal(check.snapshot().status,'cancelled');
});

test('regressing and nonfinite clocks cancel with fixed messages',()=>{
  for(const now of [100,NaN,Infinity]) {
    const {check}=setup();check.start();check.feed(input(),200);check.poll(now);
    assert.equal(check.snapshot().status,'cancelled');
    assert.equal(check.snapshot().reason,'invalid_clock');
  }
});

test('invalid trigger or transport data cannot refresh valid input freshness',()=>{
  for(const frame of [{mode:'usb',l2:undefined,r2:0},{mode:'unknown',l2:0,r2:0},null]) {
    const {check}=setup();check.start();check.feed(input(),0);
    check.feed(frame,200);check.poll(301);
    assert.equal(check.snapshot().status,'cancelled');
    assert.equal(check.snapshot().reason,'input_lost');
  }
});

test('cancel clears partial capture, sanitizes reasons and never saves',async()=>{
  let calls=0;const {check}=setup(()=>{calls++;});
  check.start();record(check,{to:5000});
  assert.ok(check.snapshot().samples>0);
  check.cancel('/private/example-path');check.poll(15000);await flush();
  assert.equal(check.snapshot().status,'cancelled');
  assert.equal(check.snapshot().reason,'cancelled');
  assert.equal(check.snapshot().samples,0);
  assert.equal(check.snapshot().analysis,null);
  assert.equal(calls,0);
});

test('overlap is rejected throughout preparation, recording and saving',async()=>{
  const {check}=setup(()=>new Promise(()=>{}));
  check.start();assert.throws(()=>check.start(),/active/i);
  record(check,{to:5000});assert.throws(()=>check.start(5000),/active/i);
  record(check,{from:5020});await flush();
  assert.equal(check.snapshot().status,'saving');
  assert.throws(()=>check.start(15000),/active/i);
});

test('cancellation before deferred save dispatch prevents callback invocation',async()=>{
  let calls=0;const {check}=setup(()=>{calls++;});
  check.start();record(check);check.cancel();await flush();
  assert.equal(calls,0);assert.equal(check.snapshot().status,'cancelled');
});

test('cancel and restart invalidate the old save completion and callback guard',async()=>{
  let resolveSave,guard;
  const {check}=setup((report,context)=>{guard=context.isCurrent;return new Promise(resolve=>{resolveSave=resolve;});});
  check.start();record(check);await flush();
  assert.equal(guard(),true);
  check.cancel('restarted');assert.equal(guard(),false);
  check.start(15000);check.feed(input(),15000);
  resolveSave();await flush();
  assert.equal(check.snapshot().status,'preparing');
  assert.equal(check.snapshot().saveStatus,'not_started');
  assert.equal(check.snapshot().analysis,null);
});

test('save rejection reports a fixed error without leaking callback details',async()=>{
  const {check}=setup(async()=>{throw Error('/private/example-controller.json');});
  check.start();record(check);await flush();
  const result=check.snapshot();
  assert.equal(result.status,'error');assert.equal(result.saveStatus,'failed');
  assert.equal(result.reason,'save_failed');
  assert.equal(JSON.stringify(result).includes('private'),false);
});

test('capture cap cancels dense input before unbounded storage',async()=>{
  let calls=0;const {check}=setup(()=>{calls++;});
  check.start();record(check,{to:2980});
  for(let t=3000;t<=7000;t++)check.feed(input(),t);
  assert.equal(check.snapshot().status,'cancelled');
  assert.equal(check.snapshot().reason,'capture_limit');
  assert.equal(check.snapshot().samples,0);
  await flush();assert.equal(calls,0);
});

test('transport change makes final recording incomplete and prevents saving',async()=>{
  let calls=0;const {check}=setup(()=>{calls++;});check.start();
  for(let t=0;t<=15000;t+=20)check.feed({...input(),mode:t<8000?'usb':'bt'},t);
  await flush();
  assert.equal(check.snapshot().status,'error');
  assert.equal(check.snapshot().reason,'incomplete_capture');
  assert.equal(calls,0);
});

test('poll can finish a fresh capture without appending duplicate frames',async()=>{
  let calls=0;const {check}=setup(()=>{calls++;});
  check.start();record(check,{to:14980});check.poll(15000);await flush();
  assert.equal(check.snapshot().status,'complete');assert.equal(calls,1);
});

test('late rejected save cannot overwrite a restarted check',async()=>{
  let rejectSave;
  const {check}=setup(()=>new Promise((resolve,reject)=>{rejectSave=reject;}));
  check.start();record(check);await flush();
  check.cancel('restarted');check.start(15000);check.feed(input(),15000);
  rejectSave(Error('private backend detail'));await flush();
  assert.equal(check.snapshot().status,'preparing');
  assert.equal(check.snapshot().reason,null);
  assert.equal(check.snapshot().saveStatus,'not_started');
});

test('snapshots and saver mutations cannot rewrite completed evidence',async()=>{
  const {check}=setup(report=>{report.analysis.triggers.l2.observed.max=1;});
  check.start();record(check);await flush();
  const first=check.snapshot();
  assert.equal(first.analysis.triggers.l2.observed.max,255);
  first.analysis.triggers.l2.observed.max=2;
  assert.equal(check.snapshot().analysis.triggers.l2.observed.max,255);
});

test('snapshot is passive even when the injected clock moves forward',()=>{
  const {check,set}=setup();check.start();
  set(20000);
  assert.equal(check.snapshot().status,'preparing');
  assert.equal(check.snapshot().remainingSeconds,3);
  check.poll();assert.equal(check.snapshot().status,'cancelled');
});

test('cancel marks dispatched saves abandoned without claiming persistence was retracted',async()=>{
  const {check}=setup(()=>new Promise(()=>{}));
  check.start();record(check);await flush();
  check.cancel();
  assert.equal(check.snapshot().status,'cancelled');
  assert.equal(check.snapshot().saveStatus,'abandoned');
});
