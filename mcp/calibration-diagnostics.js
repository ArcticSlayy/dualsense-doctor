// Pure display projection of sanitized session-comparison summaries.
// Numeric limits validate the input contract; they are not hardware thresholds.
const SIDES=['left','right'];
const NOTE='These are observed before and after measurements, not a verdict on calibration quality or whether to save. Deltas are percentage points. Compare circularity with stock-like response and range symmetry; lower circularity RMS is not a universal optimum. Differing motion can affect release peaks. The game deadzone starting candidate is not applied by this review.';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const percent=(value,max=150)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=max?value:null;
const rounded=value=>Math.round(value*100)/100||0;
const METRICS=[
  {id:'quiet_peak',label:'Observed quiet peak',read:side=>percent(side.observedPeakPercent)},
  {id:'deadzone',label:'Game deadzone starting candidate',read:side=>side.reliable===true?percent(side.suggestedDeadzonePercent,20):null},
  {id:'circularity',label:'Circularity RMS',read:side=>object(side.circularity)?percent(side.circularity.latest):null},
  {id:'symmetry',label:'Opposite-direction range difference',read:side=>object(side.circularity)?percent(side.circularity.maxOppositeDifferencePercent):null},
  {id:'release_peak',label:'Post-return release peak',read:side=>percent(side.releasePostReturnPeakPercent)},
];

function accepted(summary) {
  return object(summary)&&summary.comparable===true&&Number.isInteger(summary.acceptedRounds)
    &&summary.acceptedRounds>=1&&summary.acceptedRounds<=10?summary:null;
}
function measurement(summary,side,metric) {
  return object(summary?.[side])?metric.read(summary[side]):null;
}

/** Missing values remain null, including an absent post-trial summary.
 * available: at least one validated measurement is present.
 * complete: all five rows for both sticks have a before and after value.
 * direction: arithmetic change at displayed delta precision, never a quality score.
 */
export function calibrationDiagnostics(comparison) {
  const before=accepted(object(comparison)?comparison.before:null);
  const after=accepted(object(comparison)?comparison.after:null);
  const sticks={};let available=false,complete=true;
  for(const side of SIDES) {
    const rows=METRICS.map(metric=>{
      const a=measurement(before,side,metric),b=measurement(after,side,metric);
      const delta=a!==null&&b!==null?rounded(b-a):null;
      available||=a!==null||b!==null;complete&&=delta!==null;
      return {id:metric.id,label:metric.label,before:a,after:b,delta,unit:'%',
        direction:delta===null?'unavailable':delta<0?'lower':delta>0?'higher':'unchanged'};
    });
    const notices=[];
    if(rows[0].direction==='higher')notices.push('Observed quiet peak was higher after the trial.');
    if(rows[3].direction==='higher')notices.push('Opposite-direction range difference was higher after the trial.');
    sticks[side]={rows,notices};
  }
  return {available,complete,note:NOTE,sticks};
}
