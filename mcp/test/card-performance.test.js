import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../coach-card.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1].replaceAll('__API_BASE__','http://127.0.0.1:27892').replaceAll('__TOKEN__','test-token');
function setup({storedPreferences,blockedStorage=false,controlResponse,controlError,deferUi=false,reducedMotion=false}={}){
  let now=1000,nextId=1;const frames=new Map(),intervals=new Map(),listeners=new Map(),requests=[],timeouts=[],nodes=new Map(),storage=new Map(),downloads=[],canvasWrites=[];
  const drawing={measureText:value=>({width:String(value).length*11}),fillText:(...args)=>canvasWrites.push(args)};for(const method of ['fillRect','beginPath','arc','stroke','moveTo','lineTo','setLineDash','fill'])drawing[method]=()=>{};
  if(storedPreferences)storage.set('dualsense-coach-display',JSON.stringify(storedPreferences));
  for(const match of html.matchAll(/\bid="([^"]+)"/g))nodes.set(match[1],{textContent:'',attributes:{},writes:[],style:{},dataset:{},disabled:false,hidden:false,value:'',checked:false,listeners:new Map(),getAttribute(k){return this.attributes[k]??null;},setAttribute(k,v){this.attributes[k]=String(v);this.writes.push([k,String(v)]);},addEventListener(name,fn){this.listeners.set(name,fn);}});
  class EventSource{constructor(){this.closed=false;}addEventListener(){}close(){this.closed=true;}}
  const context=vm.createContext({document:{createElement:tag=>tag==='canvas'?{getContext:()=>drawing,toDataURL:()=> 'data:image/png;base64,c3ludGhldGlj'}:{click(){downloads.push({href:this.href,download:this.download});}},getElementById:id=>{assert.ok(nodes.has(id),id);return nodes.get(id);}},performance:{now:()=>now},URL,AbortSignal:{timeout:ms=>{timeouts.push(ms);return AbortSignal.timeout(ms);}},
    requestAnimationFrame:fn=>{const id=nextId++;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id),
    setInterval:(fn,ms)=>{const id=nextId++;intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id),
    EventSource,fetch:(url,options)=>{requests.push({url:String(url),options});if(String(url).includes('/control')&&controlError)return Promise.reject(controlError);if(String(url).includes('/control')&&controlResponse)return Promise.resolve({ok:controlResponse.ok!==false,json:async()=>controlResponse.body??{connected:true,status:'idle'}});return new Promise(()=>{});},
    localStorage:{getItem(key){if(blockedStorage)throw Error('storage blocked');return storage.get(key)??null;},setItem(key,value){if(blockedStorage)throw Error('storage blocked');storage.set(key,String(value));}},
    window:{addEventListener:(name,fn)=>listeners.set(name,fn),matchMedia:()=>({matches:reducedMotion})},console});
  vm.runInContext(script,context);
  const input=(lx=128)=>({connected:true,status:'idle',latest:{lx,ly:128,rx:128,ry:128,mode:'usb'},ageMs:0,instruction:'Move the sticks',progress:0,details:{}});
  return {context,nodes,frames,intervals,listeners,requests,timeouts,input,storage,downloads,canvasWrites,change(id,value){const node=nodes.get(id);assert.ok(node,id);if(typeof value==='boolean')node.checked=value;else node.value=value;node.listeners.get('change')?.({target:node});},click(id){nodes.get(id).listeners.get('click')?.();},accept(s){context.input=s;vm.runInContext("accept(input,'sse')",context);if(!deferUi)vm.runInContext("renderState()",context);},step(ms=16){now+=ms;const pending=[...frames.values()];frames.clear();for(const fn of pending)fn(now);},at(value){now=value;}};
}

