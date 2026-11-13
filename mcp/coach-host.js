import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Controller, parseSticks, listControllers, TRIGGER_PRESETS, effFeedback } from './hid/dualsense.js';
import { SessionStore } from './guided.js';
import { runGuided, RUN_STEPS } from './coach-runner.js';

// Sony's battery nibble reports 10% intervals; use midpoint estimates except full.
export function batteryFromReport(buf,mode) {
  const index=mode==='usb'?53:mode==='bt'?54:-1;
  if(index<0||buf.length<=index)return null;
  const value=buf[index],status=value>>4;
  if(status===2)return {level:100,status:'full',estimated:true};
  if(status===0||status===1)return {level:Math.min(100,(value&15)*10+5),status:status?'charging':'discharging',estimated:true};
  return {level:null,status:[10,11].includes(status)?'not charging':'unknown',estimated:true};
}

export class CoachHost {
  constructor(store=new SessionStore()) {
    this.store=store;this.c=null;this.queue=[];this.latest=null;this.lastAt=0;this.events=[];this.run=null;this.status='idle';this.instruction='Connect your controller, then start the guided check.';this.warning=null;this.progress=0;this.currentIndex=0;this.resumeIndex=0;this.completedSteps=new Set();this.sequence=0;this.inputCount=0;this.rateAt=performance.now();this.inputHz=0;
    this.effects={lightbar:null,triggers:null};this.battery=null;this.firmware=null;
  }
  event(e) {
    if(e.type==='instruction') {this.currentIndex=RUN_STEPS.findIndex(s=>s.phase===e.phase&&s.direction===e.direction);this.warning=null;this.details={};this.prepareUntil=performance.now()+(e.countdownSeconds||0)*1000;this.secondsRemaining=null;}
    if(e.type==='phase_start')this.prepareUntil=0;
    if(e.type==='phase_complete')this.completedSteps.add(this.currentIndex);
    this.sessionId=e.sessionId||this.sessionId;
    if(e.message)this.instruction=e.message;
    if(e.type==='correction')this.warning=e.message;
    if(e.type==='progress'){this.warning=null;this.progress=(this.currentIndex+(e.phaseProgress||0))/RUN_STEPS.length;this.secondsRemaining=e.secondsRemaining;this.details=e.details;}
    if(e.type!=='progress'){this.events.push({at:e.at||new Date().toISOString(),message:e.message});this.events=this.events.slice(-30);}
  }
  connect() {
    if(this.c)return;
    const devices=listControllers();
    if(devices.length!==1)throw Error('Connect exactly one DualSense for this live card.');
    const c=new Controller(devices[0]);c.open();this.c=c;this.effects={lightbar:null,triggers:null};this.firmware=c.readFirmware();
    c.dev.on('data',buf=>{
      if(this.c!==c)return;
      const f=parseSticks(buf);if(!f)return;
      this.battery=batteryFromReport(buf,f.mode);
      this.latest=f;this.lastAt=performance.now();c._mode=f.mode;this.sequence++;this.inputCount++;
      if(this.lastAt-this.rateAt>=1000){this.inputHz=Math.round(this.inputCount*1000/(this.lastAt-this.rateAt));this.inputCount=0;this.rateAt=this.lastAt;}
      if(this.run){this.queue.push({s:f});if(this.queue.length>250)this.queue.shift();}
    });
    c.dev.on('error',e=>{if(this.c!==c)return;this.warning=`Controller input lost: ${e.message}`;this.disconnect();this.status='error';});
    this.instruction='Live view connected. Start once; follow the changing instructions.';
  }
  disconnect(){this.abort?.abort();const c=this.c;this.c=null;c?.close();this.latest=null;this.queue=[];this.battery=null;this.firmware=null;this.effects={lightbar:null,triggers:null};if(this.status==='running')this.status='paused';}
  async launch(resume=false) {
    if(this.run)throw Error('A guided check is already running.');
    if(!this.c||performance.now()-this.lastAt>300)throw Error('Waiting for fresh controller input.');
    this.queue=[];this.abort=new AbortController();this.status='running';this.warning=null;this.result=null;
    const startIndex=resume?this.resumeIndex:0;
    if(!resume){this.progress=0;this.sessionId=null;this.events=[];this.completedSteps.clear();}
    else for(const i of this.completedSteps)if(i>=startIndex)this.completedSteps.delete(i);
    const proxy={info:this.c.info,_readOnce:()=>this.queue.shift()||null};
    const task=runGuided(proxy,this.store,{signal:this.abort.signal,steps:RUN_STEPS.slice(startIndex),existingSession:resume?this.sessionId:undefined,onEvent:e=>this.event(e)});
    this.run=task;
    task.then(result=>{this.result=result;this.status=result.complete?'complete':'paused';if(!result.complete){this.warning=result.reason;this.resumeIndex=this.currentIndex===2?1:this.currentIndex;}else{this.progress=1;this.warning=null;}}).catch(e=>{
      if(this.status!=='paused'&&this.status!=='idle'){this.status='error';this.warning=e.message;}
    }).finally(()=>{if(this.run===task)this.run=null;});
  }
  async control(action,input={}) {
    if(action==='connect')this.connect();
    else if(action==='disconnect'){this.disconnect();this.status='idle';}
    else if(action==='lightbar') {
      const {r,g,b}=input;
      if(![r,g,b].every(v=>Number.isInteger(v)&&v>=0&&v<=255))throw Error('RGB values must be integers from 0 to 255.');
      if(!this.c||!this.latest||performance.now()-this.lastAt>300)throw Error('Connect the controller and wait for fresh input before sending a color.');
      this.c.applyLightbar(r,g,b);this.effects.lightbar={r,g,b,commandSent:true,deviceConfirmed:false,sentAt:new Date().toISOString()};
    } else if(action==='triggers') {
      if(this.status==='running')throw Error('Pause the guided check before changing trigger resistance.');
      const {preset,target='both',position=2,strength=6}=input;
      if(!['off','light','firm','max','weapon','custom'].includes(preset)||!['both','left','right'].includes(target))throw Error('Choose a supported trigger preset and target.');
      if(!Number.isInteger(position)||position<0||position>9||!Number.isInteger(strength)||strength<1||strength>8)throw Error('Trigger position must be 0–9 and strength 1–8.');
      if(!this.c||!this.latest||performance.now()-this.lastAt>300)throw Error('Connect the controller and wait for fresh input before sending trigger effects.');
      const effect=preset==='custom'?effFeedback(position,strength):TRIGGER_PRESETS[preset]();
      this.c.applyTriggers(target==='right'?null:effect,target==='left'?null:effect);
      this.effects.triggers={preset,target,position,strength,commandSent:true,deviceConfirmed:false,sentAt:new Date().toISOString()};
    }
    else if(action==='start')await this.launch();
    else if(action==='pause'){
      if(this.status!=='running')throw Error('No active guided check to pause.');
      this.resumeIndex=this.currentIndex===2?1:this.currentIndex;this.status='paused';this.abort.abort();
      this.instruction='Paused. Resume restarts the interrupted phase with a countdown.';await this.run.catch(()=>{});
    } else if(action==='resume')await this.launch(true);
    else if(action==='stop'){this.status='idle';this.abort?.abort();if(this.run)await this.run.catch(()=>{});this.instruction='Stopped. Captured phases remain logged; start a new check when ready.';this.warning=null;}
    else throw Error('Unknown control action.');
    return this.snapshot();
  }
  snapshot() {
    const ageMs=this.lastAt?performance.now()-this.lastAt:null;
    const labels=['Rest','Clockwise','Counterclockwise','Release','Buttons','Verify'];
    return {connected:!!this.c,status:this.status,latest:ageMs!==null&&ageMs<300?this.latest:null,ageMs,sequence:this.sequence,inputHz:this.inputHz,publishHz:60,clientMetrics:this.clientMetrics||null,battery:this.battery,firmware:this.firmware,effects:this.effects,controller:this.c?{product:this.c.info.product,productId:this.c.info.productId}:null,
      instruction:this.instruction,warning:this.warning,progress:this.progress,secondsRemaining:this.prepareUntil>performance.now()?Math.ceil((this.prepareUntil-performance.now())/1000):this.secondsRemaining??null,details:this.details||{},sessionId:this.sessionId||null,result:this.result?{complete:this.result.complete,logPath:this.result.report?.logPath,reason:this.result.reason}:null,events:this.events,
      stepIndex:this.currentIndex,steps:RUN_STEPS.map((s,i)=>({id:s.direction?`range-${s.direction}`:s.phase,label:labels[i],status:this.completedSteps.has(i)?'complete':i===this.currentIndex&&['running','paused'].includes(this.status)?'current':'pending'}))};
  }
}

