import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCalibration, temporaryCenter } from '../temporary-center.js';
function fixture(status='locked(temporary)') {
  const sent=[];
  const c={mode:'usb',isEdge:false,info:{productId:0x0ce6},readSticksOnce(){},_nvsStatus(){return status;},async waitForRest(){return true;},
    sampleSticks(){return {frames:Array.from({length:30},(_,i)=>({t:i*8,lx:128,ly:128,rx:128,ry:128}))};},
    dev:{sendFeatureReport(p){sent.push(p);},getFeatureReport(){return [0x81,12,2,2,...Array(24).fill(0)];}},
    _expect(p){sent.push(p);}};
  return {c,sent};
}
test('snapshot validates calibration header and reads twelve words',async()=>{
  const {c}=fixture();assert.equal((await inspectCalibration(c)).words.length,12);
  c.dev.getFeatureReport=()=>[0x81,0,0,0];await assert.rejects(inspectCalibration(c),/calibration response/);
});
test('temporary center refuses unconfirmed readiness or unlocked NVS before calibration',async()=>{
  let {c,sent}=fixture();await assert.rejects(temporaryCenter(c,{ready:false,checkpoint(){}}),/ready/);assert.equal(sent.length,0);
  ({c,sent}=fixture('unlocked(permanent)'));await assert.rejects(temporaryCenter(c,{ready:true,checkpoint(){}}),/locked/);assert.ok(!sent.some(p=>p[0]===0x82));
});
test('checkpoint must succeed before any center write',async()=>{
  const {c,sent}=fixture();await assert.rejects(temporaryCenter(c,{ready:true,checkpoint(){throw Error('disk full');}}),/disk full/);
  assert.ok(!sent.some(p=>p[0]===0x82));
});
test('center transaction never unlocks NVS or starts range calibration',async()=>{
  const {c,sent}=fixture();const r=await temporaryCenter(c,{ready:true,checkpoint(){},pause:async()=>{}});
  assert.equal(r.permanentSaved,false);assert.equal(sent.filter(p=>p[0]===0x82).length,8);
  assert.ok(!sent.some(p=>p[0]===0x80 && p[1]===3 && [1,2].includes(p[2])));
  assert.ok(!sent.some(p=>p[0]===0x82 && p[3]===2));
});
test('movement during center sampling aborts without a center-end or flash',async()=>{
  const {c,sent}=fixture();let samples=0;const original=c.sampleSticks;
  c.sampleSticks=()=>{const s=original();if(++samples>1) s.frames.forEach(f=>f.lx=200);return s;};
  await assert.rejects(temporaryCenter(c,{ready:true,checkpoint(){},pause:async()=>{}}),/moved/);
  assert.ok(!sent.some(p=>p[0]===0x82&&p[1]===2));
});
