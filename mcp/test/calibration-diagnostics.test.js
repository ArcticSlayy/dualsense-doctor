import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrationDiagnostics } from '../calibration-diagnostics.js';

function summary(overrides={}) {
  const side={observedPeakPercent:3.12,suggestedDeadzonePercent:5,reliable:true,
    worstP99Percent:2.7,roundSpreadPercent:1,
    circularity:{latest:7.5,min:6,max:9,rounds:1,maxOppositeDifferencePercent:2.25},
    releasePostReturnPeakPercent:62};
  return {acceptedRounds:1,excludedRounds:0,comparable:true,applied:false,
    left:structuredClone(side),right:structuredClone(side),...overrides};
}
const row=(result,id,side='left')=>result.sticks[side].rows.find(value=>value.id===id);

test('keeps five metric rows distinct with percentage point changes',()=>{
  const before=summary(),after=summary();
  Object.assign(after.left,{observedPeakPercent:4.23,suggestedDeadzonePercent:6,releasePostReturnPeakPercent:40});
  Object.assign(after.left.circularity,{latest:5.2,maxOppositeDifferencePercent:3.01});
  const result=calibrationDiagnostics({before,after});
  assert.equal(result.available,true);assert.equal(result.complete,true);
  assert.deepEqual(result.sticks.left.rows.map(({id,before,after,delta,unit,direction})=>({id,before,after,delta,unit,direction})),[
    {id:'quiet_peak',before:3.12,after:4.23,delta:1.11,unit:'%',direction:'higher'},
    {id:'deadzone',before:5,after:6,delta:1,unit:'%',direction:'higher'},
    {id:'circularity',before:7.5,after:5.2,delta:-2.3,unit:'%',direction:'lower'},
    {id:'symmetry',before:2.25,after:3.01,delta:.76,unit:'%',direction:'higher'},
    {id:'release_peak',before:62,after:40,delta:-22,unit:'%',direction:'lower'},
  ]);
  for(const side of ['left','right'])for(const value of result.sticks[side].rows) {
    assert.equal(typeof value.label,'string');assert.ok(value.label.length>0);
    assert.deepEqual(Object.keys(value).sort(),['after','before','delta','direction','id','label','unit']);
  }
  assert.deepEqual(row(result,'quiet_peak','right'),{
    id:'quiet_peak',label:row(result,'quiet_peak','right').label,before:3.12,after:3.12,delta:0,unit:'%',direction:'unchanged',
  });
  assert.ok(result.sticks.left.notices.some(value=>/quiet peak.*higher/i.test(value)));
  assert.ok(result.sticks.left.notices.some(value=>/opposite.*difference.*higher/i.test(value)));
});

