import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, monitorsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { dispatchMonitors,shouldIsolateMonitor } from '@/modules/monitors/monitors.dispatcher.js';
import {initializeMonitorTables} from '@/modules/database/index.js';
import { monitorsService } from '@/modules/monitors/monitors.service.js';
import { preflight } from '@/modules/monitors/monitor-isolated.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { createCompleteMessage } from '@/shared/utils.js';
import {providerTokenUsageService} from '@/modules/providers/index.js';

async function fixture(check: (userId: number, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monitor-cost-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'test.db'); await initializeDatabase();
  try { const user = Number(userDb.createUser('cost-test', 'hash').id); sessionsDb.createAppSession('chat', 'claude', root, 'Chat'); await check(user, root); }
  finally { closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; await rm(root, { recursive: true, force: true }); }
}

function runtime(calls: Array<Record<string, unknown>>): ProviderRuntimeGateway {
  return { hasRuntime: () => true, hasBackgroundWork: () => false,
    run: async (_provider, _command, options, writer) => { calls.push(options); writer.send({ kind: 'text', role: 'assistant', content: 'ok<monitor-state>stable</monitor-state>' }); writer.send(createCompleteMessage({ provider: 'claude', sessionId: String(options.sessionId), exitCode: 0 })); },
    abort: async () => false, forceStop: async () => ({ killedPids: [] }), stopBackgroundTask: async () => false,
    resolveToolApproval: () => {}, getPendingApprovalsForSession: () => [] };
}

test('fingerprint covers file content and direct directory children', async () => fixture(async (_user, root) => {
  const file = path.join(root, 'evidence.txt'); const dir = path.join(root, 'evidence-dir');
  await (await import('node:fs/promises')).mkdir(dir); await writeFile(file, 'one');
  const first = await preflight('Read ' + file + ' and inspect ' + dir);
  await writeFile(file, 'two'); const second = await preflight('Read ' + file + ' and inspect ' + dir);
  assert.notEqual(first.fingerprint, second.fingerprint);
  await writeFile(path.join(dir, 'child.txt'), 'child'); const third = await preflight('Read ' + file + ' and inspect ' + dir);
  assert.notEqual(second.fingerprint, third.fingerprint);
}));

test('unchanged rounds skip the model and a stale real round is forced', async () => fixture(async (user, root) => {
  const file = path.join(root, 'check.txt'); await writeFile(file, 'same');
  const row = monitorsService.create(user, { sessionId: 'chat', name: 'Cost', content: 'Read ' + file, intervalMinutes: 1 });
  const calls: Array<Record<string, unknown>> = []; const rt = runtime(calls); const future = new Date(Date.now() + 120000);
  assert.equal(await dispatchMonitors(rt, future), 1); assert.equal(calls.length, 1);
  assert.equal(await dispatchMonitors(rt, new Date(Date.now() + 240000)), 1); assert.equal(calls.length, 1);
  assert.equal(monitorsDb.history(user, row.id)[0].error, '无变化，未调用模型。');
  getConnection().prepare("UPDATE monitor_runs SET finished_at=? WHERE monitor_id=? AND error IS NULL").run(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), row.id);
  assert.equal(await dispatchMonitors(rt, new Date(Date.now() + 20 * 60_000)), 1); assert.equal(calls.length, 2);
}));

test('escalation uses Opus once and the next changed round returns to Sonnet', async () => fixture(async (user, root) => {
  const file = path.join(root, 'check.txt'); await writeFile(file, 'one');
  const row = monitorsService.create(user, { sessionId: 'chat', name: 'Escalate', content: 'Read ' + file, intervalMinutes: 1 });
  getConnection().prepare("UPDATE monitors SET state_record='escalate: true' WHERE id=?").run(row.id);
  const calls: Array<Record<string, unknown>> = []; const rt = runtime(calls);
  assert.equal(await dispatchMonitors(rt, new Date(Date.now() + 120000)), 1); assert.equal(calls[0].model, 'claude-opus-5-5');
  await writeFile(file, 'two');
  assert.equal(await dispatchMonitors(rt, new Date(Date.now() + 240000)), 1); assert.equal(calls[1].model, 'claude-sonnet-5-5');
}));

