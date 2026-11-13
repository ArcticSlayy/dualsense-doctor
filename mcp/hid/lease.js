// One local process owns DualSense HID at a time. Recover only dead PID owners.
import { mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../.runtime/',import.meta.url));
const lock=fileURLToPath(new URL('../../.runtime/hid.lock',import.meta.url));
const reclaim=fileURLToPath(new URL('../../.runtime/hid-reclaim.lock',import.meta.url));
export function acquireLease() {
  mkdirSync(root,{recursive:true});
  try {mkdirSync(lock);} catch(e) {
    if(e.code!=='EEXIST')throw e;
    // Serialise recovery so two openers cannot both remove a newly acquired lease.
    try{mkdirSync(reclaim);}catch{throw Error('Another process is checking controller ownership; retry shortly.');}
    try {
      let owner;
      try {owner=JSON.parse(readFileSync(lock+'/owner.json','utf8'));} catch{}
      let alive=true;
      if(owner?.pid){try{process.kill(owner.pid,0);}catch(err){if(err.code==='ESRCH')alive=false;}}
      else alive=Date.now()-statSync(lock).mtimeMs<10000;
      if(alive)throw Error('DualSense is owned by another local tool or the live chat card. Disconnect the card before using another controller tool.');
      rmSync(lock,{recursive:true});mkdirSync(lock);
    } finally {rmSync(reclaim,{recursive:true});}
  }
  writeFileSync(lock+'/owner.json',JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
  return ()=>{try{const owner=JSON.parse(readFileSync(lock+'/owner.json','utf8'));if(owner.pid===process.pid)rmSync(lock,{recursive:true});}catch{}};
}
