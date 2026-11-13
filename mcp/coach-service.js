import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCoachServer } from './coach-host.js';
const runtime=fileURLToPath(new URL('../.runtime/',import.meta.url));
const infoPath=runtime+'coach-server.json';
export async function ensureCoach() {
  async function existing(){try{const info=JSON.parse(readFileSync(infoPath,'utf8'));const r=await fetch(info.apiBase+'/health',{signal:AbortSignal.timeout(1000)});const health=await r.json();if(health.service==='dualsense-coach')return info;}catch{}return null;}
  let info=await existing();if(info)return info;
  mkdirSync(runtime,{recursive:true});const fd=openSync(runtime+'coach-service.log','a');
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'serve'],{detached:true,windowsHide:true,stdio:['ignore',fd,fd]});child.unref();closeSync(fd);
  for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,100));info=await existing();if(info)return info;}
  throw Error('Live coach failed to start. See .runtime/coach-service.log.');
}
export async function coachCardPath() {
  const info=await ensureCoach();
  const html=readFileSync(fileURLToPath(new URL('./coach-card.html',import.meta.url)),'utf8').replaceAll('__API_BASE__',info.apiBase).replaceAll('__TOKEN__',info.token);
  const path=runtime+'coach-card.html';writeFileSync(path,html);return {path,apiBase:info.apiBase};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]&&process.argv[2]==='serve') {
  mkdirSync(runtime,{recursive:true});let priorToken;
  try{const previous=JSON.parse(readFileSync(infoPath,'utf8'));if(/^[0-9a-f]{64}$/.test(previous.token))priorToken=previous.token;}catch{}
  const app=createCoachServer({token:priorToken});await app.listen();
  writeFileSync(infoPath,JSON.stringify({pid:process.pid,apiBase:`http://127.0.0.1:${app.port}`,token:app.token}));
  try{app.host.connect();}catch(e){app.host.warning=e.message;}
  console.log('Live coach listening on loopback port '+app.port);
}
