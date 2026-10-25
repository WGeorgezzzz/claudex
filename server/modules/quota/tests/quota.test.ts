import assert from 'node:assert/strict';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import { createQuotaCache, createQuotaService } from '../quota.service.js';
import { initializeQuotaTables, recordCreditSnapshot } from '../quota.db.js';

function fixture() {
  const db = new Database(':memory:'); initializeQuotaTables(db);
  let now = Date.parse('2026-10-26T02:00:00Z'), failClaude = false, balance = '100000000000000000000.1234567890123';
  let fiveHour: unknown = 0, sevenDay: unknown = 0.99, overrides: Record<string, unknown> = {};
  const calls: { url: string; init: RequestInit }[] = [];
  const secret = 'admin-key-secret', token = 'claude-token-secret', keys = ['member-key-secret', 'other-key-secret'];
  const paths = (id: number) => ({ adminClaude: '/claude', adminCodex: '/codex', configRoot: '/users', root: '/users/2', claudeConfigDir: '/claude', codexHome: '/codex/' + id });
  const service = createQuotaService({ relayBaseUrl: 'https://relay.example.com', paths, db: () => db, secretFile: '/secret', now: () => now,
    password: async () => { throw Error('API key should take precedence'); },
    readJson: async file => file === '/secret' ? { apiKey: secret, baseUrl: 'https://relay.example.com' } : file.endsWith('.credentials.json') ? { claudeAiOauth: { accessToken: token } } : file.replaceAll('\\', '/').includes('/4/') ? { tokens: { access_token: 'chatgpt-login-secret' } } : { OPENAI_API_KEY: file.replaceAll('\\', '/').includes('/3/') ? keys[1] : keys[0] },
    request: async (url, init) => {
      calls.push({ url, init });
      assert(!/reset|responses|messages/.test(url));
      if (url.includes('anthropic')) return failClaude ? new Response('{"secret":"do not expose"}', { status: 401 }) : Response.json({ five_hour: { utilization: 55, resets_at: '2026-10-26T04:00:00Z' }, seven_day: { utilization: 76, severity: 'warning' }, limits: [{ kind: 'weekly', percent: 12, severity: 'warning', scope: { model: { display_name: 'Fable' } } }], extra_usage: { is_enabled: false }, accessToken: token });
      if (url.includes('/v1/usage')) {
        const auth = (init.headers as Record<string, string>).Authorization;
        return Response.json({ balance: auth.endsWith(keys[0]) ? 123 : 321, daily_usage: [{ date: '2026-10-26', requests: 1, total_tokens: 20, actual_cost: 0.1 }, { date: '2026-10-20', requests: 2, total_tokens: 40, actual_cost: 0.2 }, { date: '2026-10-01', requests: 4, total_tokens: 80, actual_cost: 0.4 }], key: keys[0], credentials: secret });
      }
      if (url.includes('advanced-settings')) return Response.json({ data: { openai_account_quota_auto_pause: { default_threshold_5h: fiveHour, default_threshold_7d: sevenDay } } });
      if (url.includes('accounts?')) return Response.json({ data: { items: [{ id: 1, type: 'oauth', platform: 'openai' }, { id: 2, type: 'apikey', platform: 'openai' }] } });
      if (url.endsWith('/usage')) return Response.json({ data: { seven_day: { window_stats: { requests: 5, tokens: 100, cost: 0.01 } } } });
      return Response.json({ data: { id: 1, name: 'demo-account-a', status: 'active', schedulable: false, credentials: secret, extra: { ...overrides, codex_5h_used_percent: 12, codex_7d_used_percent: 95, codex_usage_updated_at: new Date(now).toISOString(), codex_credits_snapshot: { credits: { balance }, fetched_at: Math.floor(now / 1000) } } } });
    } });
  return { service, db, calls, keys, advance: () => { now += 120001; }, expire: () => { failClaude = true; now += 120001; }, debit: () => { balance = '100000000000000000000.1234567890122'; },
    thresholds: (five: unknown, seven: unknown) => { fiveHour = five; sevenDay = seven; }, overrides: (value: Record<string, unknown>) => { overrides = value; } };
}

