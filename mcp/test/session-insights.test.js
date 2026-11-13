import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {projectSessionInsights, readSessionHistory} from '../session-insights.js';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function report(n=1) {
  const captures=['rest','range','release','buttons','verify'].map((phase,i)=>({number:i+1,phase,calibrationEpoch:0,metrics:{valid:true,mode:'usb',samples:250,durationMs:5000,maxGapMs:20,left:{valid:true,peakRadiusPercent:3,p99RadiusPercent:2},right:{valid:true,peakRadiusPercent:4,p99RadiusPercent:3}}}));
  for(const side of ['left','right'])captures[1].metrics[side]={valid:true,circularity:{coveredSectors:48,totalSectors:48,errorPercent:7,maxOppositeDifferencePercent:2,sectorRadii:Array(48).fill(1.1)}};
  return {id:id(n),created:`2026-11-${String(n).padStart(2,'0')}T12:00:00.000Z`,complete:true,controller:{productId:3302,serialNumber:'PRIVATE_SERIAL',path:'PRIVATE_PATH'},captures};
}

test('insights whitelist numeric evidence and fixed labels without exporting provenance',()=>{
  const input=report();Object.assign(input,{goal:'PRIVATE_GOAL',logPath:'PRIVATE_LOG',note:'PRIVATE_NOTE'});
  input.calibrationPersistence={epoch:0,status:'verified',lastSavedAt:'PRIVATE_DATE'};
  const result=projectSessionInsights(input);
  assert.equal(result.id,id(1));assert.equal(result.created,input.created);assert.equal(result.complete,true);assert.equal(result.comparable,true);assert.equal(result.transport,'usb');
  assert.equal(result.calibration.status,'verified');assert.equal(result.calibration.source,'this_app');
  assert.equal(result.comparison.left.suggestedDeadzonePercent,4);
  assert.equal(result.range.left.scaleMax,1.5);assert.equal(result.range.left.complete,true);assert.equal(result.range.left.captureNumber,2);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|serial|path|goal|words|logPath/);
  assert.deepEqual(input.captures[1].metrics.left.circularity.sectorRadii,Array(48).fill(1.1));
});

test('geometry preserves partial gaps instead of joining or filling invalid bins',()=>{
  const input=report(),c=input.captures[1].metrics.left.circularity;
  c.sectorRadii[0]=0;c.sectorRadii[1]=null;c.sectorRadii[2]=Infinity;c.sectorRadii[3]=1.6;c.sectorRadii[4]='1';c.sectorRadii[5]=.2;
  c.coveredSectors=42;c.errorPercent=null;
  const range=projectSessionInsights(input).range.left;
  assert.equal(range.available,true);assert.equal(range.complete,false);assert.equal(range.coveredSectors,42);
  assert.deepEqual(range.sectorRadii.slice(0,6),Array(6).fill(null));assert.equal(range.sectorRadii[6],1.1);
});

test('latest current epoch wins without pooling old or favorable range evidence',()=>{
  const input=report();input.calibrationActions=[{at:'2026-11-01T12:00:00Z',kind:'center',checkpointPath:'PRIVATE_CHECKPOINT'}];
  for(const capture of input.captures)capture.calibrationEpoch=1;
  const old=structuredClone(input.captures[1]);old.number=0;old.calibrationEpoch=0;old.metrics.left.circularity.sectorRadii=Array(48).fill(1.4);input.captures.unshift(old);
  const latest=structuredClone(input.captures[2]);latest.number=6;latest.metrics.left.circularity.sectorRadii=Array(48).fill(.8);input.captures.push(latest);
  assert.equal(projectSessionInsights(input).range.left.sectorRadii[0],.8);assert.equal(projectSessionInsights(input).range.left.captureNumber,6);
  latest.metrics.valid=false;
  assert.equal(projectSessionInsights(input).range.left.available,false);
  assert.equal(projectSessionInsights(input).comparable,false);
});