test('multiple feed updates coalesce into one animation-frame plot update',()=>{
 const run=setup(),dot=run.nodes.get('left-dot');
 run.accept(run.input(160));run.accept(run.input(200));run.accept(run.input(240));
 assert.equal(dot.writes.filter(([k])=>k==='cx').length,0);
 assert.equal(run.frames.size,1);run.step();
 assert.equal(dot.writes.filter(([k])=>k==='cx').length,1);
 assert.equal(run.nodes.get('instruction').textContent,'Move the sticks');
});
test('raw numeric readings are throttled while stick dots continue at frame rate',()=>{
 const run=setup();run.accept(run.input(160));run.step();
 const initial=run.nodes.get('left-values').textContent;
 run.accept(run.input(240));run.step();assert.equal(run.nodes.get('left-values').textContent,initial);
 run.step(100);assert.match(run.nodes.get('left-values').textContent,/\+0\.88/);
});
test('stale input neutralizes dots and trails within300ms',()=>{
 const run=setup();run.accept(run.input(240));run.step();assert.equal(run.nodes.get('left-dot').attributes.visibility,'visible');
 run.step(285);assert.equal(run.nodes.get('left-dot').attributes.visibility,'hidden');
 assert.equal(run.nodes.get('left-trail').attributes.points,'');
});
test('unchanged samples avoid redundant SVG and progress aria writes',()=>{
 const run=setup();const s=run.input(160);run.accept(s);run.step();
 const dot=run.nodes.get('left-dot'),trail=run.nodes.get('left-trail'),progress=run.nodes.get('progress');
 const counts=[dot.writes.length,trail.writes.length,progress.writes.length];
 for(let i=0;i<5;i++){run.accept(s);run.step();}
 assert.deepEqual([dot.writes.length,trail.writes.length,progress.writes.length],counts);
});
test('pagehide stops frame loop, timers, stream and further polling',async()=>{
 const run=setup();run.accept(run.input());run.step();
 run.listeners.get('pagehide')();assert.equal(run.frames.size,0);assert.equal(run.intervals.size,0);
 const before=run.requests.length;await vm.runInContext('poll()',run.context);assert.equal(run.requests.length,before);
});
test('a card restored from browser cache reconnects and has exactly one frame loop',()=>{
  const run=setup();run.listeners.get('pagehide')();assert.equal(run.frames.size,0);
  assert.ok(run.listeners.has('pageshow'));run.listeners.get('pageshow')({persisted:true});
  assert.equal(run.frames.size,1);assert.equal(run.intervals.size,2);
  run.listeners.get('pageshow')({persisted:true});assert.equal(run.frames.size,1);assert.equal(run.intervals.size,2);
});
test('fallback polling targets33ms and measured metrics post every5s only with fresh input',async()=>{
 const run=setup();assert.ok([...run.intervals.values()].some(i=>i.ms===33));
 const metricTimer=[...run.intervals.values()].find(i=>i.ms===5000);assert.ok(metricTimer);
 metricTimer.fn();assert.ok(!run.requests.some(r=>r.url.includes('/metrics')));
 run.accept(run.input());run.step();metricTimer.fn();
 const metrics=run.requests.find(r=>r.url.includes('/metrics'));assert.ok(metrics);
 assert.deepEqual(Object.keys(JSON.parse(metrics.options.body)).sort(),['clientAgeMs','fps','receiveHz']);
});
test('checklist reflects complete, current and paused steps without changing its labels',()=>{
 const run=setup(),s=run.input();s.status='paused';s.steps=[{id:'rest',label:'Settle',status:'complete'},{id:'range-clockwise',label:'Clockwise',status:'current'}];run.accept(s);
 assert.equal(run.nodes.get('step-rest').dataset.status,'complete');assert.equal(run.nodes.get('step-range-clockwise').attributes['aria-current'],'step');
 assert.equal(run.nodes.get('step-range-clockwise').dataset.paused,'true');assert.equal(run.nodes.get('step-buttons').dataset.status,'pending');
});
test('10x offscale diagonal stays inside the circle and retains true numeric values',()=>{
 const run=setup(),s=run.input(240);s.latest.ly=240;vm.runInContext('zoom=10',run.context);run.accept(s);run.step();
 const dot=run.nodes.get('left-dot');const r=Math.hypot(Number(dot.attributes.cx)-80,Number(dot.attributes.cy)-59);
 assert.ok(r<=47.01);assert.equal(run.nodes.get('left-detail').textContent,'Outside 10× window');assert.match(run.nodes.get('left-values').textContent,/X \+0\.88   Y \+0\.88/);
});
test('display options bound or hide trails and clear their history',()=>{
 const run=setup();run.change('trail-mode','short');
 for(let i=0;i<80;i++){run.accept(run.input(130+i));run.step();}
 assert.equal(run.nodes.get('left-trail').attributes.points.split(' ').length,40);
 run.click('clear-trail');assert.equal(run.nodes.get('left-trail').attributes.points,'');
 run.change('trail-mode','off');run.accept(run.input(230));run.step();assert.equal(run.nodes.get('left-trail').attributes.points,'');
});
test('focus, center rings, units and performance options change display without altering raw input',()=>{
 const run=setup(),s=run.input(240);s.latest.ly=3;
 run.accept(s);run.change('view-mode','left');run.change('center-rings',false);run.change('number-units','raw');run.change('show-rates',false);run.step();
 assert.equal(run.nodes.get('right-plot').hidden,true);assert.equal(run.nodes.get('left-plot').hidden,false);
 assert.equal(run.nodes.get('plots').dataset.view,'left');assert.equal(run.nodes.get('left-center-ring').attributes.visibility,'hidden');
 assert.equal(run.nodes.get('rates').hidden,true);assert.equal(run.nodes.get('left-values').textContent,'X 240   Y 3');
 assert.equal(s.latest.lx,240);assert.equal(s.latest.ly,3);
});
test('trigger bars and held button counts use actual input and neutralize on stale input',()=>{
 const run=setup(),s=run.input();s.latest.l2=255;s.latest.r2=128;s.latest.buttons=0b100001;
 run.accept(s);run.step();assert.equal(run.nodes.get('l2-fill').style.width,'100%');assert.equal(run.nodes.get('r2-fill').style.width,'50%');
 assert.equal(run.nodes.get('button-count').textContent,'2 held');
 run.step(301);assert.equal(run.nodes.get('l2-fill').style.width,'0%');assert.equal(run.nodes.get('button-count').textContent,'—');
});
test('only whitelisted display preferences persist and blocked storage is harmless',()=>{
 const run=setup({storedPreferences:{trails:'short',view:'right',units:'raw',rings:false,rates:false,token:'private',sessionId:'private'}});
 run.change('trail-mode','long');const saved=JSON.parse(run.storage.get('dualsense-coach-display'));
 assert.deepEqual(Object.keys(saved).sort(),['rates','rings','trails','units','view']);assert.equal(saved.trails,'long');assert.equal(run.nodes.get('view-mode').value,'right');
 const blocked=setup({blockedStorage:true});assert.doesNotThrow(()=>blocked.change('trail-mode','off'));
});

