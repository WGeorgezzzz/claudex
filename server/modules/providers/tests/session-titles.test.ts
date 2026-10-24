import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getCurrentUserContext } from '@/modules/auth/index.js';
import { userContextStorage } from '@/shared/utils.js';
import type { UserRuntimeContext,NormalizedMessage } from '@/shared/types.js';
import { buildTemporaryTitle, validateSessionTitle } from '@/modules/providers/services/session-title-text.service.js';
import { createSessionTitlesService } from '@/modules/providers/services/session-titles.service.js';
import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

test('temporary titles clean Markdown, code blocks and URLs with Unicode and word bounds', () => {
  assert.equal(buildTemporaryTitle('这是很长的一段中文需求描述需要生成一个简短的标题'), '这是很长的一段中文需求描述需要生…');
  assert.equal(buildTemporaryTitle('one two three four five six seven'), 'one two three four five six…');
  assert.equal(buildTemporaryTitle('\n# **登录页面** https://example.com\n第二行'), '登录页面');
  assert.equal(buildTemporaryTitle('```js\nconsole.log(1)\n```\n> 修复登录页面'), '修复登录页面');
  assert.equal(buildTemporaryTitle('[Build](https://example.com) the `app`'), 'Build the app');
  assert.equal(buildTemporaryTitle(' \nhttps://example.com'), '新对话');
  assert.equal(buildTemporaryTitle('', 'en'), 'New chat');
});

test('structured title validation rejects instructions, punctuation and invalid bounds', () => {
  assert.equal(validateSessionTitle({ title: '用户登录故障排查' }), '用户登录故障排查');
  assert.equal(validateSessionTitle({ title: 'Login failure investigation' }), 'Login failure investigation');
  for (const title of ['帮我解决登录问题', '请修复登录错误', '登录对话总结', '登录会话总结', '太短', '"Login investigation"', 'Login investigation.', 'one two three four five six seven', '登录故障\n解决办法']) {
    assert.throws(() => validateSessionTitle({ title }));
  }
});