test('Claude parsing, cache and concurrent single flight do not leak credentials', async () => {
  const f = fixture(); try {
    const results = await Promise.all(Array.from({ length: 12 }, () => f.service.overview({ userId: 1, role: 'admin' })));
    assert.equal(f.calls.filter(c => c.url.includes('anthropic')).length, 1);
    assert.equal(f.calls.filter(c => c.url.includes('accounts?')).length, 1);
    const result = results[0]; assert.equal(result.claude.data?.windows[0].percent, 55);
    assert.equal(result.claude.data?.windows[1].severity, 'warning'); assert.equal(result.claude.data?.windows[2].label, 'Fable');
    assert.equal(result.pool?.data?.accounts.length, 1); assert.equal(result.pool?.data?.accounts[0].windows[1].stats?.requests, 5);
    assert.equal(result.pool?.data?.accounts[0].schedulable, false);
    assert(!/key-secret|token-secret|credentials|accessToken|Authorization/.test(JSON.stringify(result)));
    assert.equal((f.calls[0].init.headers as Record<string, string>)['anthropic-beta'], 'oauth-2025-04-20');
  } finally { f.db.close(); }
});
test('401 retains prior data, exposes actionable message and backs off without refresh-token calls', async () => {
  const f = fixture(); try {
    await f.service.overview({ userId: 2, role: 'member' }); f.expire();
    const result = await f.service.overview({ userId: 2, role: 'member' });
    assert.equal(result.claude.data?.windows[0].percent, 55); assert.equal(result.claude.error, '凭据过期，等待 Claude CLI 自动刷新');
    await f.service.overview({ userId: 2, role: 'member' }); assert.equal(f.calls.filter(c => c.url.includes('anthropic')).length, 2);
  } finally { f.db.close(); }
});
test('members cannot trigger pool and user-scoped key history aggregates today, seven and thirty days', async () => {
  const f = fixture(); try {
    const result = await f.service.overview({ userId: 2, role: 'member' });
    assert(!('pool' in result)); assert(!f.calls.some(c => c.url.includes('/admin/')));
    assert(result.key.data && 'last7d' in result.key.data);
    assert.equal(result.key.data?.last7d.requests, 3); assert.equal(result.key.data?.last30d.requests, 7);
    assert.equal(result.key.data?.balance, 123);
    assert(!JSON.stringify(result).includes('demo-account-a'));
    const other = await f.service.overview({ userId: 3, role: 'member' }); assert.equal(f.calls.filter(c => c.url.includes('/v1/usage')).length, 2);
    assert(other.key.data && 'balance' in other.key.data); assert.equal(other.key.data.balance, 321);
    const direct = await f.service.overview({ userId: 4, role: 'member' }); assert.equal(direct.key.data?.mode, 'not_relay'); assert.equal(f.calls.filter(c => c.url.includes('/v1/usage')).length, 2);
  } finally { f.db.close(); }
});
test('sub-decimal credit debit is exact, durable, and unchanged balances do not erase alert', async () => {
  const f = fixture(); try {
    await f.service.refreshPool(); f.debit(); f.advance();
    const result = await f.service.refreshPool(); assert.equal(result.data?.accounts[0].consumed, '0.0000000000001');
    assert.match(result.data!.warnings.join(' '), /demo-account-a 点数被消耗 0\.0000000000001/);
    f.advance(); const next = await f.service.refreshPool(); assert.equal(next.data?.accounts[0].consumed, null); assert.equal(next.data?.accounts[0].alerts.length, 1);
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM quota_credit_snapshots').get() as { n: number }).n, 3);
  } finally { f.db.close(); }
});
test('only global seven-day thresholds warn when unknown, nonpositive or above .99', async () => {
  const f = fixture(); try {
    assert.equal((await f.service.refreshPool()).data?.warnings.length, 0);
    for (const five of [null, 0, -1, 1, 'invalid']) {
      for (const seven of [0.0001, 0.95, 0.99, '0.99']) {
        f.thresholds(five, seven); f.advance();
        assert.deepEqual((await f.service.refreshPool()).data?.warnings, [], `5h=${five}, 7d=${seven}`);
      }
    }
    for (const seven of [null, undefined, '', 'invalid', -1, 0, 0.990001, 1]) {
      f.thresholds(0, seven); f.advance();
      const warnings = (await f.service.refreshPool()).data!.warnings;
      assert.equal(warnings.length, 1); assert.match(warnings[0], /7 天.*不超过 0\.99/);
      assert(!warnings[0].includes('0.95'));
    }
  } finally { f.db.close(); }
});
test('account seven-day disable and unsafe overrides warn; five-hour overrides only display', async () => {
  const f = fixture(); try {
    for (const five of [0, -1, 1, null]) {
      f.overrides({ auto_pause_5h_disabled: true, auto_pause_5h_threshold: five, auto_pause_7d_threshold: 0.99 }); f.advance();
      const result = (await f.service.refreshPool()).data!;
      assert.deepEqual(result.warnings, []);
      assert.deepEqual(result.accounts[0].autoPause, { fiveHour: { disabled: true, threshold: five }, sevenDay: { disabled: false, threshold: 0.99 } });
    }
    for (const extra of [{ auto_pause_7d_disabled: true }, ...[-1, 0, 0.990001, 1].map(v => ({ auto_pause_7d_threshold: v }))]) {
      f.overrides(extra); f.advance();
      const result = (await f.service.refreshPool()).data!;
      assert.equal(result.warnings.length, 1); assert.match(result.warnings[0], /demo-account-a 7d/);
    }
    f.overrides({}); f.advance(); assert.deepEqual((await f.service.refreshPool()).data?.warnings, []);
    f.overrides({ auto_reset_credit_enabled: true }); f.advance();
    assert.match((await f.service.refreshPool()).data!.warnings.join(' '), /上游已启用点数重置/);
  } finally { f.db.close(); }
});
test('cache marks stale data, sanitizes raw errors and backs off from failed initial refresh', async () => {
  let now = 0, fail = false, requests = 0;
  const cache = createQuotaCache(async () => { requests++; if (fail) throw Error('secret-password'); return 7; }, () => now);
  assert.equal((await cache()).data, 7); fail = true; now = 900001;
  const old = await cache(); assert(old.stale); assert.equal(old.data, 7); assert(!old.error?.includes('secret'));
  await cache(); assert.equal(requests, 2);
  const cold = createQuotaCache(async () => { throw Error('token'); }, () => now); assert((await cold()).stale);
});
test('decimal normalization avoids false debit and invalid balances do not corrupt history', () => {
  const db = new Database(':memory:'); initializeQuotaTables(db);
  try { recordCreditSnapshot(db, 1, 'demo-account-a', '1.0', 'a', null); assert.equal(recordCreditSnapshot(db, 1, 'demo-account-a', '1.0000', 'b', null).consumed, null); assert.throws(() => recordCreditSnapshot(db, 1, 'demo-account-a', 'bad', 'c', null)); assert.equal(recordCreditSnapshot(db, 1, 'demo-account-a', '0.9', 'd', null).consumed, '0.1'); }
  finally { db.close(); }
});