test('lightbar selection and brightness never send a command until Apply',()=>{
 const run=setup();run.accept(run.input());const before=run.requests.length;
 run.click('lightbar-blue');run.change('lightbar-color','#204080');run.change('lightbar-brightness','50');
 assert.equal(run.requests.length,before);assert.ok(!run.storage.has('lightbar'));
 run.click('lightbar-apply');const request=run.requests.find(r=>r.url.includes('/control'));assert.ok(request);
 assert.deepEqual(JSON.parse(request.options.body),{r:16,g:32,b:64,action:'lightbar'});
 assert.equal(run.requests.filter(r=>r.url.includes('/control')).length,1);
 assert.equal(run.nodes.get('lightbar-apply').disabled,true);
});

test('lightbar commands require fresh input and valid selector values',()=>{
 const run=setup();assert.equal(run.nodes.get('lightbar-apply').disabled,true);
 run.accept(run.input());assert.equal(run.nodes.get('lightbar-apply').disabled,false);
 run.change('lightbar-color','not-a-color');run.click('lightbar-apply');
 assert.ok(!run.requests.some(r=>r.url.includes('/control')));assert.match(run.nodes.get('lightbar-status').textContent,/valid color/i);
 run.change('lightbar-color','#ffffff');run.change('lightbar-brightness','101');run.click('lightbar-apply');
 assert.ok(!run.requests.some(r=>r.url.includes('/control')));assert.match(run.nodes.get('lightbar-status').textContent,/brightness/i);
 run.step(301);assert.equal(run.nodes.get('lightbar-apply').disabled,true);
});

test('battery and firmware remain unavailable until reported; effect preferences stay private',()=>{
 const run=setup();run.accept(run.input());
 assert.equal(run.nodes.get('controller-battery').textContent,'Unavailable');assert.equal(run.nodes.get('controller-firmware').textContent,'Unavailable');
 const s=run.input();s.battery={level:75,status:'charging'};s.firmware={build:'Synthetic build'};s.effects={lightbar:{r:10,g:20,b:30,sentAt:'synthetic-time',commandSent:true,deviceConfirmed:false}};run.accept(s);
 assert.equal(run.nodes.get('controller-battery').textContent,'75% · Charging');assert.equal(run.nodes.get('controller-firmware').textContent,'Synthetic build');
 assert.equal(run.nodes.get('lightbar-status').textContent,'Color sent');
 run.change('trail-mode','short');const saved=JSON.parse(run.storage.get('dualsense-coach-display'));
 assert.deepEqual(Object.keys(saved).sort(),['rates','rings','trails','units','view']);
});

test('lightbar errors are clear and a successful reply is described only as sent',async()=>{
 const failed=setup({controlResponse:{ok:false,body:{error:'Synthetic controller unavailable'}}});failed.accept(failed.input());failed.click('lightbar-apply');
 await new Promise(r=>setImmediate(r));assert.match(failed.nodes.get('lightbar-status').textContent,/Synthetic controller unavailable/);assert.equal(failed.nodes.get('lightbar-apply').disabled,false);
 const success=setup({controlResponse:{body:{connected:true,status:'idle',effects:{lightbar:{r:1,g:2,b:3,sentAt:'new',commandSent:true,deviceConfirmed:false}}}}});success.accept(success.input());success.click('lightbar-apply');
 await new Promise(r=>setImmediate(r));assert.equal(success.nodes.get('lightbar-status').textContent,'Color sent');assert.doesNotMatch(success.nodes.get('lightbar-status').textContent,/confirmed|saved|applied/i);
});

test('disconnected controller metadata is unavailable even when old values remain',()=>{
 const run=setup(),s=run.input();s.battery={level:75,status:'charging'};s.firmware={build:'Synthetic build'};run.accept(s);
 assert.equal(run.nodes.get('controller-battery').textContent,'75% · Charging');
 s.connected=false;run.accept(s);
 assert.equal(run.nodes.get('controller-battery').textContent,'Unavailable');assert.equal(run.nodes.get('controller-firmware').textContent,'Unavailable');
});

test('trigger selection stays local until Apply and custom values are sent once',()=>{
 const run=setup();run.accept(run.input());const before=run.requests.length;
 run.change('trigger-preset','custom');run.change('trigger-target','left');run.change('trigger-position','3');run.change('trigger-strength','7');
 assert.equal(run.requests.length,before);assert.equal(run.nodes.get('trigger-custom').hidden,false);
 run.click('trigger-apply');const request=run.requests.find(r=>r.url.includes('/control'));assert.ok(request);
 assert.deepEqual(JSON.parse(request.options.body),{preset:'custom',target:'left',position:3,strength:7,action:'triggers'});
 assert.equal(run.requests.filter(r=>r.url.includes('/control')).length,1);
});

test('trigger effects are locked during measurement while lightbar remains available',()=>{
 const run=setup(),s=run.input();s.status='running';run.accept(s);
 assert.equal(run.nodes.get('trigger-apply').disabled,true);assert.equal(run.nodes.get('trigger-reset').disabled,true);
 assert.equal(run.nodes.get('lightbar-apply').disabled,false);assert.match(run.nodes.get('trigger-guide').textContent,/pause/i);
 run.click('trigger-apply');run.click('trigger-reset');assert.ok(!run.requests.some(r=>r.url.includes('/control')));
 s.status='paused';run.accept(s);assert.equal(run.nodes.get('trigger-apply').disabled,false);
 run.click('trigger-reset');const request=run.requests.find(r=>r.url.includes('/control'));assert.deepEqual(JSON.parse(request.options.body),{preset:'off',target:'both',action:'triggers'});
});

