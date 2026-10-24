import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { initializeUsageTables } from '../usage.db.js';
import { scanUsageFile, usageOverview } from '../usage.service.js';

async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'usage-test-')),db=new Database(':memory:');
  initializeUsageTables(db);db.exec("CREATE TABLE users(id INTEGER,username TEXT,role TEXT,is_active INTEGER);INSERT INTO users VALUES(1,'admin','admin',1),(2,'member','member',1),(3,'disabled','member',0);CREATE TABLE app_config(key TEXT PRIMARY KEY,value TEXT)");
  return {root,db,cleanup:async()=>{db.close();await fs.rm(root,{recursive:true,force:true});}};
}
const at='2026-10-24T02:12:00Z';
const claude=(id:string,output:number,timestamp=at)=>({type:'assistant',timestamp,message:{id,model:'claude-test',usage:{input_tokens:10,output_tokens:output,cache_read_input_tokens:20,cache_creation_input_tokens:30}}});
const lines=(rows:unknown[])=>rows.map(x=>JSON.stringify(x)).join('\n')+'\n';
const overview=(db:Database.Database,id=1,role='admin',range='30d',userId?:number)=>usageOverview(db,{id,role},range,'user',userId,Date.parse(at));
test('Claude keeps last usage, skips synthetic/zero and replaces streaming usage across incremental scans',async()=>{
 const f=await fixture();try{const file=path.join(f.root,'session.jsonl');await fs.writeFile(file,lines([claude('a',2),claude('a',8),{...claude('synthetic',1),message:{model:'<synthetic>',usage:{input_tokens:0,output_tokens:0}}}]));await scanUsageFile(f.db,file,1,'claude');assert.equal(overview(f.db).totals.total,68);assert.equal(overview(f.db).totals.requests,1);
 await fs.appendFile(file,lines([claude('a',15),claude('b',5)]));await scanUsageFile(f.db,file,1,'claude');assert.equal(overview(f.db).totals.total,140);assert.equal(overview(f.db).totals.requests,2);
 await scanUsageFile(f.db,file,1,'claude');assert.equal(overview(f.db).totals.total,140);
 }finally{await f.cleanup();}
});
test('Codex counts distinct total usage, cached input once, reasoning within output, archive model context',async()=>{
 const f=await fixture();try{const file=path.join(f.root,'rollout-test.jsonl');const event=(total:number)=>({type:'event_msg',timestamp:at,payload:{type:'token_count',info:{total_token_usage:{input_tokens:total,output_tokens:4},last_token_usage:{input_tokens:100,cached_input_tokens:80,output_tokens:40,reasoning_output_tokens:30}}}});
 await fs.writeFile(file,lines([{type:'turn_context',payload:{model:'gpt-test'}},event(100),event(100),{type:'event_msg',payload:{type:'token_count',info:null}}]));await scanUsageFile(f.db,file,2,'codex');
 await fs.appendFile(file,lines([event(100),event(200)]));await scanUsageFile(f.db,file,2,'codex');const result=overview(f.db);assert.equal(result.totals.requests,2);assert.equal(result.totals.input,40);assert.equal(result.totals.cacheRead,160);assert.equal(result.totals.output,80);assert.equal(result.totals.reasoning,60);assert.equal(result.totals.total,280);
 }finally{await f.cleanup();}
});
test('Only complete UTF-8 lines advance cursor; truncation and mtime rollback replace old file counts',async()=>{
 const f=await fixture();try{const file=path.join(f.root,'session.jsonl'),first=JSON.stringify(claude('中',8));await fs.writeFile(file,first);await scanUsageFile(f.db,file,1,'claude');assert.equal(overview(f.db).totals.total,0);await fs.appendFile(file,'\n');await scanUsageFile(f.db,file,1,'claude');assert.equal(overview(f.db).totals.total,68);
 await fs.writeFile(file,lines([claude('b',2)]));await scanUsageFile(f.db,file,1,'claude');assert.equal(overview(f.db).totals.total,62);
 await fs.writeFile(file,lines([claude('c',3),claude('d',4)]));await fs.utimes(file,new Date('2020-01-01'),new Date('2020-01-01'));await scanUsageFile(f.db,file,1,'claude');assert.equal(overview(f.db).totals.total,127);
 }finally{await f.cleanup();}
});
test('Member scope ignores requested account, fills empty buckets and preserves disabled/deleted usage',async()=>{
 const f=await fixture();try{for(const id of [1,2,3,99]){const file=path.join(f.root,`${id}.jsonl`);await fs.writeFile(file,lines([claude('a',id)]));await scanUsageFile(f.db,file,id,'claude');}
 const member=overview(f.db,2,'member','24h',1);assert.deepEqual(member.perUser.map(u=>u.userId),[2]);assert.deepEqual(member.series.map(s=>s.key),['2']);assert.equal(member.buckets.length,24);assert.equal(member.series[0].points.filter(p=>p.requests===0).length,23);assert.equal(member.totals.total,62);
 const admin=overview(f.db);assert.equal(admin.perUser.find(u=>u.userId===3)?.isActive,false);assert.equal(admin.perUser.find(u=>u.userId===99)?.isActive,false);assert.equal(admin.buckets.length,30);assert.equal(overview(f.db,1,'admin','7d').buckets.length,7);assert.equal(overview(f.db,1,'admin','90d').buckets.length,90);
 }finally{await f.cleanup();}
});