test('geometry rejects malformed shape, quality and mixed transports without reviving old captures',()=>{
  for(const change of [r=>r.captures[1].metrics.maxGapMs=251,r=>r.captures[1].metrics.left.valid=false,r=>r.captures[1].metrics.left.circularity.sectorRadii.pop(),r=>r.captures[4].metrics.mode='bt',r=>r.captures[1].number=1]) {
    const input=report();change(input);assert.equal(projectSessionInsights(input).range.left.available,false);
  }
  const input=report();input.captures[1].metrics.left.circularity.sectorRadii=new Array(48);const value=projectSessionInsights(input).range.left;
  assert.equal(value.complete,false);assert.deepEqual(value.sectorRadii,Array(48).fill(null));
});

test('history bounds directory work even when the root has more than 256 entries',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dualsense-insights-'));
  try {
    await Promise.all(Array.from({length:257},(_,n)=>mkdir(join(root,`ignored-${n}`))));
    const history=await readSessionHistory({root});assert.deepEqual(history,{sessions:[],truncated:true,notice:null});
  } finally {await rm(root,{recursive:true,force:true});}
});

test('malformed identity, dates, epochs and missing geometry remain unavailable',()=>{
  const input=report();input.id='PRIVATE_ID';input.created='PRIVATE_DATE';input.calibrationActions='PRIVATE_ACTIONS';
  const result=projectSessionInsights(input);assert.equal(result.id,null);assert.equal(result.created,null);assert.equal(result.calibration.epoch,null);assert.equal(result.calibration.status,'unknown');assert.equal(result.comparable,false);assert.equal(result.range.left.available,false);
  const missing=report();delete missing.captures[1].metrics.left.circularity.sectorRadii;
  assert.equal(projectSessionInsights(missing).range.left.available,false);
  const bad=report();bad.complete=false;assert.equal(projectSessionInsights(bad).complete,false);
});

test('history reads raw saved sessions asynchronously, sorts by date, caps output and skips corruption',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dualsense-insights-'));
  try {
    for(let n=1;n<=12;n++){await mkdir(join(root,id(n)));const session=report(n);delete session.complete;await writeFile(join(root,id(n),'session.json'),JSON.stringify(session));}
    await mkdir(join(root,id(13)));await writeFile(join(root,id(13),'session.json'),'PRIVATE_CORRUPT_JSON');
    await mkdir(join(root,id(14)));await writeFile(join(root,id(14),'session.json'),' '.repeat(2*1024*1024+1));
    const history=await readSessionHistory({root,list(){throw Error('sync list forbidden');},report(){throw Error('sync report forbidden');}},{limit:50});
    assert.equal(history.sessions.length,10);assert.equal(history.sessions[0].id,id(12));assert.equal(history.sessions[9].id,id(3));assert.equal(history.sessions[0].complete,true);assert.equal(history.truncated,true);
    assert.equal(history.notice,'Some saved checks could not be read.');assert.doesNotMatch(JSON.stringify(history),/PRIVATE_|dualsense-insights-/);
    const small=await readSessionHistory({root},{limit:2});assert.equal(small.sessions.length,2);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('history rejects mismatched directory identity and returns fixed root errors',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dualsense-insights-'));
  try {
    await mkdir(join(root,id(1)));await writeFile(join(root,id(1),'session.json'),JSON.stringify(report(2)));
    const history=await readSessionHistory({root});assert.equal(history.sessions.length,0);assert.equal(history.notice,'Some saved checks could not be read.');
    const missing=await readSessionHistory({root:join(root,'PRIVATE_MISSING')});assert.deepEqual(missing,{sessions:[],truncated:false,notice:'Saved checks are unavailable.'});
  } finally {await rm(root,{recursive:true,force:true});}
});


test('history includes a numeric directional assessment without inventing legacy quiet detail',()=>{
 const input=report();input.captures[1].metrics.left.limits={lx:{min:0,max:255},ly:{min:0,max:255}};
  input.captures[1].metrics.left.circularity.sectorRadii=Array(48).fill(1);
 const result=projectSessionInsights(input);
 assert.equal(result.tuning.available,true);assert.equal(result.tuning.sticks.left.range.available,true);
 assert.equal(result.tuning.sticks.left.range.leftPercent,100);
 assert.equal(result.tuning.sticks.left.center.available,false);
 assert.doesNotMatch(JSON.stringify(result.tuning),/PRIVATE_|serial|path|goal|words|logPath/);
});