test('invalid custom trigger parameters do not send a command',()=>{
 const run=setup();run.accept(run.input());run.change('trigger-preset','custom');run.change('trigger-position','10');run.click('trigger-apply');
 assert.ok(!run.requests.some(r=>r.url.includes('/control')));assert.match(run.nodes.get('trigger-status').textContent,/position/i);
 run.change('trigger-position','3');run.change('trigger-strength','0');run.click('trigger-apply');assert.ok(!run.requests.some(r=>r.url.includes('/control')));
 run.change('trigger-strength','6');run.change('trigger-target','unsupported');run.click('trigger-apply');assert.ok(!run.requests.some(r=>r.url.includes('/control')));
});

test('trigger success and errors describe a send rather than physical calibration',async()=>{
 const run=setup({controlResponse:{body:{connected:true,status:'idle',effects:{triggers:{preset:'firm',target:'both',sentAt:'synthetic',commandSent:true,deviceConfirmed:false}}}}});run.accept(run.input());run.change('trigger-preset','firm');run.click('trigger-apply');
 await new Promise(r=>setImmediate(r));assert.equal(run.nodes.get('trigger-status').textContent,'Trigger effect sent');
 const failed=setup({controlResponse:{ok:false,body:{error:'Synthetic trigger failure'}}});failed.accept(failed.input());failed.click('trigger-reset');await new Promise(r=>setImmediate(r));assert.match(failed.nodes.get('trigger-status').textContent,/Synthetic trigger failure/);
});


test('feed bursts defer guidance and metadata DOM writes to one frame',()=>{
 const run=setup({deferUi:true});
 for(let i=0;i<8;i++){const s=run.input(128+i);s.instruction='Instruction '+i;run.accept(s);}
 assert.equal(run.nodes.get('instruction').textContent,'');run.step();
 assert.equal(run.nodes.get('instruction').textContent,'Instruction 7');
 assert.equal(run.frames.size,1);
});

test('preparation countdown drains smoothly but never starts a phase without server evidence',()=>{
 const run=setup(),s=run.input();Object.assign(s,{status:'running',phase:'range',direction:'clockwise',preparing:true,prepareSecondsRemaining:3,prepareDurationSeconds:3});run.accept(s);
 assert.equal(run.nodes.get('timer').textContent,'3');assert.equal(run.nodes.get('timer-label').textContent,'Get ready');
 const before=run.nodes.get('timer-ring').attributes['stroke-dashoffset'];run.step(100);assert.notEqual(run.nodes.get('timer-ring').attributes['stroke-dashoffset'],before);
 for(let i=0;i<4;i++){s.prepareSecondsRemaining=0;run.accept(s);run.step(20);}
 assert.equal(run.nodes.get('timer').textContent,'…');assert.equal(run.nodes.get('timer-label').textContent,'Waiting');
 assert.equal(run.nodes.get('movement-label').textContent,'Next: Full outer edge · clockwise');
 s.preparing=false;s.phaseProgress=.25;s.secondsRemaining=null;run.accept(s);assert.equal(run.nodes.get('timer').textContent,'25%');
 run.step(301);assert.equal(run.nodes.get('timer-label').textContent,'Input paused');assert.equal(run.nodes.get('timer').textContent,'—');
});

test('range cues and coverage reflect each stick, direction and preparation state',()=>{
 const run=setup(),s=run.input();Object.assign(s,{status:'running',phase:'range',direction:'counterclockwise',details:{left:{cueCode:'too_fast',cueTone:'warning',cueMessage:'Slow down: keep a steady circle.',coveredSectors:8},right:{cueCode:'keep_going',cueTone:'good',cueMessage:'Good pace. Keep going.',coveredSectors:12}}});run.accept(s);
 assert.equal(run.nodes.get('movement-guide').hidden,false);assert.equal(run.nodes.get('movement-guide').dataset.direction,'counterclockwise');
 assert.match(run.nodes.get('left-cue').textContent,/Slow down/);assert.equal(run.nodes.get('left-cue').dataset.tone,'warning');assert.equal(run.nodes.get('right-cue').dataset.tone,'good');
 assert.equal(run.nodes.get('left-coverage-fill').style.width,'50%');assert.equal(run.nodes.get('right-coverage-fill').style.width,'75%');
 s.preparing=true;run.accept(s);assert.equal(run.nodes.get('left-cue').hidden,true);assert.equal(run.nodes.get('left-coverage').hidden,true);
 s.status='paused';run.accept(s);assert.equal(run.nodes.get('movement-guide').hidden,true);
});

test('custom hex color syncs preview and picker without sending until Apply',()=>{
 const run=setup();run.accept(run.input());run.change('lightbar-hex','12ABEF');
 assert.equal(run.nodes.get('lightbar-color').value,'#12abef');assert.equal(run.nodes.get('lightbar-hex').value,'#12ABEF');
 assert.equal(run.nodes.get('lightbar-preview').style.backgroundColor,'rgb(18,171,239)');assert.ok(!run.requests.some(r=>r.url.includes('/control')));
 run.click('lightbar-apply');const request=run.requests.find(r=>r.url.includes('/control'));assert.deepEqual(JSON.parse(request.options.body),{r:18,g:171,b:239,action:'lightbar'});
});

