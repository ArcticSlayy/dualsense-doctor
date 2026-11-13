// Read-only projections. Local identity remains a selection key, never a display label.
import {opendir, lstat, open} from 'node:fs/promises';
import {join} from 'node:path';
import {compareSessionReports} from './session-comparison.js';
import {assessStickTuning} from './stick-tuning.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES=new Set(['usb','bt','bt-compat']);
const PHASES=new Set(['rest','range','release','buttons','verify']);
const MAX_ENTRIES=256,MAX_FILES=64,MAX_BYTES=2*1024*1024,MAX_CAPTURES=2048;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const percent=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=150?value:null;
const integer=value=>Number.isInteger(value)&&value>=0?value:null;
const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const quality=m=>m?.valid===true&&MODES.has(m.mode)&&Number.isInteger(m.samples)&&m.samples>=50&&Number.isFinite(m.durationMs)&&m.durationMs>=1000&&Number.isFinite(m.maxGapMs)&&m.maxGapMs>=0&&m.maxGapMs<=250;
function sideSummary(value) {
  if(!object(value))return null;
  const circularity=object(value.circularity)?{min:percent(value.circularity.min),max:percent(value.circularity.max),latest:percent(value.circularity.latest),rounds:integer(value.circularity.rounds),maxOppositeDifferencePercent:percent(value.circularity.maxOppositeDifferencePercent)}:null;
  return {observedPeakPercent:percent(value.observedPeakPercent),suggestedDeadzonePercent:value.reliable===true?percent(value.suggestedDeadzonePercent):null,worstP99Percent:percent(value.worstP99Percent),roundSpreadPercent:percent(value.roundSpreadPercent),reliable:value.reliable===true,circularity,releasePostReturnPeakPercent:percent(value.releasePostReturnPeakPercent)};
}
function geometry(capture,side) {
  const empty={available:false,complete:false,coveredSectors:0,totalSectors:48,sectorRadii:null,scaleMax:1.5,captureNumber:null};
  const value=capture?.metrics?.[side],c=value?.circularity;
  if(!quality(capture?.metrics)||value?.valid!==true||c?.totalSectors!==48||!Array.isArray(c.sectorRadii)||c.sectorRadii.length!==48)return empty;
  // Existing circularity considers only radii >0.2 observed. Zero is a missing
  // sector, never a healthy zero-radius measurement. Gaps must break draw paths.
  const sectorRadii=Array.from(c.sectorRadii,r=>typeof r==='number'&&Number.isFinite(r)&&r>.2&&r<=1.5?r:null);
  const coveredSectors=sectorRadii.filter(r=>r!==null).length;
  return {...empty,available:coveredSectors>0,complete:coveredSectors===48,coveredSectors,sectorRadii,captureNumber:capture.number};
}

/** One selected check only: no history averaging, cross-epoch pooling, or writes.
 * A raw session has no `complete` field; the comparator validates its full evidence.
 * An explicitly incomplete report remains incomplete. Calibration status is only
 * this app's local record, not proof of equal calibration across historical checks.
 */
