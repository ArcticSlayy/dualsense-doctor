import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTriggerSweep } from '../trigger-diagnostics.js';

const capture = (values, mode='usb', stepMs=20) => values.map((v,i)=>({t:i*stepMs,mode,l2:v,r2:v}));
const slowValues = () => [
  ...Array(10).fill(0),
  ...Array.from({length:51},(_,i)=>Math.round(i*5.1)),
  ...Array(10).fill(255),
  ...Array.from({length:51},(_,i)=>255-Math.round(i*5.1)),
  ...Array(20).fill(0),
];

test('slow ordered sweeps report recorded endpoints and a return without health claims',()=>{
  const result=analyzeTriggerSweep(capture(slowValues()));
  assert.equal(result.quality.available,true);
  assert.equal(result.quality.mode,'usb');
  assert.deepEqual(result.triggers.l2.observed,{min:0,max:255,first:0,last:0});
  assert.deepEqual(result.triggers.l2.travel,{releasedObserved:true,pressedObserved:true});
  assert.deepEqual(result.triggers.l2.cycles,{completed:1,slowSweeps:1,fastCycles:0});
  assert.equal(result.triggers.l2.return.count,1);
  assert.equal(result.triggers.l2.return.finalReleased,true);
  assert.equal(result.triggers.l2.return.finalReleaseHoldMs,420);
  assert.equal(Object.hasOwn(result.triggers.l2,'smoothness'),false);
  assert.equal(Object.hasOwn(result,'healthy'),false);
});

test('rapid endpoint spam reports returns but never earns slow sweep evidence',()=>{
  const result=analyzeTriggerSweep(capture(Array.from({length:100},(_,i)=>i%2?255:0)));
  assert.equal(result.triggers.l2.cycles.completed,49);
  assert.equal(result.triggers.l2.cycles.slowSweeps,0);
  assert.equal(result.triggers.l2.cycles.fastCycles,49);
});

test('endpoint holds cannot turn abrupt presses into slow sweeps',()=>{
  const values=[...Array(60).fill(0),...Array(60).fill(255),...Array(60).fill(0)];
  const result=analyzeTriggerSweep(capture(values));
  assert.equal(result.triggers.l2.cycles.completed,1);
  assert.equal(result.triggers.l2.cycles.slowSweeps,0);
});

test('unordered intermediate samples cannot advertise a slow sweep',()=>{
  const values=[...Array(10).fill(0),...Array.from({length:50},(_,i)=>i%2?220:30),255,
    ...Array.from({length:50},(_,i)=>i%2?220:30),...Array(20).fill(0)];
  const result=analyzeTriggerSweep(capture(values));
  assert.equal(result.triggers.l2.cycles.completed,1);
  assert.equal(result.triggers.l2.cycles.slowSweeps,0);
});

test('a press without a subsequent release does not claim return evidence',()=>{
  const values=[...Array(10).fill(0),...Array.from({length:51},(_,i)=>Math.round(i*5.1)),...Array(10).fill(255)];
  const result=analyzeTriggerSweep(capture(values));
  assert.equal(result.triggers.l2.cycles.completed,0);
  assert.equal(result.triggers.l2.return.observed,false);
  assert.equal(result.triggers.l2.return.finalReleased,false);
});

test('a recording starting pressed must observe release then a fresh press before counting a cycle',()=>{
  const result=analyzeTriggerSweep(capture([...Array(30).fill(255),...Array(30).fill(0)]));
  assert.equal(result.triggers.l2.cycles.completed,0);
  assert.equal(result.triggers.l2.return.observed,false);
});

test('partial observed range is retained without fabricating endpoints or cycles',()=>{
  const result=analyzeTriggerSweep(capture(Array.from({length:100},(_,i)=>50+i)));
  assert.equal(result.triggers.l2.observed.min,50);
  assert.equal(result.triggers.l2.observed.max,149);
  assert.deepEqual(result.triggers.l2.travel,{releasedObserved:false,pressedObserved:false});
  assert.equal(result.triggers.l2.cycles.completed,0);
});

test('both known Bluetooth shapes use the same validated analog fields',()=>{
  for(const mode of ['bt','bt-compat']) {
    const result=analyzeTriggerSweep(capture(slowValues(),mode));
    assert.equal(result.quality.available,true);
    assert.equal(result.quality.mode,mode);
    assert.equal(result.triggers.r2.cycles.slowSweeps,1);
  }
});

test('missing or malformed analog samples are unavailable rather than zero or filtered',()=>{
  for(const invalid of [undefined,null,NaN,Infinity,-1,256,12.5,'0']) {
    const frames=capture(slowValues());frames[30].l2=invalid;
    const result=analyzeTriggerSweep(frames);
    assert.equal(result.triggers.l2.available,false);
    assert.equal(result.triggers.l2.observed,null);
    assert.equal(result.triggers.l2.travel,null);
    assert.equal(result.triggers.l2.cycles,null);
    assert.equal(result.triggers.l2.return,null);
    assert.equal(result.triggers.r2.cycles.slowSweeps,1);
  }
});

test('invalid timebases or interrupted input keep endpoints but withhold temporal evidence',()=>{
  const variants=[
    frames=>{delete frames[30].t;},
    frames=>{frames[30].t=NaN;},
    frames=>{frames[30].t=frames[29].t;},
    frames=>{frames[30].t=-1;},
    frames=>{for(let i=30;i<frames.length;i++)frames[i].t+=1000;},
  ];
  for(const mutate of variants) {
    const frames=capture(slowValues());mutate(frames);
    const result=analyzeTriggerSweep(frames);
    assert.equal(result.quality.available,false);
    assert.equal(result.triggers.l2.observed.max,255);
    assert.equal(result.triggers.l2.cycles,null);
    assert.equal(result.triggers.l2.return,null);
  }
});

test('missing, unsupported or changing modes withhold all transport-dependent cycle evidence',()=>{
  for(const mode of [undefined,null,'USB','unknown','bt']) {
    const frames=capture(slowValues());frames[30].mode=mode;
    const result=analyzeTriggerSweep(frames);
    assert.equal(result.quality.available,false);
    assert.equal(result.quality.mode,null);
    assert.equal(result.triggers.l2.cycles,null);
  }
});

test('empty, malformed, sparse and oversized captures remain unavailable',()=>{
  for(const frames of [undefined,null,{},[],[null],capture([0,255,0]),capture(Array(30001).fill(0))]) {
    const result=analyzeTriggerSweep(frames);
    assert.equal(result.quality.available,false);
    assert.equal(result.triggers.l2.cycles,null);
  }
});

test('input is neither mutated nor sorted to repair out of order data',()=>{
  const frames=capture(slowValues());frames[50].t=0;
  const snapshot=structuredClone(frames);
  for(const frame of frames)Object.freeze(frame);Object.freeze(frames);
  const result=analyzeTriggerSweep(frames);
  assert.equal(result.quality.available,false);
  assert.deepEqual(frames,snapshot);
});