test('invalid custom hex never sends the previous valid color',()=>{
 const run=setup();run.accept(run.input());run.change('lightbar-hex','wrong');run.click('lightbar-apply');
 assert.equal(run.nodes.get('lightbar-hex').attributes['aria-invalid'],'true');assert.ok(!run.requests.some(r=>r.url.includes('/control')));
});

test('reduced motion countdown uses discrete ring steps',()=>{
 const run=setup({reducedMotion:true}),s=run.input();Object.assign(s,{status:'running',preparing:true,prepareSecondsRemaining:3,prepareDurationSeconds:3});run.accept(s);
 const before=run.nodes.get('timer-ring').attributes['stroke-dashoffset'];run.step(100);assert.equal(run.nodes.get('timer-ring').attributes['stroke-dashoffset'],before);
});


test('all customization options share one disclosure with named groups',()=>{
 assert.equal([...html.matchAll(/<details\b/g)].length,1);
 const panel=html.match(/<details\b[^>]*id="controller-controls"[\s\S]*?<\/details>/)[0];
 for(const id of ['trail-mode','view-mode','number-units','center-rings','show-rates','clear-trail','lightbar-hex','lightbar-apply','trigger-preset','trigger-apply'])assert.ok(panel.includes('id="'+id+'"'),id);
 assert.match(panel,/Live view/);assert.match(panel,/Lightbar/);assert.match(panel,/Adaptive triggers/);
});

test('resolved server corrections clear when good movement is reported',()=>{
 const run=setup(),s=run.input();s.status='running';s.warning='Slow down.';run.accept(s);assert.equal(run.nodes.get('feedback').dataset.warning,'true');
 s.warning=null;run.accept(s);assert.equal(run.nodes.get('feedback').dataset.warning,'false');assert.doesNotMatch(run.nodes.get('feedback').textContent,/Slow down/);
});

test('lightbar Apply is prominent and available before a test, with actionable disabled reasons',()=>{
 const run=setup();assert.match(html,/<button id="lightbar-apply" class="primary"[^>]*aria-describedby="lightbar-help"/);
 assert.equal(run.nodes.get('lightbar-apply').disabled,true);assert.match(run.nodes.get('lightbar-help').textContent,/Connecting to the local coach/);
 run.accept({...run.input(),connected:false,latest:null});assert.match(run.nodes.get('lightbar-help').textContent,/Connect the controller/);assert.equal(run.nodes.get('lightbar-connect').hidden,false);
 for(const status of ['idle','paused','running','complete']){run.accept({...run.input(),status});assert.equal(run.nodes.get('lightbar-apply').disabled,false);assert.match(run.nodes.get('lightbar-help').textContent,/Ready to apply. No test is required/);}
 run.step(301);assert.equal(run.nodes.get('lightbar-apply').disabled,true);assert.match(run.nodes.get('lightbar-help').textContent,/Waiting for fresh/);
 run.accept(run.input());assert.equal(run.nodes.get('lightbar-apply').disabled,false);assert.equal(run.nodes.get('lightbar-connect').hidden,true);
 assert.ok(!run.requests.some(r=>r.url.includes('/control')));
});
test('an empty comparison does not show fabricated results before the first round',()=>{
 const run=setup();run.accept({...run.input(),measurements:{targetRounds:5,rounds:[],comparison:{acceptedRounds:0,excludedRounds:0,comparable:false,left:null,right:null}}});
 assert.equal(run.nodes.get('results').hidden,true);
});

test('lightbar connection recovery does not start a test or apply an effect',async()=>{
 const live={connected:true,status:'idle',latest:{lx:128,ly:128,rx:128,ry:128,mode:'usb'},ageMs:0};
 const run=setup({controlResponse:{body:live}});run.accept({connected:false,status:'idle',ageMs:null,latest:null});
 run.click('lightbar-connect');assert.equal(run.nodes.get('lightbar-apply').disabled,true);assert.match(run.nodes.get('lightbar-help').textContent,/Sending a command/);
 await new Promise(r=>setImmediate(r));run.step();assert.equal(run.nodes.get('lightbar-apply').disabled,false);
 const commands=run.requests.filter(r=>r.url.includes('/control')).map(r=>JSON.parse(r.options.body));assert.deepEqual(commands,[{action:'connect'}]);
});

const measuredSide=(peak=3,deadzone=4)=>({suggestedDeadzonePercent:deadzone,observedPeakPercent:peak,worstP99Percent:peak-.2,roundSpreadPercent:1,circularity:{min:7,max:8,latest:7.5}});
const measuredRounds=()=>({targetRounds:5,rounds:Array.from({length:5},(_,i)=>({number:i+1,complete:true,left:measuredSide(i+2,i+3),right:measuredSide(i+3,i+4)})),comparison:{acceptedRounds:5,excludedRounds:0,comparable:true,left:measuredSide(6,7),right:measuredSide(7,8),applied:false,note:'Largest observed resting excursion plus one percentage point. No settings applied; verify in game.'}});