test('monitor list defaults to active and paused summaries and supports stopped opt-in', async () => fixture(async user => {
  const active = monitorsService.create(user, { sessionId: 'chat', name: 'Active', content: 'Read', intervalMinutes: 1 });
  const stopped = monitorsService.create(user, { sessionId: 'chat', name: 'Stopped', content: 'Read', intervalMinutes: 1 }); monitorsService.action(user, stopped.id, 'stop');
  const list = monitorsService.listView(user); assert.equal(list.length, 1); assert.equal(list[0].id, active.id); assert.ok(!('options' in list[0]));
  assert.equal(monitorsService.listView(user, undefined, true).length, 2);
}));

test('inherited Opus migration keeps a rollback copy and preserves explicit new models',async()=>fixture(async user=>{
  const inherited=monitorsService.create(user,{sessionId:'chat',name:'Old',content:'Read',intervalMinutes:1});
  const explicit=monitorsService.create(user,{sessionId:'chat',name:'Explicit',content:'Read',intervalMinutes:1,options:{model:'claude-opus-5-5'}});
  const old=JSON.stringify({model:'claude-opus-5-5',effort:'high'});
  getConnection().prepare('UPDATE monitors SET options=? WHERE id=?').run(old,inherited.id);
  initializeMonitorTables(getConnection());
  assert.equal(JSON.parse(monitorsDb.get(user,inherited.id)!.options).model,'claude-sonnet-5-5');
  assert.equal(JSON.parse(monitorsDb.get(user,explicit.id)!.options).model,'claude-opus-5-5');
  assert.deepEqual(getConnection().prepare('SELECT options FROM monitor_model_migration_backup_20261029 WHERE id=?').get(inherited.id),{options:old});
}));

test('original context switches only above 120000 tokens',()=>{
  assert.equal(shouldIsolateMonitor('original',120000),false);
  assert.equal(shouldIsolateMonitor('original',120001),true);
  assert.equal(shouldIsolateMonitor('isolated',0),true);
});
test('provider usage retains distinct cache counts even when a round fails',async()=>fixture(async user=>{
  const row=monitorsService.create(user,{sessionId:'chat',name:'Usage',content:'Read',intervalMinutes:1});
  const now=new Date(Date.now()+120000),runId=monitorsDb.claim(row.id,now)!;
  monitorsDb.saveUsage(row.id,runId,{inputTokens:100,cacheReadTokens:60,cacheCreationTokens:30,outputTokens:5,used:105});
  monitorsDb.finish(row.id,runId,'failed after usage',now);
  const run=monitorsDb.history(user,row.id)[0];
  assert.equal(run.input_tokens,10);assert.equal(run.cache_read_tokens,60);assert.equal(run.cache_creation_tokens,30);assert.equal(run.output_tokens,5);assert.equal(run.total_tokens,105);assert.equal(run.status,'failed');
}));
test('dispatcher switches a large original session to isolated and persists the mode',async()=>fixture(async user=>{
  const row=monitorsService.create(user,{sessionId:'chat',name:'Original',content:'Read',intervalMinutes:1,options:{runMode:'original'}});
  const original=providerTokenUsageService.getSessionTokenUsage;
  providerTokenUsageService.getSessionTokenUsage=async()=>({used:120001,inputTokens:120001,outputTokens:0,breakdown:{input:120001,output:0}});
  try{const calls:Array<Record<string,unknown>>=[];await dispatchMonitors(runtime(calls),new Date(Date.now()+120000));assert.notEqual(calls[0].sessionId,'chat');assert.equal(JSON.parse(monitorsDb.get(user,row.id)!.options).runMode,'isolated');}
  finally{providerTokenUsageService.getSessionTokenUsage=original;}
}));

test('summary pages stay below 20KB with long Chinese prompts and names',async()=>fixture(async user=>{
  for(let i=0;i<25;i++)monitorsService.create(user,{sessionId:'chat',name:'测'.repeat(120),content:'测'.repeat(20000),intervalMinutes:1});
  const page=monitorsService.listView(user);assert.equal(page.length,10);assert.ok(Buffer.byteLength(JSON.stringify(page))<20000);
  assert.equal(monitorsService.listView(user,undefined,false,20).length,5);
}));