test('missing or malformed comparison retains rows without invented zeroes',()=>{
  for(const input of [undefined,null,false,5,'private-string',[],{}, {before:null,after:[]}]) {
    const result=calibrationDiagnostics(input);
    assert.equal(result.available,false);assert.equal(result.complete,false);
    for(const side of ['left','right']) {
      assert.deepEqual(result.sticks[side].rows.map(value=>value.id),['quiet_peak','deadzone','circularity','symmetry','release_peak']);
      for(const value of result.sticks[side].rows)assert.deepEqual([value.before,value.after,value.delta,value.direction],[null,null,null,'unavailable']);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
  }
});

test('baseline-only results preserve observed data and withhold every delta',()=>{
  const result=calibrationDiagnostics({before:summary(),after:null});
  assert.equal(result.available,true);assert.equal(result.complete,false);
  assert.equal(row(result,'quiet_peak').before,3.12);
  for(const side of ['left','right'])for(const value of result.sticks[side].rows)
    assert.deepEqual([value.after,value.delta,value.direction],[null,null,'unavailable']);
});

test('incompatible or unaccepted summaries cannot supply apparent measurements',()=>{
  for(const override of [{comparable:false},{comparable:'true'},{acceptedRounds:0},{acceptedRounds:-1},
    {acceptedRounds:1.5},{acceptedRounds:'1'},{acceptedRounds:11},{acceptedRounds:Infinity}]) {
    const result=calibrationDiagnostics({before:summary(),after:summary(override)});
    assert.equal(result.complete,false);
    for(const side of ['left','right'])for(const value of result.sticks[side].rows)
      assert.deepEqual([value.after,value.delta,value.direction],[null,null,'unavailable']);
  }
});

test('invalid individual measurements stay null without hiding independent metrics',()=>{
  for(const bad of [undefined,null,'0','8',true,false,NaN,Infinity,-Infinity,-.01,150.01,{},[]]) {
    const after=summary();
    after.left.observedPeakPercent=bad;after.left.circularity.latest=bad;
    after.left.circularity.maxOppositeDifferencePercent=bad;after.left.releasePostReturnPeakPercent=bad;
    const result=calibrationDiagnostics({before:summary(),after});
    for(const id of ['quiet_peak','circularity','symmetry','release_peak'])
      assert.deepEqual([row(result,id).after,row(result,id).delta,row(result,id).direction],[null,null,'unavailable']);
    assert.equal(row(result,'deadzone').after,5);assert.equal(row(result,'quiet_peak','right').after,3.12);
    assert.equal(result.complete,false);
  }
});

test('candidate validation uses its own ceiling and reliable evidence flag',()=>{
  for(const bad of [null,'5',NaN,-1,20.01,150]) {
    const after=summary();after.left.suggestedDeadzonePercent=bad;
    const result=calibrationDiagnostics({before:summary(),after});
    assert.equal(row(result,'deadzone').after,null);assert.equal(row(result,'quiet_peak').after,3.12);
  }
  const after=summary();after.left.reliable=false;
  assert.equal(row(calibrationDiagnostics({before:summary(),after}),'deadzone').after,null);
});

test('zero and upper endpoints are measured numbers rather than missing evidence',()=>{
  const before=summary(),after=summary();
  Object.assign(before.left,{observedPeakPercent:0,suggestedDeadzonePercent:0,releasePostReturnPeakPercent:0});
  Object.assign(before.left.circularity,{latest:0,maxOppositeDifferencePercent:0});
  Object.assign(after.left,{observedPeakPercent:150,suggestedDeadzonePercent:20,releasePostReturnPeakPercent:150});
  Object.assign(after.left.circularity,{latest:150,maxOppositeDifferencePercent:150});
  const result=calibrationDiagnostics({before,after});
  assert.equal(result.complete,true);
  assert.deepEqual(result.sticks.left.rows.map(value=>value.before),[0,0,0,0,0]);
  assert.deepEqual(result.sticks.left.rows.map(value=>value.delta),[150,20,150,150,150]);
});

test('deltas round once and tiny changes do not produce signed zero or a false direction',()=>{
  const before=summary(),after=summary();
  before.left.circularity.latest=1.004;after.left.circularity.latest=1.006;
  before.right.circularity.latest=1;after.right.circularity.latest=.999;
  const result=calibrationDiagnostics({before,after});
  assert.deepEqual([row(result,'circularity').before,row(result,'circularity').after,row(result,'circularity').delta],[1.004,1.006,0]);
  assert.equal(row(result,'circularity').direction,'unchanged');
  assert.equal(Object.is(row(result,'circularity','right').delta,-0),false);
});

test('partial circularity does not borrow min or max as the latest value',()=>{
  const after=summary();after.left.circularity.latest=null;
  const result=calibrationDiagnostics({before:summary(),after});
  assert.equal(row(result,'circularity').after,null);assert.equal(row(result,'symmetry').after,2.25);
  assert.equal(row(result,'release_peak').after,62);
  for(const malformed of [null,[],{latest:7.5}]) {
    after.left.circularity=malformed;
    const next=calibrationDiagnostics({before:summary(),after});
    assert.equal(row(next,'symmetry').after,null);
  }
});

test('a missing stick cannot borrow the other stick metrics',()=>{
  const result=calibrationDiagnostics({before:summary(),after:summary({left:null})});
  for(const value of result.sticks.left.rows)assert.equal(value.after,null);
  assert.equal(row(result,'release_peak','right').after,62);assert.equal(result.complete,false);
});

test('comparison guidance describes evidence without an optimum or save verdict',()=>{
  const after=summary();after.left.circularity.latest=0;
  const result=calibrationDiagnostics({before:summary(),after});
  assert.match(result.note,/observed/i);assert.match(result.note,/stock.like/i);
  assert.match(result.note,/symmetry/i);assert.match(result.note,/lower.*RMS.*not.*universal optimum/i);
  assert.match(result.note,/motion.*release/i);assert.match(result.note,/deadzone.*not applied/i);
  assert.doesNotMatch(JSON.stringify(result),/improved|healthScore|recommendSave|safe to save|must save|block save/i);
});

test('output allows only fixed descriptive text and numeric metrics without mutating input',()=>{
  const marker='PRIVATE-IDENTITY-PATH-TOKEN';
  const before=summary({note:marker,reason:marker,controller:{serialNumber:marker,path:marker},id:marker});
  before.left.reason=marker;before.left.circularity.note=marker;
  before.left.observedPeakPercent=marker;before.left.extra={message:marker};
  const input={before,after:summary(),note:marker,reviewId:marker},copy=structuredClone(input);
  const result=calibrationDiagnostics(input);
  assert.doesNotMatch(JSON.stringify(result),new RegExp(marker));
  assert.deepEqual(input,copy);assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
  assert.deepEqual(Object.keys(result).sort(),['available','complete','note','sticks']);
});