test('complete repeat measurements show conservative server candidates and a round comparison',()=>{
 const run=setup();run.accept({...run.input(),status:'complete',measurements:measuredRounds()});
 assert.equal(run.nodes.get('results').hidden,false);assert.equal(run.nodes.get('left-deadzone').textContent,'7%');assert.equal(run.nodes.get('right-deadzone').textContent,'8%');
 assert.match(run.nodes.get('left-circularity').textContent,/7.5%/);assert.match(run.nodes.get('round-status').textContent,/5 \/ 5 comparable/);
 assert.equal(run.nodes.get('round-history').hidden,false);assert.equal(run.nodes.get('round-4-left').textContent,'7%');assert.equal(run.nodes.get('round-5').hidden,true);
 assert.equal(run.nodes.get('round-4-right-bar').style.width,'100%');assert.match(run.nodes.get('results-note').textContent,/No settings applied/);
 assert.ok(!run.requests.some(r=>r.url.includes('/control')));
});

test('unavailable or incompatible measurements never become zero-deadzone claims',()=>{
 const run=setup();run.accept(run.input());assert.equal(run.nodes.get('results').hidden,true);
 const data=measuredRounds();data.comparison.comparable=false;data.comparison.reason='Transport changed; start a new comparison.';
 run.accept({...run.input(),measurements:data});assert.equal(run.nodes.get('left-deadzone').textContent,'Unavailable');assert.equal(run.nodes.get('round-history').hidden,true);assert.match(run.nodes.get('results-summary').textContent,/Transport changed/);
 data.comparison.comparable=true;data.comparison.left.circularity={min:null,max:null,latest:null};data.comparison.left.suggestedDeadzonePercent=null;
 run.accept({...run.input(),measurements:data});assert.equal(run.nodes.get('left-deadzone').textContent,'Unavailable');assert.match(run.nodes.get('left-circularity').textContent,/full outer-edge coverage/);
});

test('round goal selection stays local until an explicit start or repeat',()=>{
 for(const id of ['start','repeat-round']){
  const run=setup();run.accept({...run.input(),status:'complete',measurements:{...measuredRounds(),targetRounds:1}});run.change('round-target','5');
  run.accept({...run.input(),status:'complete',measurements:{...measuredRounds(),targetRounds:1}});assert.equal(run.nodes.get('round-target').value,'5');
  assert.ok(!run.requests.some(r=>r.url.includes('/control')));run.click(id);
  const request=run.requests.find(r=>r.url.includes('/control'));assert.deepEqual(JSON.parse(request.options.body),{roundTarget:5,action:'start'});
 }
});

test('new comparison clears only saved comparison state and is blocked during a run',()=>{
 const run=setup();run.accept({...run.input(),status:'running',measurements:measuredRounds()});run.click('reset-rounds');assert.ok(!run.requests.some(r=>r.url.includes('/control')));
 run.accept({...run.input(),status:'complete',measurements:measuredRounds()});run.click('reset-rounds');
 const request=run.requests.find(r=>r.url.includes('/control'));assert.deepEqual(JSON.parse(request.options.body),{action:'reset_rounds'});
});
const calibrationState=(stage='measured',overrides={})=>({stage,message:'Server calibration state: '+stage,reviewId:'review-123',lastSavedAt:null,verifiedAt:null,historySource:'this_app',firmwareSaveTimestamp:null,busy:false,operation:null,countdownSeconds:null,comparison:{before:{left:measuredSide(4,5),right:measuredSide(5,6)},after:{left:measuredSide(2,3),right:measuredSide(3,4)}},actions:{inspect:true,trial:stage==='measured',retest:stage==='trial_applied',save:stage==='ready_to_save',reboot:['trial_applied','ready_to_save','save_acknowledged','verified'].includes(stage),verify:['save_acknowledged','verified','ambiguous','changed'].includes(stage)},...overrides});
const controlCommands=run=>run.requests.filter(r=>r.url.includes('/control')).map(r=>JSON.parse(r.options.body));

test('calibration stages reflect server evidence and never send an automatic command',()=>{
 const run=setup();
 for(const [stage,expected] of [['measured','Measured · unchanged'],['trial_applied','Temporary adjustment · unsaved'],['ready_to_save','Retested · review before saving'],['save_acknowledged','Save acknowledged · restart verification needed'],['verified','Verified after restart'],['ambiguous','Verification inconclusive'],['changed','Calibration changed'],['unknown','Unknown']]){
  run.accept({...run.input(),status:'complete',calibration:calibrationState(stage)});
  assert.equal(run.nodes.get('calibration-stage').textContent,expected);
  assert.equal(run.nodes.get('calibration-message').textContent,'Server calibration state: '+stage);
  assert.equal(run.nodes.get('calibration-save').disabled,stage!=='ready_to_save');
  assert.equal(run.nodes.get('calibration-retest').disabled,stage!=='trial_applied');
  assert.equal(run.nodes.get('calibration-trial').disabled,stage!=='measured');
 }
 assert.deepEqual(controlCommands(run),[]);
});

test('measurement alone cannot unlock Save even if an invalid capability claims it can',()=>{
 const run=setup();run.accept({...run.input(),status:'complete',calibration:calibrationState('measured',{actions:{save:true}})});
 run.click('calibration-save');run.click('calibration-confirm-action');
 assert.equal(run.nodes.get('calibration-save').hidden,true);assert.equal(run.nodes.get('calibration-confirm').hidden,true);assert.deepEqual(controlCommands(run),[]);
});

