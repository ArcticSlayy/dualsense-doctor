// Pure analysis of recorded parsed input. No hardware access, output or calibration.
// Thresholds describe capture evidence, not manufacturer limits or physical health.
const MODES = new Set(['usb','bt','bt-compat']);
const MAX_SAMPLES = 30000;
const RELEASED = 5;
const PRESSED = 250;
const MIN_LEG_MS = 500;
const NOTE = 'Observed analog travel only. Slow ordered sweeps are capture evidence; they do not establish mechanical health, force, smoothness, latency or calibration.';
const raw = value => Number.isInteger(value) && value>=0 && value<=255;

function newLeg(value,t) {
  return {startAt:t,lastAt:t,previous:value,bins:new Set(),reverseRaw:0,maxStepRaw:0};
}
function advanceLeg(leg,value,t,direction) {
  const delta=value-leg.previous;
  leg.reverseRaw+=Math.max(0,-direction*delta);
  leg.maxStepRaw=Math.max(leg.maxStepRaw,Math.abs(delta));
  if(value>RELEASED && value<PRESSED)leg.bins.add(Math.floor((value-6)*8/244));
  leg.previous=value;leg.lastAt=t;
}
function slowLeg(leg) {
  return leg.lastAt-leg.startAt>=MIN_LEG_MS && leg.bins.size===8 && leg.reverseRaw<=12 && leg.maxStepRaw<=64;
}

function cycleEvidence(frames,axis) {
  let state='waiting',releasedAt=null,pressedAt=null,previous=null,up=null,down=null;
  let completed=0,slowSweeps=0,fastCycles=0,finalReleaseAt=null;
  for(const frame of frames) {
    const value=frame[axis],t=frame.t;
    if(value<=RELEASED) {if(finalReleaseAt===null)finalReleaseAt=t;}
    else finalReleaseAt=null;
    if(state==='waiting') {
      if(value<=RELEASED){state='released';releasedAt=t;}
    } else if(state==='released') {
      if(value<=RELEASED)releasedAt=t;
      else {
        up=newLeg(previous,releasedAt);advanceLeg(up,value,t,1);state='rising';
        if(value>=PRESSED){state='pressed';pressedAt=t;}
      }
    } else if(state==='rising') {
      advanceLeg(up,value,t,1);
      if(value<=RELEASED){state='released';releasedAt=t;}
      else if(value>=PRESSED){state='pressed';pressedAt=t;}
    } else if(state==='pressed') {
      if(value>=PRESSED)pressedAt=t;
      else {down=newLeg(previous,pressedAt);advanceLeg(down,value,t,-1);state='falling';}
    } else advanceLeg(down,value,t,-1);
    if(state==='falling' && value<=RELEASED) {
      completed++;
      if(slowLeg(up) && slowLeg(down))slowSweeps++;
      if(up.lastAt-up.startAt<MIN_LEG_MS || down.lastAt-down.startAt<MIN_LEG_MS)fastCycles++;
      state='released';releasedAt=t;
    }
    previous=value;
  }
  return {
    cycles:{completed,slowSweeps,fastCycles},
    return:{observed:completed>0,count:completed,lastValue:frames.at(-1)[axis],
      finalReleased:finalReleaseAt!==null,finalReleaseHoldMs:finalReleaseAt===null?null:frames.at(-1).t-finalReleaseAt},
  };
}

/**
 * Analyze an explicitly captured trigger sweep using parsed {t,mode,l2,r2} frames.
 * t is elapsed milliseconds in recorded order; modes must remain usb/bt/bt-compat.
 * Invalid analog values make that trigger unavailable (never filtered/coerced).
 * Timing/transport faults retain observed endpoints but withhold cycle evidence.
 * Capture limits: 50..30000 reports, >=1s duration, no gap above 250ms.
 * A slow sweep requires release -> press -> release, >=500ms per moving leg,
 * all eight intermediate travel bands, <=12 reverse counts and no jump above 64.
 * These empirical capture rules neither identify intent nor diagnose a defect.
 */
export function analyzeTriggerSweep(frames) {
  const isArray=Array.isArray(frames),sampleCount=isArray?frames.length:0;
  const bounded=isArray && sampleCount>0 && sampleCount<=MAX_SAMPLES;
  const reasons=[];
  if(!isArray)reasons.push('capture_not_array');
  else if(!sampleCount)reasons.push('capture_empty');
  else if(sampleCount>MAX_SAMPLES)reasons.push('capture_too_large');
  let timeValid=bounded,modeValid=bounded,mode=null,maxGapMs=0;
  if(bounded) {
    mode=frames[0]?.mode;
    for(let i=0;i<sampleCount;i++) {
      const frame=frames[i];
      if(!Number.isFinite(frame?.t) || frame.t<0 || (i>0 && (!Number.isFinite(frames[i-1]?.t) || frame.t<=frames[i-1].t)))timeValid=false;
      if(i>0 && Number.isFinite(frame?.t) && Number.isFinite(frames[i-1]?.t))maxGapMs=Math.max(maxGapMs,frame.t-frames[i-1].t);
      if(!MODES.has(frame?.mode) || frame.mode!==mode)modeValid=false;
    }
    if(!timeValid)reasons.push('invalid_timebase');
    if(!modeValid)reasons.push('missing_or_changing_transport');
  }
  const durationMs=timeValid?frames.at(-1).t-frames[0].t:null;
  if(bounded && (sampleCount<50 || (timeValid && durationMs<1000)))reasons.push('insufficient_capture');
  if(timeValid && maxGapMs>250)reasons.push('input_gap');
  const quality={available:reasons.length===0,mode:modeValid?mode:null,durationMs,maxGapMs:timeValid?maxGapMs:null,reasons};
  const triggers={};
  for(const axis of ['l2','r2']) {
    let validSamples=0,min=255,max=0;
    if(bounded)for(const frame of frames)if(raw(frame?.[axis])){validSamples++;min=Math.min(min,frame[axis]);max=Math.max(max,frame[axis]);}
    const available=bounded && validSamples===sampleCount;
    const observed=available?{min,max,first:frames[0][axis],last:frames.at(-1)[axis]}:null;
    const temporal=available && quality.available?cycleEvidence(frames,axis):{cycles:null,return:null};
    triggers[axis]={available,sampleCount:validSamples,observed,
      travel:available?{releasedObserved:min<=RELEASED,pressedObserved:max>=PRESSED}:null,...temporal};
  }
  return {kind:'trigger-sweep',sampleCount,quality,triggers,note:NOTE};
}