export function projectSessionInsights(report) {
  const input=object(report)?report:{};
  const actions=input.calibrationActions??[];
  const epoch=Array.isArray(actions)&&actions.length<=128&&actions.every(a=>object(a)&&typeof a.at==='string'&&a.at.trim())?actions.length:null;
  const captures=Array.isArray(input.captures)&&input.captures.length<=MAX_CAPTURES?input.captures:null;
  let summary=null;
  if(epoch!==null&&captures) {
    try {summary=compareSessionReports([{...input,complete:input.complete===undefined?true:input.complete}]);} catch {}
  }
  const comparable=summary?.comparable===true&&summary.acceptedRounds===1;
  const current=epoch!==null&&captures?captures.filter(c=>object(c)&&PHASES.has(c.phase)&&(c.calibrationEpoch??0)===epoch):[];
  const ordered=current.every(c=>Number.isInteger(c.number)&&c.number>0)&&new Set(current.map(c=>c.number)).size===current.length;
  const modes=new Set(current.map(c=>c.metrics?.mode));
  const transport=modes.size===1&&MODES.has([...modes][0])?[...modes][0]:null;
  const range=ordered&&transport?current.filter(c=>c.phase==='range').sort((a,b)=>a.number-b.number).at(-1):null;
  let status=epoch===null?'unknown':epoch?'temporary_attempted':'none_recorded';
  const persistence=input.calibrationPersistence;
  if(epoch!==null&&object(persistence)&&persistence.epoch===epoch&&['pending','ambiguous','save_acknowledged','verified'].includes(persistence.status))status=persistence.status;
  return {id:typeof input.id==='string'&&UUID.test(input.id)?input.id:null,created:iso(input.created),complete:comparable,comparable,transport,
    calibration:{epoch,status,source:'this_app'},
    comparison:{acceptedRounds:comparable?1:0,comparable,left:comparable?sideSummary(summary.left):null,right:comparable?sideSummary(summary.right):null},
    range:{left:geometry(range,'left'),right:geometry(range,'right')},tuning:assessStickTuning({...input,complete:input.complete===undefined?true:input.complete})};
}

/** Explicit-request history reader. Work is bounded: at most 256 root entries,
 * 64 session files, 2 MiB/file and 2048 captures/session; output is capped at 10.
 * Candidates inside that scan window are tried by mtime, then valid output is
 * sorted by recorded creation time. `truncated` means older checks may be omitted.
 * Uses async filesystem calls only; never call from the high-frequency snapshot.
 */
export async function readSessionHistory(store,{limit=10}={}) {
  const count=Number.isInteger(limit)?Math.max(1,Math.min(10,limit)):10;
  const sessions=[];let skipped=false,truncated=false;
  if(typeof store?.root!=='string'||!store.root)return {sessions,truncated,notice:'Saved checks are unavailable.'};
  const candidates=[];
  try {
    const directory=await opendir(store.root);let scanned=0;
    try {
      while(scanned<MAX_ENTRIES) {
        const entry=await directory.read();if(!entry)break;scanned++;
        if(!UUID.test(entry.name)||!entry.isDirectory())continue;
        const file=join(store.root,entry.name,'session.json');
        try {const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES){skipped=true;continue;}candidates.push({id:entry.name,file,modified:stat.mtimeMs});}catch{skipped=true;}
      }
      if(scanned===MAX_ENTRIES)truncated=true;
    } finally {await directory.close();}
  } catch {return {sessions:[],truncated:false,notice:'Saved checks are unavailable.'};}
  candidates.sort((a,b)=>b.modified-a.modified||a.id.localeCompare(b.id));
  if(candidates.length>MAX_FILES)truncated=true;
  for(const candidate of candidates.slice(0,MAX_FILES)) {
    let handle;
    try {
      handle=await open(candidate.file,'r');const stat=await handle.stat();
      if(!stat.isFile()||stat.size>MAX_BYTES)throw Error('Unavailable');
      const buffer=Buffer.alloc(Math.min(MAX_BYTES+1,stat.size+1));let bytes=0;
      while(bytes<buffer.length){const read=await handle.read(buffer,bytes,buffer.length-bytes,null);if(!read.bytesRead)break;bytes+=read.bytesRead;}
      if(bytes>MAX_BYTES||bytes>stat.size)throw Error('Unavailable');
      const raw=JSON.parse(buffer.subarray(0,bytes).toString('utf8'));
      if(!object(raw)||raw.id!==candidate.id||!Array.isArray(raw.captures)||raw.captures.length>MAX_CAPTURES)throw Error('Unavailable');
      const projected=projectSessionInsights(raw);if(!projected.id||!projected.created)throw Error('Unavailable');sessions.push(projected);
    } catch {skipped=true;} finally {if(handle)await handle.close().catch(()=>{});}
  }
  sessions.sort((a,b)=>b.created.localeCompare(a.created)||a.id.localeCompare(b.id));
  if(sessions.length>count)truncated=true;
  return {sessions:sessions.slice(0,count),truncated,notice:skipped?'Some saved checks could not be read.':null};
}