test('temporary trial is explicit and its hands-off countdown follows server evidence',()=>{
 const run=setup();run.accept({...run.input(),calibration:calibrationState()});run.click('calibration-trial');
 assert.deepEqual(controlCommands(run),[{confirm:'TRY_TEMPORARY_CENTER',action:'calibration_trial'}]);
 const countdown=setup();countdown.accept({...countdown.input(),latest:null,calibration:calibrationState('measured',{busy:true,operation:'temporary center adjustment',countdownSeconds:3})});
 assert.match(countdown.nodes.get('calibration-message').textContent,/Hands off both sticks · 3s/);
 countdown.step(3500);assert.match(countdown.nodes.get('calibration-stage').textContent,/Measured/);assert.deepEqual(controlCommands(countdown),[]);
});

test('save requires inline review confirmation and sends the server reviewId once',()=>{
 const run=setup();run.accept({...run.input(),status:'complete',calibration:calibrationState('ready_to_save')});run.click('calibration-save');
 assert.deepEqual(controlCommands(run),[]);assert.equal(run.nodes.get('calibration-confirm').hidden,false);
 assert.match(run.nodes.get('calibration-confirm-title').textContent,/controller memory/);
 assert.match(run.nodes.get('calibration-confirm-results').textContent,/Left: before resting peak 4%.*after resting peak 2%/);
 run.click('calibration-confirm-action');run.click('calibration-confirm-action');
 assert.deepEqual(controlCommands(run),[{confirm:'SAVE_REVIEWED_CALIBRATION',reviewId:'review-123',action:'calibration_save'}]);
 assert.equal(run.nodes.get('calibration-confirm').hidden,true);
});

test('save confirmation cancels safely and expires when the reviewed candidate changes',()=>{
 const run=setup(),input={...run.input(),calibration:calibrationState('ready_to_save')};run.accept(input);run.click('calibration-save');run.click('calibration-cancel');run.click('calibration-confirm-action');
 assert.deepEqual(controlCommands(run),[]);
 run.click('calibration-save');run.accept({...input,calibration:calibrationState('ready_to_save',{reviewId:'replacement-review'})});
 assert.equal(run.nodes.get('calibration-confirm').hidden,true);run.click('calibration-confirm-action');assert.deepEqual(controlCommands(run),[]);
 const missing=setup();missing.accept({...missing.input(),calibration:calibrationState('ready_to_save',{reviewId:null})});missing.click('calibration-save');assert.equal(missing.nodes.get('calibration-save').disabled,true);assert.deepEqual(controlCommands(missing),[]);
});

