import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, monitorsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { monitorsService } from '@/modules/monitors/monitors.service.js';
import { normalizeProbe, parseProbeFields, pollMonitorProbes, runProbe } from '@/modules/monitors/monitor-probe.service.js';
import { prepareIsolatedRound } from '@/modules/monitors/monitor-isolated.service.js';

async function fixture(check:(user:number,root:string)=>Promise<void>|void) {
  const root=await mkdtemp(path.join(os.tmpdir(),'monitor-probe-')); const previous=process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH=path.join(root,'test.db'); await initializeDatabase();
  try { const user=Number(userDb.createUser('probe-test','hash').id); sessionsDb.createAppSession('probe-session','claude',root,'Probe'); await check(user,root); }
  finally { closeConnection(); if(previous===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previous; await rm(root,{recursive:true,force:true}); }
}

test('normalizes all probe item settings and parses progress/status fields',()=>{
  assert.deepEqual(parseProbeFields('4418/16000 status: running',{ }),{progress:{current:4418,total:16000},status:'running'});
  assert.equal(normalizeProbe({items:[{type:'file',path:'STATUS.md'}],intervalMinutes:0})?.intervalMinutes,3);
  assert.deepEqual(normalizeProbe({items:[{file:'STATUS.md'}]})?.items[0],{file:'STATUS.md',type:'file',path:'STATUS.md'});
  assert.equal(normalizeProbe({items:[]}),null);
});

test('file probes read only appended bytes and emit error then done events',async()=>fixture(async(user,root)=>{
  const log=path.join(root,'task.log'); const done=path.join(root,'DONE.json'); await writeFile(log,'1/4\n'); await writeFile(done,JSON.stringify({done:false}));
  const row=monitorsService.create(user,{sessionId:'probe-session',name:'Probe',content:'read logs',intervalMinutes:1,probe:{intervalMinutes:1,items:[{type:'file',path:log,read:'tail'},{type:'patterns',patterns:['ERROR']}]}});
  const t0=new Date('2026-10-29T10:00:00.000Z'); assert.equal(await runProbe(row,t0),null);
  await writeFile(log,'1/4\nERROR failed\n'); const error=await runProbe(monitorsDb.get(user,row.id)!,new Date(t0.getTime()+60_000)); assert.equal(error?.type,'error'); assert.match(error?.delta||'',/ERROR failed/);
  const doneRow=monitorsService.create(user,{sessionId:'probe-session',name:'Done',content:'read done',intervalMinutes:1,probe:{intervalMinutes:1,items:[{type:'file',path:done,read:'json',field:'done',doneField:'done'}]}});
  await writeFile(done,JSON.stringify({done:true})); assert.equal((await runProbe(doneRow,new Date(t0.getTime()+60_000)))?.type,'done'); assert.equal(await runProbe(monitorsDb.get(user,doneRow.id)!,new Date(t0.getTime()+120_000)),null);
}));

test('command, process, threshold, stall, dead and heartbeat rules produce one event each',async()=>fixture(async(user,root)=>{
  const commandRow=monitorsService.create(user,{sessionId:'probe-session',name:'Command',content:'command',intervalMinutes:1,probe:{intervalMinutes:1,items:[{type:'command',command:'echo 3/4 status=running'},{type:'threshold',field:'progress.current',above:2}]}});
  const t0=new Date('2026-10-29T10:00:00.000Z'); assert.equal((await runProbe(commandRow,t0))?.type,'threshold');
  const processRow=monitorsService.create(user,{sessionId:'probe-session',name:'Process',content:'process',intervalMinutes:1,probe:{intervalMinutes:1,items:[{type:'process',pid:2147483647}]}});
  assert.equal((await runProbe(processRow,t0))?.type,'dead');
  const stallRow=monitorsService.create(user,{sessionId:'probe-session',name:'Stall',content:'stall',intervalMinutes:1,probe:{intervalMinutes:1,stallMinutes:1,items:[{type:'command',command:'echo 1/4'}]}});
  assert.equal(await runProbe(stallRow,t0),null); assert.equal((await runProbe(monitorsDb.get(user,stallRow.id)!,new Date(t0.getTime()+61_000)))?.type,'stall');
  const heartbeatRow=monitorsService.create(user,{sessionId:'probe-session',name:'Heartbeat',content:'heartbeat',intervalMinutes:1,probe:{intervalMinutes:1,heartbeatMinutes:1,items:[{type:'patterns',patterns:['NEVER']}]}});
  assert.equal(await runProbe(heartbeatRow,t0),null); assert.equal((await runProbe(monitorsDb.get(user,heartbeatRow.id)!,new Date(t0.getTime()+61_000)))?.type,'heartbeat');
}));

test('unfinished DONE files and historical completion prose never announce completion',async()=>fixture(async(user,root)=>{
  const done=path.join(root,'night-DONE.json'); const status=path.join(root,'STATUS.md');
  await writeFile(done,JSON.stringify({done:false,reason:'still working'}));
  await writeFile(status,'Earlier validation used done:true, but the real task is running.\n');
  const row=monitorsService.create(user,{sessionId:'probe-session',name:'False done regression',content:'read',intervalMinutes:1,probe:{items:[{file:done},{type:'file',path:status}]}});
  const now=new Date();
  assert.equal(await runProbe(row,now),null);
  assert.equal(await runProbe(monitorsDb.get(user,row.id)!,new Date(now.getTime()+180000)),null);
  await writeFile(done,JSON.stringify({done:true}));
  assert.equal((await runProbe(monitorsDb.get(user,row.id)!,new Date(now.getTime()+360000)))?.type,'done');
  assert.equal(await runProbe(monitorsDb.get(user,row.id)!,new Date(now.getTime()+540000)),null);
}));

test('scheduler respects probe interval, records zero-token heartbeats and preserves manual runs',async()=>fixture(async(user,root)=>{
  const log=path.join(root,'progress.log'); await writeFile(log,'1/40 status=running\n');
  const row=monitorsService.create(user,{sessionId:'probe-session',name:'Scheduling regression',content:'read',intervalMinutes:1,probe:{intervalMinutes:3,items:[{type:'file',path:log}]}});
  const now=new Date();
  assert.equal(await pollMonitorProbes(now),1);
  const first=monitorsDb.get(user,row.id)!;
  assert.equal(first.last_probe_at,now.toISOString());
  assert.equal(first.heartbeat_count,1);
  assert.equal(monitorsDb.history(user,row.id)[0].total_tokens,0);
  assert.equal(await pollMonitorProbes(new Date(now.getTime()+15000)),0);
  assert.equal(await pollMonitorProbes(new Date(now.getTime()+179000)),0);
  assert.equal(await pollMonitorProbes(new Date(now.getTime()+181000)),1);
  assert.equal(monitorsDb.due(new Date(now.getTime()+86400000)).some(item=>item.id===row.id),false);
  assert.equal(monitorsDb.get(user,row.id)?.model_round_count,0);
  monitorsDb.action(user,row.id,'run-now');
  assert.equal(monitorsDb.due(new Date(Date.now()+1000)).some(item=>item.id===row.id),true);
  assert.match(monitorsDb.get(user,row.id)?.last_event_json||'',/用户手动立即运行/);
}));

test('event prompts retain all intervening deltas and clear them only at a model round',async()=>fixture(async(user,root)=>{
  const log=path.join(root,'progress.log'); await writeFile(log,'BASELINE_OLD 1/40 status=running\n');
  const row=monitorsService.create(user,{sessionId:'probe-session',name:'Incremental regression',content:'read only',intervalMinutes:1,probe:{items:[{type:'file',path:log},{type:'patterns',patterns:['ERROR']}]}});
  const now=new Date(); await runProbe(row,now); monitorsDb.markModelRound(row.id);
  await writeFile(log,'BASELINE_OLD 1/40 status=running\nDELTA_ONE 2/40\n');
  await runProbe(monitorsDb.get(user,row.id)!,new Date(now.getTime()+180000));
  await writeFile(log,'BASELINE_OLD 1/40 status=running\nDELTA_ONE 2/40\nERROR DELTA_TWO\n');
  const event=await runProbe(monitorsDb.get(user,row.id)!,new Date(now.getTime()+360000));
  assert.equal(event?.type,'error'); assert.match(event?.delta||'',/DELTA_ONE/); assert.match(event?.delta||'',/DELTA_TWO/); assert.doesNotMatch(event?.delta||'',/BASELINE_OLD/);
  const runId=monitorsDb.claim(row.id,new Date(now.getTime()+361000))!; assert.ok(runId);
  const round=await prepareIsolatedRound(monitorsDb.get(user,row.id)!,runId);
  assert.match(round.content||'',/不要重新全面排查/); assert.match(round.content||'',/探针字段（前）/); assert.doesNotMatch(round.content||'',/BASELINE_OLD/);
  monitorsDb.markModelRound(row.id); assert.equal(JSON.parse(monitorsDb.get(user,row.id)!.probe_state_json!).pendingDelta,undefined);
  monitorsDb.finish(row.id,runId,null); assert.equal(monitorsDb.get(user,row.id)?.last_event_json,null);
}));

test('file-only stalls trigger and process death remains a single event while other fields advance',async()=>fixture(async(user,root)=>{
  const log=path.join(root,'STATUS.md'); await writeFile(log,'Working on the task\n');
  const row=monitorsService.create(user,{sessionId:'probe-session',name:'File stall',content:'read',intervalMinutes:1,probe:{stallMinutes:1,items:[{type:'file',path:log}]}});
  const now=new Date(); assert.equal(await runProbe(row,now),null);
  assert.equal((await runProbe(monitorsDb.get(user,row.id)!,new Date(now.getTime()+61000)))?.type,'stall');
  assert.equal(await runProbe(monitorsDb.get(user,row.id)!,new Date(now.getTime()+121000)),null);
  const processRow=monitorsService.create(user,{sessionId:'probe-session',name:'Death latch',content:'read',intervalMinutes:1,probe:{items:[{type:'file',path:log},{type:'process',pid:2147483647}]}});
  assert.equal((await runProbe(processRow,now))?.type,'dead');
  await writeFile(log,'Working on the task\n2/40 status=running\n');
  assert.equal(await runProbe(monitorsDb.get(user,processRow.id)!,new Date(now.getTime()+61000)),null);
  const heartbeatCount=getConnection().prepare("SELECT COUNT(*) count FROM monitor_runs WHERE monitor_id=? AND status='heartbeat'").get(processRow.id) as {count:number};
  assert.equal(heartbeatCount.count,1);
  assert.equal(await runProbe(monitorsDb.get(user,row.id)!,new Date(now.getTime()+181000)),null);
  assert.equal((await runProbe(monitorsDb.get(user,row.id)!,new Date(now.getTime()+242000)))?.type,'stall');
  assert.equal(await runProbe(monitorsDb.get(user,row.id)!,new Date(now.getTime()+303000)),null);
  assert.equal((await runProbe(monitorsDb.get(user,row.id)!,new Date(now.getTime()+10801000)))?.type,'heartbeat');
}));

test('UTF-8 event deltas retain head and tail within 8 KiB',async()=>fixture(async(user,root)=>{
  const log=path.join(root,'large.log'); await writeFile(log,'ERROR HEAD_ERROR\n'+'中文进度'.repeat(3000)+'\nTAIL_MARKER');
  const row=monitorsService.create(user,{sessionId:'probe-session',name:'Byte bound',content:'read',intervalMinutes:1,probe:{items:[{type:'file',path:log},{type:'patterns',patterns:['ERROR']}]}});
  const event=await runProbe(row); assert.equal(event?.type,'error');
  assert.ok(Buffer.byteLength(event!.delta!,'utf8')<=8192); assert.match(event!.delta!,/HEAD_ERROR/); assert.match(event!.delta!,/TAIL_MARKER/);
}));

test('Windows BOM JSON reads root status without promoting nested historical completion',async()=>fixture(async(user,root)=>{
  const done=path.join(root,'DONE.json');
  await writeFile(done,'\uFEFF'+JSON.stringify({done:false,status:'running',error:null,history:[{status:'completed',error:'ERROR from an old attempt'}],notes:'An earlier check used status=completed 40/40'}));
  const row=monitorsService.create(user,{sessionId:'probe-session',name:'Windows JSON',content:'read',intervalMinutes:1,probe:{items:[{file:done}]}});
  assert.equal(await runProbe(row),null);
  const state=JSON.parse(monitorsDb.get(user,row.id)!.probe_state_json!);
  assert.equal(state.lastFields.status,'running'); assert.equal(state.lastFields.done,false);
  assert.equal(state.lastFields.progress,undefined); assert.equal(state.lastFields.history,undefined);
  assert.deepEqual(parseProbeFields(JSON.stringify({status:'running',notes:'status=completed 40/40'}),{}),{status:'running',notes:'status=completed 40/40'});
  await writeFile(done,'\uFEFF'+JSON.stringify({done:true,status:'completed'}));
  assert.equal((await runProbe(monitorsDb.get(user,row.id)!))?.type,'done');
}));

 test('keywords require explicitly configured patterns',async()=>fixture(async(user,root)=>{
 const log=path.join(root,'task.log');await writeFile(log,'1/4\n');
 const row=monitorsService.create(user,{sessionId:'probe-session',name:'Explicit patterns',content:'read',intervalMinutes:15,probe:{items:[{type:'file',path:log}]}});
 const t=new Date();assert.equal(await runProbe(row,t),null);await writeFile(log,'1/4\nERROR quoted failure\n');
 assert.equal(await runProbe(monitorsDb.get(user,row.id)!,new Date(t.getTime()+180000)),null);
}));

test('script stdout is the only trigger: silence/progress stay token-free even after heartbeat',async()=>fixture(async(user,root)=>{
  const now=new Date();
  const row=monitorsService.create(user,{sessionId:'probe-session',name:'Script',content:'script',intervalMinutes:15,probe:{script:'Write-Output \'{"type":"progress","progress":42}\'',heartbeatMinutes:1}});
  assert.equal(await runProbe(row,now),null);
  assert.equal(await runProbe(monitorsDb.get(user,row.id)!,new Date(now.getTime()+46*60000)),null);
  const saved=monitorsDb.get(user,row.id)!;
  assert.equal(saved.heartbeat_count,2);assert.equal(saved.model_round_count,0);
  assert.equal(JSON.parse(saved.probe_state_json!).progress,42);
}));

test('script event keys, multiline queue, cooldown, terminal exceptions and bounded state',async()=>fixture(async(user,root)=>{
  const row=monitorsService.create(user,{sessionId:'probe-session',name:'Script events',content:'script',intervalMinutes:15,probe:{script:'Write-Output \'{"type":"error","msg":"real failure","key":"error1"}\'; Write-Output \'{"type":"done","msg":"finished","key":"done1"}\''}});
  const now=new Date();
  const first=await runProbe(row,now);assert.equal(first?.type,'error');assert.equal(first.signature,'script:error1');assert.match(first.delta||'',/real failure/);
  const saved=monitorsDb.get(user,row.id)!;
  assert(Buffer.byteLength(saved.probe_state_json!)<=2048);
  assert(!saved.probe_state_json!.includes('"delta"'));
  assert.equal((await runProbe(saved,new Date(now.getTime()+60000)))?.type,'done');
  const state=JSON.parse(monitorsDb.get(user,row.id)!.probe_state_json!);assert(state.items.p0.eventCount>=2);
  monitorsDb.setProbe(user,row.id,normalizeProbe({script:'Write-Output \'hello world\''})!);
  const audit=getConnection().prepare('SELECT * FROM monitor_probe_audit WHERE monitor_id=?').all(row.id);assert.equal(audit.length,1);
}));

test('script without output never infers errors and stderr is diagnostic only',async()=>fixture(async(user,root)=>{
  const row=monitorsService.create(user,{sessionId:'probe-session',name:'Silent script',content:'script',intervalMinutes:1,probe:{script:'[Console]::Error.WriteLine("ERROR diagnostic"); exit 2'}});
  assert.equal(await runProbe(row),null);
  assert.match(monitorsDb.get(user,row.id)!.probe_error||'',/script exit 2/);
  assert.equal(normalizeProbe({script:' ',shell:'powershell'}),null);
}));
