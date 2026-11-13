import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoachServer, CoachHost, batteryFromReport } from '../coach-host.js';
test('battery reporting uses Sony status and does not invent a level for unknown reports',()=>{
  const usb=Array(64).fill(0);usb[53]=0x29;
  assert.equal(batteryFromReport(usb,'usb').level,100);
  usb[53]=0x15;assert.equal(batteryFromReport(usb,'usb').level,55);
  usb[53]=0xf0;assert.equal(batteryFromReport(usb,'usb').level,null);
  assert.equal(batteryFromReport(Array(10).fill(0),'bt-compat'),null);
});
test('trigger effects validate parameters and are blocked during measurement',async()=>{
  const sent=[],host=new CoachHost({});host.c={info:{},applyTriggers(...effects){sent.push(effects);}};host.latest={mode:'usb'};host.lastAt=performance.now();
  await assert.rejects(host.control('triggers',{preset:'custom',position:20,strength:2}),/position/);
  host.status='running';await assert.rejects(host.control('triggers',{preset:'firm'}),/Pause/);assert.equal(sent.length,0);
  host.status='idle';await host.control('triggers',{preset:'custom',position:2,strength:4,target:'left'});
  assert.equal(sent.length,1);assert.equal(sent[0][0][0],0x21);assert.equal(sent[0][1],null);
  assert.equal(host.snapshot().effects.triggers.deviceConfirmed,false);
});
test('live lightbar control validates RGB and sends only a temporary output command',async()=>{
  const writes=[],host=new CoachHost({});host.c={info:{},_mode:'usb',applyLightbar(...rgb){writes.push(rgb);}};host.latest={mode:'usb'};host.lastAt=performance.now();
  await assert.rejects(host.control('lightbar',{r:300,g:0,b:0}),/RGB/);
  await assert.rejects(host.control('lightbar',{r:1.5,g:0,b:0}),/RGB/);
  assert.equal(writes.length,0);
  const s=await host.control('lightbar',{r:10,g:20,b:30});assert.deepEqual(writes,[[10,20,30]]);
  assert.equal(s.effects.lightbar.commandSent,true);assert.equal(s.effects.lightbar.deviceConfirmed,false);
});
test('live relay requires a capability for state/control and does not accept calibration commands',async()=>{
  const host={snapshot(){return {connected:false,latest:null};},disconnect(){},control(action){if(action==='calibrate')throw Error('Unknown control action');return this.snapshot();}};
  const app=createCoachServer({host,port:0,token:'a'.repeat(64)});const addr=await app.listen();const base=`http://127.0.0.1:${addr.port}`;
  try {
    assert.equal((await fetch(base+'/state')).status,403);
    assert.equal((await fetch(base+'/state?token='+encodeURIComponent('é'.repeat(64)))).status,403);
    const r=await fetch(base+'/state?token='+app.token);assert.equal(r.status,200);assert.equal(r.headers.get('access-control-allow-origin'),'*');
    const bad=await fetch(base+'/control?token='+app.token,{method:'POST',body:JSON.stringify({action:'calibrate'})});assert.equal(bad.status,400);
    const preflight=await fetch(base+'/control',{method:'OPTIONS'});assert.equal(preflight.status,204);
  } finally {await app.close();}
});