test('restart explicitly confirms discarding a temporary adjustment; a saved restart does not send discard',()=>{
 for(const stage of ['trial_applied','ready_to_save','save_acknowledged']){
  const run=setup();run.accept({...run.input(),calibration:calibrationState(stage)});run.click('calibration-reboot');
  assert.deepEqual(controlCommands(run),[]);assert.equal(run.nodes.get('calibration-confirm').hidden,false);
  const unsaved=stage!=='save_acknowledged';if(unsaved)assert.match(run.nodes.get('calibration-confirm-title').textContent,/discard the unsaved/);
  run.click('calibration-confirm-action');assert.deepEqual(controlCommands(run),[{confirm:'REBOOT_CONTROLLER',...(unsaved?{discardUnsaved:true}:{}),action:'calibration_reboot'}]);
 }
 assert.doesNotMatch(script,/\b(?:alert|confirm)\(/);
});

test('inspection and explicit restart verification use capabilities even while input is stale',()=>{
 for(const [id,payload] of [['inspect',{action:'calibration_inspect'}],['verify',{restartConfirmed:true,action:'calibration_verify'}],['retest',{action:'calibration_retest'}]]){
  const run=setup();run.accept({...run.input(),connected:false,latest:null,ageMs:null,calibration:calibrationState(id==='retest'?'trial_applied':'save_acknowledged')});
  assert.equal(run.nodes.get('calibration-'+id).disabled,false);run.click('calibration-'+id);assert.deepEqual(controlCommands(run),[payload]);
 }
 assert.match(html,/>I restarted — verify</);
});

test('saved and verified timestamps come only from app records, never from firmware build date',()=>{
 const run=setup(),saved='2026-11-01T15:00:00Z',verified='2026-11-02T15:00:00Z';
 run.accept({...run.input(),firmware:{build:'FIRMWARE BUILD 2024-04-22'},calibration:calibrationState('save_acknowledged',{lastSavedAt:saved,verifiedAt:null})});
 assert.equal(run.nodes.get('calibration-saved-at').textContent,new Date(saved).toLocaleString());assert.equal(run.nodes.get('calibration-verified-at').textContent,'Not verified');
 run.accept({...run.input(),calibration:calibrationState('verified',{lastSavedAt:saved,verifiedAt:verified})});assert.equal(run.nodes.get('calibration-verified-at').textContent,new Date(verified).toLocaleString());
 run.accept({...run.input(),firmware:{build:'FIRMWARE BUILD 2024-04-22'},calibration:calibrationState('unknown',{firmwareSaveTimestamp:'2024-04-22T00:00:00Z'})});assert.equal(run.nodes.get('calibration-saved-at').textContent,'No app save recorded');
 assert.match(html,/Last saved by this app/);assert.match(html,/No firmware save timestamp is available here/);
});

test('busy calibration reserves HID without racing generic commands or offering Connect as recovery',()=>{
 const run=setup();run.accept({...run.input(),connected:false,latest:null,calibration:calibrationState('trial_applied',{busy:true,operation:'center adjustment',blockedReason:'Keep hands off until the center adjustment finishes.'})});
 for(const id of ['start','repeat-round','reset-rounds','lightbar-apply','trigger-apply','trigger-reset','connect','lightbar-connect']){assert.equal(run.nodes.get(id).disabled,true,id);run.click(id);}
 assert.equal(run.nodes.get('connect').hidden,true);assert.equal(run.nodes.get('lightbar-connect').hidden,true);assert.match(run.nodes.get('connection').textContent,/controller reserved/);assert.deepEqual(controlCommands(run),[]);
 assert.equal(run.nodes.get('calibration-retest').attributes.title,'Keep hands off until the center adjustment finishes.');
 run.accept({...run.input(),calibration:calibrationState('trial_applied')});assert.equal(run.nodes.get('start').disabled,true);assert.equal(run.nodes.get('start').hidden,true);assert.equal(run.nodes.get('connect').hidden,false);
});

test('old hosts and partial comparison data remain honest and usable',()=>{
 const run=setup();run.accept(run.input());assert.match(run.nodes.get('calibration-help').textContent,/updated local coach/);assert.equal(run.nodes.get('start').disabled,false);assert.equal(run.nodes.get('calibration-inspect').disabled,true);
 run.accept({...run.input(),calibration:calibrationState('ambiguous',{comparison:{before:{left:{}},after:null},actions:{save:false,inspect:false},blockedReason:'No compatible calibration history for this controller.'})});
 assert.match(run.nodes.get('calibration-left').textContent,/Unavailable/);assert.match(run.nodes.get('calibration-right').textContent,/Unavailable/);assert.equal(run.nodes.get('calibration-help').textContent,'No compatible calibration history for this controller.');assert.deepEqual(controlCommands(run),[]);
});


test('calibration requests allow a long operation and a timeout waits for server evidence without retrying',async()=>{
 const error=new Error('synthetic timeout');error.name='TimeoutError';
 const run=setup({controlError:error});run.accept({...run.input(),calibration:calibrationState()});run.click('calibration-trial');
 assert.ok(run.timeouts.includes(60000));await new Promise(r=>setImmediate(r));
 assert.match(run.nodes.get('feedback').textContent,/operation may still be running/);assert.equal(run.nodes.get('connect').hidden,true);assert.equal(run.nodes.get('start').disabled,true);assert.equal(run.nodes.get('calibration-trial').disabled,true);assert.equal(controlCommands(run).length,1);
 run.step(1000);assert.equal(controlCommands(run).length,1);
 run.accept({...run.input(),calibration:calibrationState('trial_applied')});assert.equal(run.nodes.get('calibration-retest').disabled,false);assert.equal(run.nodes.get('connect').hidden,false);assert.equal(controlCommands(run).length,1);
 const ordinary=setup();ordinary.accept(ordinary.input());ordinary.click('lightbar-apply');assert.ok(ordinary.timeouts.includes(8000));
});


test('snapshot export is explicit, display-only, and creates a PNG download with an inline fallback',()=>{
 const run=setup();run.accept({...run.input(140),status:'complete',measurements:measuredRounds(),calibration:calibrationState('ready_to_save')});
 assert.equal(run.downloads.length,0);run.click('snapshot');
 assert.deepEqual(controlCommands(run),[]);assert.equal(run.downloads.length,1);assert.equal(run.downloads[0].download,'DualSense-Studio-Snapshot.png');assert.match(run.downloads[0].href,/^data:image\/png/);assert.equal(run.nodes.get('snapshot-preview').hidden,false);assert.match(run.nodes.get('snapshot-status').textContent,/if your browser blocks it/);assert.equal(run.nodes.get('snapshot-open').attributes.href,run.downloads[0].href);
 assert.ok(run.canvasWrites.some(([value])=>value==='Calibration: Retested · review before saving'));assert.ok(run.canvasWrites.some(([value])=>/Raw X 140/.test(value)));
 run.click('snapshot-close');assert.equal(run.nodes.get('snapshot-preview').hidden,true);
});

test('snapshot report excludes private state, URLs, session paths, serial numbers and arbitrary messages',()=>{
 const run=setup(),s=run.input();Object.assign(s,{sessionId:'PRIVATE_SESSION',token:'PRIVATE_TOKEN',url:'https://PRIVATE_URL/',instruction:'PRIVATE_INSTRUCTION',path:'/private/PRIVATE_PATH',controller:{serialNumber:'PRIVATE_SERIAL'},firmware:{build:'PRIVATE_BUILD'},calibration:calibrationState('verified',{message:'PRIVATE_CALIBRATION_MESSAGE',lastSavedAt:'PRIVATE_DATE',reviewId:'PRIVATE_REVIEW'})});
 run.accept(s);run.click('snapshot');const rendered=run.canvasWrites.map(([value])=>value).join(' ');
 assert.doesNotMatch(rendered,/PRIVATE_|test-token|127\.0\.0\.1|https?:|\/private\/|review-123/);assert.match(rendered,/Verified after restart/);assert.deepEqual(controlCommands(run),[]);
 run.step(301);run.click('snapshot');assert.ok(run.canvasWrites.some(([value])=>/Last received input, stale/.test(value)));
});