function harness(fail = false) {
  const rows = new Map<string, NonNullable<ReturnType<typeof sessionsDb.getSessionById>>>();
  const messages: NormalizedMessage[] = [
    { id: 'u', sessionId: 's', provider: 'codex', timestamp: new Date().toISOString(), kind: 'text', role: 'user', content: '请修复登录页面跳转后出现的错误' },
    { id: 'a', sessionId: 's', provider: 'codex', timestamp: new Date().toISOString(), kind: 'text', role: 'assistant', content: '可以检查跳转地址和登录状态。' },
  ];
  let calls = 0, active = 0, peak = 0;
  const gates: Array<() => void> = [];
  const userIds: Array<number | undefined> = [];
  const add = (id: string) => rows.set(id, { owner_id: 1, session_id: id, provider: 'codex', provider_session_id: id, project_path: null, jsonl_path: null, custom_name: messages[0].content!, title_source: 'auto', title_auto_attempted: 0, title_revision: 0, model: 'session-model', effort: null, forked_from_session_id: null, isArchived: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  const service = createSessionTitlesService({
    read: id => rows.has(id) ? { ...rows.get(id)! } : null,
    history: async () => messages,
    claim: id => { const row = rows.get(id)!; if (row.title_auto_attempted || (row.title_source && row.title_source !== 'auto')) return false; row.title_auto_attempted = 1; return true; },
    apply: (id, title, revision, manual) => { const row = rows.get(id)!; if (row.title_revision !== revision || (!manual && row.title_source !== 'auto' && row.title_source !== null)) return false; row.custom_name = title; row.title_source = 'ai'; row.title_revision++; return true; },
    generate: async (provider, context, model) => { assert.equal(provider, 'codex'); assert.equal(model, 'session-model'); assert.equal(context.user, messages[0].content); userIds.push(getCurrentUserContext()?.userId); calls++; active++; peak = Math.max(peak, active); await new Promise<void>(r => gates.push(r)); active--; if (fail) throw new Error('quota'); return '用户登录故障排查'; },
    broadcast: async () => {}, running: () => false,
  });
  const flush = async () => { await new Promise(r => setImmediate(r)); };
  return { rows, messages, add, service, gates, userIds, flush, stats: () => ({ calls, peak }) };
}

test('automatic attempts deduplicate; user renames invalidate pending results; manual can rename user titles', async () => {
  const h = harness(); h.add('s');
  const first = h.service.generate('s', 'completed'), duplicate = h.service.generate('s', 'completed');
  await h.flush(); assert.equal(h.stats().calls, 1);
  const row = h.rows.get('s')!; row.custom_name = '用户指定名称'; row.title_source = 'user'; row.title_revision++;
  h.gates.shift()!(); assert.equal((await first)?.status, 'stale'); await duplicate;
  assert.equal(row.custom_name, '用户指定名称');
  assert.equal((await h.service.generate('s', 'completed'))?.status, 'skipped');
  const manual = h.service.generate('s', 'manual'); await h.flush(); h.gates.shift()!();
  assert.equal((await manual)?.status, 'ready'); assert.equal(row.title_source, 'ai');
});

test('FIFO bounds concurrency at two and queue at fifty; failures never repeat automatic model calls', async () => {
  const h = harness(); const promises = [];
  for (let i = 0; i < 52; i++) { h.add(String(i)); promises.push(h.service.generate(String(i), 'completed')); }
  h.add('overflow'); await assert.rejects(h.service.generate('overflow', 'completed'), /busy/);
  await h.flush(); assert.equal(h.stats().calls, 2);
  while (h.gates.length) { h.gates.splice(0).forEach(fn => fn()); await h.flush(); }
  await Promise.all(promises); assert.equal(h.stats().peak, 2); assert.equal(h.stats().calls, 52);
  assert.equal((await h.service.generate('0', 'completed'))?.status, 'skipped');
});

test('open backfill accepts only recent prompt-prefix names and supported providers', async () => {
  const h = harness();
  for (const id of ['old', 'named', 'cursor', 'eligible']) h.add(id);
  h.rows.get('old')!.updated_at = '2000-01-01T00:00:00Z';
  h.rows.get('named')!.custom_name = 'Existing provider summary';
  h.rows.get('cursor')!.provider = 'cursor';
  assert.equal((await h.service.generate('old', 'opened'))?.status, 'skipped');
  assert.equal((await h.service.generate('named', 'opened'))?.status, 'skipped');
  assert.equal((await h.service.generate('cursor', 'opened'))?.status, 'unsupported');
  const pending = h.service.generate('eligible', 'opened'); await h.flush(); h.gates.shift()!();
  assert.equal((await pending)?.status, 'ready');
});

test('database migration and synchronizer preserve user > AI > provider > auto priority', async () => {
  const previous = process.env.DATABASE_PATH, dir = await mkdtemp(path.join(os.tmpdir(), 'title-db-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(dir, 'copy.db');
  try {
    await initializeDatabase(); await initializeDatabase();
    sessionsDb.createSession('native', 'codex', '/tmp/title-priority', 'provider name');
    assert.equal(sessionsDb.claimAutomaticTitle('native'), true);
    assert.equal(sessionsDb.claimAutomaticTitle('native'), false);
    assert.equal(sessionsDb.applyAiTitle('native', '用户登录故障排查', 0, false, 'provider name'), true);
    sessionsDb.createSession('native', 'codex', '/tmp/title-priority', 'provider overwrite');
    assert.equal(sessionsDb.getSessionById('native')?.custom_name, '用户登录故障排查');
    const revision = sessionsDb.getSessionById('native')!.title_revision;
    sessionsDb.updateSessionCustomName('native', '用户标题');
    assert.equal(sessionsDb.applyAiTitle('native', '错误覆盖用户标题', revision, false), false);
    sessionsDb.createSession('native', 'codex', '/tmp/title-priority', 'another overwrite');
    assert.equal(sessionsDb.getSessionById('native')?.custom_name, '用户标题');
    sessionsDb.createAppSession('app', 'claude', '/tmp/title-priority', '临时标题');
    assert.equal(sessionsDb.getSessionById('app')?.title_source, 'auto');
  } finally { closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; await rm(dir, { recursive: true, force: true }); }
});


test('failed automatic generation persists its attempt and keeps the placeholder', async () => {
  const h = harness(true); h.add('failure');
  const first = h.service.generate('failure', 'completed');
  const rejected = assert.rejects(first, /quota/);
  await h.flush(); h.gates.shift()!(); await rejected;
  assert.equal((await h.service.generate('failure', 'completed'))?.status, 'skipped');
  assert.equal(h.stats().calls, 1); assert.equal(h.rows.get('failure')!.title_source, 'auto');
});


test('provider name changes during generation cannot overwrite a changed automatic placeholder', async () => {
  const previous = process.env.DATABASE_PATH, dir = await mkdtemp(path.join(os.tmpdir(), 'title-cas-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(dir, 'copy.db');
  try {
    await initializeDatabase();
    sessionsDb.createSession('native', 'codex', '/tmp/title-cas', 'first prompt');
    sessionsDb.createSession('native', 'codex', '/tmp/title-cas', 'provider summary');
    assert.equal(sessionsDb.applyAiTitle('native', '用户登录故障排查', 0, false, 'first prompt'), false);
    assert.equal(sessionsDb.getSessionById('native')?.custom_name, 'provider summary');
  } finally { closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; await rm(dir, { recursive: true, force: true }); }
});


test('queued titles retain the requesting user environment across another user completing', async () => {
  const h = harness(); for (const id of ['one','two','three']) h.add(id);
  const context = (userId: number): UserRuntimeContext => ({ userId, role: userId===1?'admin':'member', workRoot: null, allowedFolders: [], claudeConfigDir: '/private/'+userId+'/claude', codexHome: '/private/'+userId+'/codex', env: { CODEX_HOME: '/private/'+userId+'/codex' } });
  const first = userContextStorage.run(context(1), () => h.service.generate('one','completed'));
  const second = userContextStorage.run(context(1), () => h.service.generate('two','completed'));
  const third = userContextStorage.run(context(26), () => h.service.generate('three','completed'));
  await h.flush(); h.gates.splice(0).forEach(fn=>fn()); await h.flush(); h.gates.splice(0).forEach(fn=>fn());
  await Promise.all([first,second,third]); assert.deepEqual(h.userIds,[1,1,26]);
});

test('manual regeneration waits for a pending automatic result invalidated by a user rename', async () => {
  const h = harness(); h.add('s');
  const automatic = h.service.generate('s','completed'); await h.flush();
  h.rows.get('s')!.title_source='user'; h.rows.get('s')!.title_revision++;
  const manual = h.service.generate('s','manual');
  h.gates.shift()!(); assert.equal((await automatic).status,'stale');
  await h.flush(); assert.equal(h.stats().calls,2); h.gates.shift()!();
  assert.equal((await manual).status,'ready');
});

test('legacy prompt prefixes compare normalized whitespace from the old word-based naming rule', async () => {
  const h=harness();h.add('s');h.messages[0].content='https://example.com\n这个任务需要进行简短分析';h.rows.get('s')!.custom_name='https://example.com 这个任务需要进行简短分析';h.rows.get('s')!.title_source=null;
  const result=h.service.generate('s','opened');await h.flush();h.gates.shift()!();assert.equal((await result).status,'ready');
});