test('credit history and alerts stay separate when two relays reuse an account id', () => {
  const db = new Database(':memory:'); initializeQuotaTables(db);
  try {
    recordCreditSnapshot(db, 1, 'demo', '100', 'a', null, 'https://first.example.com');
    const next = recordCreditSnapshot(db, 1, 'demo', '1', 'b', null, 'https://second.example.com');
    assert.equal(next.consumed, null); assert.deepEqual(next.alerts, []);
    assert.equal(recordCreditSnapshot(db, 1, 'demo', '99', 'c', null, 'https://first.example.com').consumed, '1');
    assert.deepEqual(recordCreditSnapshot(db, 1, 'demo', '1', 'd', null, 'https://second.example.com').alerts, []);
  } finally { db.close(); }
});

test('an explicitly identified legacy relay retains its balance chain and durable alerts', () => {
  const db = new Database(':memory:'); initializeQuotaTables(db);
  try {
    recordCreditSnapshot(db, 1, 'demo', '100', 'a', null);
    recordCreditSnapshot(db, 1, 'demo', '99', 'b', null);
    initializeQuotaTables(db, 'https://original.example.com');
    const original = recordCreditSnapshot(db, 1, 'demo', '98', 'c', null, 'https://original.example.com');
    assert.equal(original.consumed, '1'); assert.equal(original.alerts.length, 2);
    const other = recordCreditSnapshot(db, 1, 'demo', '1', 'd', null, 'https://other.example.com');
    assert.equal(other.consumed, null); assert.deepEqual(other.alerts, []);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM quota_credit_snapshots WHERE relay_url='' ").get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test('JWT fallback coalesces login, relogs once on 401 and never returns the password or JWT', async () => {
  let now = 0, loginCount = 0, rejectOld = false;
  const db = new Database(':memory:'); initializeQuotaTables(db);
  const service = createQuotaService({ db: () => db, paths: () => ({ adminClaude: '/claude', adminCodex: '/codex', configRoot: '/users', root: '/users/1', claudeConfigDir: '/claude', codexHome: '/codex' }),
    relayBaseUrl: 'https://relay.example.com', secretFile: '/secret', now: () => now, password: async () => 'password-secret', readJson: async () => ({ baseUrl: 'https://relay.example.com', email: 'admin@example.com' }),
    request: async (url, init) => {
      if (url.endsWith('/auth/login')) { loginCount++; assert.equal(init.method, 'POST'); return Response.json({ data: { access_token: 'jwt-secret-' + loginCount, expires_in: 3600 } }); }
      assert(!init.method || init.method === 'GET');
      if (rejectOld && (init.headers as Record<string, string>).Authorization === 'Bearer jwt-secret-1') return new Response('', { status: 401 });
      return Response.json({ data: url.includes('accounts?') ? { items: [] } : { openai_account_quota_auto_pause: { default_threshold_5h: 0.95, default_threshold_7d: 0.95 } } });
    } });
  try { await Promise.all([service.refreshPool(), service.refreshPool()]); assert.equal(loginCount, 1); now += 120001; rejectOld = true; const result = await service.refreshPool(); assert.equal(loginCount, 2); assert(!/jwt-secret|password-secret/.test(JSON.stringify(result))); }
  finally { db.close(); }
});

test('relay transient failures stop after two retries and do not expose raw error payloads', async () => {
  let count = 0;
  const service = createQuotaService({ db: () => { throw Error('Unused'); }, paths: () => ({ adminClaude: '/claude', adminCodex: '/codex', configRoot: '/users', root: '/users/2', claudeConfigDir: '/claude', codexHome: '/codex' }),
    relayBaseUrl: 'https://relay.example.com', secretFile: '/secret', password: async () => 'unused', readJson: async file => file.endsWith('auth.json') ? { OPENAI_API_KEY: 'key-secret' } : {},
    request: async (_url, init) => { count++; assert.equal(init.redirect, 'error'); assert(init.signal); return new Response('key-secret', { status: 503 }); } });
  const result = await service.overview({ userId: 2, role: 'member' }); assert.equal(count, 3); assert.equal(result.key.data, null); assert(!JSON.stringify(result).includes('key-secret'));
});