export function createCoachServer({host=new CoachHost(),port=27892,token=randomBytes(32).toString('hex')}={}) {
  const clients=new Set();
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Private-Network','true');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
    res.setHeader('Cache-Control','no-store');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    const hostname=(req.headers.host||'').split(':')[0];
    if(!['127.0.0.1','localhost'].includes(hostname)){res.writeHead(403);res.end();return;}
    let url;try{url=new URL(req.url,'http://127.0.0.1');}catch{res.writeHead(400);res.end('Invalid request URL');return;}
    if(url.pathname==='/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({service:'dualsense-coach',version:1}));return;}
    const supplied=url.searchParams.get('token')||'';
    if(!/^[0-9a-f]{64}$/.test(supplied)||supplied.length!==token.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token))){res.writeHead(403);res.end('Invalid local capability');return;}
    if(req.method==='GET'&&url.pathname==='/events'){
      res.socket?.setNoDelay(true);res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();res.write(`event: state\ndata: ${JSON.stringify(host.snapshot())}\n\n`);clients.add(res);req.on('close',()=>clients.delete(res));return;
    }
    res.setHeader('Content-Type','application/json');
    if(req.method==='POST'&&url.pathname==='/metrics'){
      try{let body='';for await(const chunk of req){body+=chunk;if(body.length>512)throw Error('Too large');}const m=JSON.parse(body);
        if(!['fps','receiveHz','clientAgeMs'].every(k=>Number.isFinite(m[k])&&m[k]>=0))throw Error('Invalid metrics');
        host.clientMetrics={fps:Math.min(240,m.fps),receiveHz:Math.min(500,m.receiveHz),clientAgeMs:Math.min(60000,m.clientAgeMs),at:new Date().toISOString()};res.end('{"ok":true}');
      }catch{res.writeHead(400);res.end('{"error":"Invalid metrics"}');}return;
    }
    if(req.method==='GET'&&url.pathname==='/state'){res.end(JSON.stringify(host.snapshot()));return;}
    if(req.method==='POST'&&url.pathname==='/control'){
      try{
        let body='';for await(const chunk of req){body+=chunk;if(body.length>2048)throw Error('Control request too large.');}
        const input=JSON.parse(body);const result=await host.control(input.action,input);res.end(JSON.stringify(result));
      }catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}));}return;
    }
    res.writeHead(404);res.end(JSON.stringify({error:'Not found'}));
  });
  const timer=setInterval(()=>{if(!clients.size)return;const data=`event: state\ndata: ${JSON.stringify(host.snapshot())}\n\n`;for(const res of clients){if(res.writableLength>65536){clients.delete(res);res.end();}else res.write(data);}},16);
  timer.unref();
  server.on('close',()=>{clearInterval(timer);host.disconnect();for(const c of clients)c.end();});
  return {server,host,token,port,listen:()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve(server.address()));}),close:()=>new Promise(resolve=>{for(const c of clients)c.end();server.close(resolve);})};
}
