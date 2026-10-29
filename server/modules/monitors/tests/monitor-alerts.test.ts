import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, monitorsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { sessionsService, providerTokenUsageService } from '@/modules/providers/index.js';
import { monitorsService } from '@/modules/monitors/monitors.service.js';
import { runProbe } from '@/modules/monitors/monitor-probe.service.js';
import { finishMonitorReport } from '@/modules/monitors/monitor-isolated.service.js';

async function fixture(check:(user:number,root:string)=>Promise<void>) {
  const root=await mkdtemp(path.join(os.tmpdir(),'monitor-alerts-')); const previous=process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH=path.join(root,'test.db'); await initializeDatabase();
  try { const user=Number(userDb.createUser('alerts-test','hash').id); sessionsDb.createAppSession('alerts-session','claude',root,'Alerts'); await check(user,root); }
  finally { closeConnection(); if(previous===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previous; await rm(root,{recursive:true,force:true}); }
}

test('agent transcripts ignore keyword echoes and only accept terminal EXIT lines',async()=>fixture(async(user,root)=>{
  const file=path.join(root,'codex-run-1.log');
  await writeFile(file,'ERROR quoted from a command\nTraceback (most recent call last):\n+ERROR diff\nstatus=completed\n');
  const row=monitorsService.create(user,{sessionId:'alerts-session',name:'Agent',content:'read',intervalMinutes:15,probe:{items:[{type:'file',path:file},{type:'patterns',patterns:['ERROR','Traceback']}]}});
  const now=new Date(); assert.equal(await runProbe(row,now),null);
  await writeFile(file,'ERROR quoted from a command\nTraceback (most recent call last):\n+ERROR diff\nstatus=completed\nEXIT 1\n');
  assert.equal((await runProbe(monitorsDb.get(user,row.id)!,new Date(now.getTime()+180000)))?.type,'done');
}));

test('task alerts match line starts and cool down repeated signatures until the monitor interval',async()=>fixture(async(user,root)=>{
  const file=path.join(root,'task.log'); let text='quoted ERROR in a sentence\n+ERROR diff\n-Traceback removed\n> ERROR command echo\n'; await writeFile(file,text);
  const row=monitorsService.create(user,{sessionId:'alerts-session',name:'Task',content:'read',intervalMinutes:15,probe:{items:[{type:'file',path:file},{type:'patterns',patterns:['ERROR','Traceback']}]}});
  const now=new Date(); assert.equal(await runProbe(row,now),null);
  text+='ERROR task failed\n'; await writeFile(file,text);
  const first=await runProbe(monitorsDb.get(user,row.id)!,new Date(now.getTime()+180000)); assert.equal(first?.type,'error');
  for(let minute=6;minute<=15;minute+=3) { text+='ERROR task failed\n'; await writeFile(file,text); assert.equal(await runProbe(monitorsDb.get(user,row.id)!,new Date(now.getTime()+minute*60000)),null); }
  const next=await runProbe(monitorsDb.get(user,row.id)!,new Date(now.getTime()+18*60000)); assert.equal(next?.type,'error'); assert.match(next?.evidence||'',/累计 4/);
  const stored=monitorsDb.get(user,row.id)!; assert.ok(Buffer.byteLength(stored.probe_state_json!)<=2048);
  assert.doesNotMatch(stored.probe_state_json!,/task failed|pendingDelta|lastDelta/); assert.doesNotMatch(stored.last_event_json!,/task failed|"delta"/);
}));

test('suppression is persisted in probe settings and removable without resetting offsets',async()=>fixture(async(user,root)=>{
  const file=path.join(root,'STATUS.md'); await writeFile(file,'ERROR known harmless case\n');
  const row=monitorsService.create(user,{sessionId:'alerts-session',name:'Suppress',content:'read',intervalMinutes:15,probe:{suppress:['ERROR'],items:[{type:'file',path:file},{type:'patterns',patterns:['ERROR','Traceback']}]}});
  assert.equal(await runProbe(row),null); const before=monitorsDb.get(user,row.id)!.probe_state_json;
  monitorsService.update(user,row.id,{suppress:[]}); assert.equal(monitorsDb.get(user,row.id)!.probe_state_json,before);
  await writeFile(file,'ERROR known harmless case\nERROR new failure\n');
  assert.equal((await runProbe(monitorsDb.get(user,row.id)!))?.type,'error');
}));

test('model feedback adds a suppression signature and legacy API payloads exclude raw deltas',async()=>fixture(async(user,root)=>{
  const file=path.join(root,'STATUS.md'); await writeFile(file,'ERROR known case\n');
  const row=monitorsService.create(user,{sessionId:'alerts-session',name:'Feedback',content:'read',intervalMinutes:15,probe:{items:[{type:'file',path:file},{type:'patterns',patterns:['ERROR','Traceback']}]}});
  const event=await runProbe(row); assert.ok(event?.signature);
  const runId=monitorsDb.claim(row.id,new Date(Date.now()+1000))!; assert.ok(runId);
  const fetch=sessionsService.fetchHistory,usage=providerTokenUsageService.getSessionTokenUsage;
  sessionsService.fetchHistory=async()=>({messages:[{role:'assistant',kind:'text',content:'False alarm\n<monitor-state>{"suppress":["'+event.signature+'"]}</monitor-state>'}]}) as Awaited<ReturnType<typeof fetch>>;
  providerTokenUsageService.getSessionTokenUsage=async()=>({used:0}) as Awaited<ReturnType<typeof usage>>;
  try { await finishMonitorReport(monitorsDb.get(user,row.id)!,runId,'alerts-session','',false); }
  finally { sessionsService.fetchHistory=fetch; providerTokenUsageService.getSessionTokenUsage=usage; }
  assert.deepEqual(JSON.parse(monitorsDb.get(user,row.id)!.probe_json!).suppress,[event.signature]);
  const huge='RAW_TRANSCRIPT_ERROR'.repeat(1000);
  getConnection().prepare('UPDATE monitors SET probe_state_json=?,last_event_json=? WHERE id=?').run(JSON.stringify({items:{p0:{offset:100,value:huge}},pendingDelta:huge,lastDelta:huge,lastFields:{message:huge}}),JSON.stringify({type:'error',evidence:huge,delta:huge}),row.id);
  const detail=monitorsService.detailView(user,row.id),list=monitorsService.listView(user)[0];
  assert.ok(Buffer.byteLength(detail.probe_state_json!)<=2048); assert.ok(JSON.stringify(list).length<4000); assert.doesNotMatch(detail.last_event_json!,/"delta"/);
  assert.equal(JSON.parse(detail.probe_state_json!).items.p0.offset,100);
}));

test('done and dead bypass cooldown while a failed error retry still respects the interval',async()=>fixture(async(user,root)=>{
  const file=path.join(root,'STATUS.md'); await writeFile(file,'ERROR first failure\n');
  const row=monitorsService.create(user,{sessionId:'alerts-session',name:'Retry',content:'read',intervalMinutes:15,probe:{items:[{type:'file',path:file},{type:'patterns',patterns:['ERROR','Traceback']}]}});
  const now=new Date(); assert.equal((await runProbe(row,now))?.type,'error');
  const runId=monitorsDb.claim(row.id,new Date(now.getTime()+1000))!; assert.ok(runId); monitorsDb.markModelRound(row.id); monitorsDb.finish(row.id,runId,'network failed');
  assert.equal(monitorsDb.due(new Date(now.getTime()+3*60000)).some(item=>item.id===row.id),false);
  assert.equal(monitorsDb.due(new Date(now.getTime()+16*60000)).some(item=>item.id===row.id),true);
  const dead=monitorsService.create(user,{sessionId:'alerts-session',name:'Death',content:'read',intervalMinutes:15,probe:{items:[{type:'process',pid:2147483647}]}});
  monitorsDb.markModelRound(dead.id); assert.equal((await runProbe(monitorsDb.get(user,dead.id)!,now))?.type,'dead');
  await writeFile(file,'ERROR first failure\nEXIT 0\n');
  assert.equal((await runProbe(monitorsDb.get(user,row.id)!,new Date(now.getTime()+4*60000)))?.type,'done');
}));
