import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { getConnection } from '@/modules/database/index.js';
import { resolveUserConfigPaths } from '@/modules/auth/index.js';

import { initializeQuotaTables, recordCreditSnapshot } from './quota.db.js';
import { quotaFetch } from './quota.http.js';

// Untrusted upstream JSON is projected field by field; never forward credentials or raw errors.
type Json = Record<string, any>;
type Window = { label: string; percent: number | null; resetsAt: string | null; severity: string; stats?: { requests: number | null; tokens: number | null; cost: number | null } };
const num = (v: unknown): number | null => (typeof v === 'number' || typeof v === 'string') && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const date = (v: unknown): string | null => typeof v === 'number' ? new Date(v * 1000).toISOString() : typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const stale = (at: string | null, now: number) => !at || now - Date.parse(at) > 900000;
function window(label: string, raw: Json = {}): Window {
  const percent = num(raw.utilization ?? raw.percent);
  return { label, percent, resetsAt: date(raw.resets_at), severity: percent !== null && percent >= 95 ? 'danger' : raw.severity === 'warning' ? 'warning' : 'normal',
    ...(raw.window_stats ? { stats: { requests: num(raw.window_stats.requests), tokens: num(raw.window_stats.tokens), cost: num(raw.window_stats.cost) } } : {}) };
}

/** Quota composition and module tests use a cache with single-flight refresh, bounded retries and sanitized failures. */
export function createQuotaCache<T>(load: () => Promise<T>, now = Date.now) {
  let data: T | null = null, updatedAt: string | null = null, error: string | null = null, next = 0, failures = 0;
  let pending: Promise<void> | null = null;
  return async () => {
    if (!pending && now() >= next) {
      pending = load().then(value => { data = value; updatedAt = new Date(now()).toISOString(); error = null; failures = 0; next = now() + 120000; })
        .catch(e => { error = e instanceof QuotaError ? e.message : '额度刷新失败，请稍后重试'; next = now() + Math.min(600000, 30000 * 2 ** Math.min(failures++, 5)); })
        .finally(() => { pending = null; });
    }
    await pending;
    return { data, updatedAt, stale: stale(updatedAt, now()), error, nextRefreshAt: new Date(next).toISOString() };
  };
}
class QuotaError extends Error {}

/** Quota routes and tests use this dependency-injected service; the identity is always supplied by auth middleware. */
export function createQuotaService(deps: {
  readJson: (file: string) => Promise<Json>; request: (url: string, init: RequestInit) => Promise<Response>;
  paths: typeof resolveUserConfigPaths; secretFile: string; password: () => Promise<string>;
  db: typeof getConnection; now?: () => number;
}) {
  const now = deps.now || Date.now;
  const base = 'https://api.qiaozhiw.com';
  let jwt: string | null = null, expires = 0;
  let login: Promise<string> | null = null;
  async function request(url: string, init: RequestInit = {}, retry = false): Promise<Json> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await deps.request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'nexagent-quota/1.0', ...init.headers } });
        if (response.status === 401) throw new QuotaError(url.startsWith('https://api.anthropic.com/') ? '凭据过期，等待 Claude CLI 自动刷新' : '中转凭据已失效');
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500) throw new Error('Transient upstream failure');
          throw new QuotaError(`额度接口返回 HTTP ${response.status}`);
        }
        return await response.json() as Json;
      } catch (e) {
        if (!retry || e instanceof QuotaError || attempt >= 2) throw e;
        await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  }
  async function adminHeaders(): Promise<Record<string, string>> {
    const secret = await deps.readJson(deps.secretFile).catch(() => ({} as Json));
    if (typeof secret.apiKey === 'string' && secret.apiKey) return { 'x-api-key': secret.apiKey };
    if (!jwt || now() >= expires) {
      login ||= (async () => {
        const password = await deps.password();
        const result = await request(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@sub2api.local', password }) }, true);
        if (typeof result.data?.access_token !== 'string') throw new QuotaError('中转管理员登录失败');
        jwt = result.data.access_token; expires = now() + Math.max(30, (num(result.data.expires_in) || 300) - 30) * 1000;
        return jwt!;
      })().finally(() => { login = null; });
      await login;
    }
    return { Authorization: 'Bearer ' + jwt };
  }
  async function adminGet(endpoint: string) {
    try { return (await request(base + endpoint, { headers: await adminHeaders() }, true)).data as Json; }
    catch (e) {
      if (jwt && e instanceof QuotaError && e.message === '中转凭据已失效') {
        jwt = null; expires = 0;
        return (await request(base + endpoint, { headers: await adminHeaders() }, true)).data as Json;
      }
      throw e;
    }
  }
  const claude = createQuotaCache(async () => {
    const file = path.join(deps.paths(1, 'admin').adminClaude, '.credentials.json');
    const credentials = await deps.readJson(file);
    const token = credentials.claudeAiOauth?.accessToken;
    if (typeof token !== 'string' || !token) throw new QuotaError('未找到 Claude 订阅凭据');
    const raw = await request('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.0' } });
    if (!raw.five_hour || !raw.seven_day) throw new QuotaError('Claude 额度响应不完整');
    const limits = Array.isArray(raw.limits) ? raw.limits : [];
    // limits also repeats the overall session/week windows; merge severity without duplicating bars.
    const fiveHour = window('5h', { ...raw.five_hour, severity: limits.find((l: Json) => l.kind === 'session')?.severity });
    const sevenDay = window('7 天', { ...raw.seven_day, severity: limits.find((l: Json) => l.kind === 'weekly_all')?.severity ?? raw.seven_day.severity });
    return { windows: [fiveHour, sevenDay, ...limits.filter((l: Json) => l.scope?.model || !['session', 'weekly_all'].includes(l.kind)).map((limit: Json) => window(String(limit.scope?.model?.display_name || limit.kind || '模型周额度'), limit))], extraUsageEnabled: raw.extra_usage?.is_enabled === true };
  }, now);
  const pool = createQuotaCache(async () => {
    const settings = await adminGet('/api/v1/admin/ops/advanced-settings');
    const policy = settings?.openai_account_quota_auto_pause;
    const thresholds = { fiveHour: num(policy?.default_threshold_5h), sevenDay: num(policy?.default_threshold_7d) };
    const warnings: string[] = [];
    for (const [label, v] of [['5h', thresholds.fiveHour], ['7 天', thresholds.sevenDay]] as const) {
      if (v === null || v <= 0 || v > 0.95) warnings.push(`${label} 自动暂停阈值 ${v ?? '未知'}，应大于 0 且不超过 0.95，存在点数消耗风险`);
    }
    const items: Json[] = [];
    for (let page = 1; ; page++) {
      const result = await adminGet(`/api/v1/admin/accounts?page=${page}&page_size=100`);
      if (!Array.isArray(result?.items)) throw new QuotaError('中转账号列表响应不完整');
      items.push(...result.items);
      if (result.items.length < 100 || items.length >= (Number(result.total) || Infinity)) break;
      if (page >= 100) throw new QuotaError('中转账号列表过大');
    }
    const accounts = [];
    for (const item of items.filter(a => a.platform === 'openai' && a.type === 'oauth')) {
      const account = await adminGet(`/api/v1/admin/accounts/${Number(item.id)}`);
      const usage = await adminGet(`/api/v1/admin/accounts/${Number(item.id)}/usage`);
      const extra = account.extra || {}, credit = extra.codex_credits_snapshot;
      const balance = typeof credit?.credits?.balance === 'string' ? credit.credits.balance : typeof credit?.credits?.balance === 'number' ? String(credit.credits.balance) : null;
      const observedAt = new Date(now()).toISOString(), creditUpdatedAt = date(credit?.fetched_at);
      const history = balance === null ? { consumed: null, balanceChange: null, alerts: [] } : recordCreditSnapshot(deps.db(), account.id, String(account.name), balance, observedAt, creditUpdatedAt);
      const windows = [window('5h', { ...usage?.five_hour, utilization: extra.codex_5h_used_percent, resets_at: extra.codex_5h_reset_at }), window('7 天', { ...usage?.seven_day, utilization: extra.codex_7d_used_percent, resets_at: extra.codex_7d_reset_at })];
      const accountWarnings = [...history.alerts.map(a => `账号 ${a.accountName} 点数被消耗 ${a.consumed}`)];
      if (extra.auto_reset_credit_enabled === true) accountWarnings.push(`账号 ${account.name} 上游已启用点数重置`);
      for (const key of ['5h', '7d']) {
        const override = num(extra[`auto_pause_${key}_threshold`]);
        if (extra[`auto_pause_${key}_disabled`] === true || (override !== null && (override <= 0 || override > 0.95))) accountWarnings.push(`账号 ${account.name} ${key} 自动暂停配置不安全`);
      }
      warnings.push(...accountWarnings);
      accounts.push({ id: account.id as number, name: String(account.name), status: String(account.status), schedulable: account.schedulable === true, windows, balance, balanceChange: history.balanceChange, consumed: history.consumed, alerts: history.alerts, warnings: accountWarnings,
        usageUpdatedAt: date(extra.codex_usage_updated_at), creditUpdatedAt, creditStale: stale(creditUpdatedAt, now()), usageStale: stale(date(extra.codex_usage_updated_at), now()) });
    }
    return { thresholds, accounts, warnings };
  }, now);
  const keys = new Map<number, { fingerprint: string; get: ReturnType<typeof createQuotaCache<Json>> }>();
  async function ownKey(identity: { userId: number; role: string }) {
    const auth = await deps.readJson(path.join(deps.paths(identity.userId, identity.role).codexHome, 'auth.json')).catch(() => ({} as Json));
    const key = auth.OPENAI_API_KEY;
    if (typeof key !== 'string' || !key) { keys.delete(identity.userId); return { data: { mode: 'not_relay', message: '未走中转' }, updatedAt: null, stale: false, error: null }; }
    const fingerprint = createHash('sha256').update(key).digest('hex');
    let cache = keys.get(identity.userId);
    if (!cache || cache.fingerprint !== fingerprint) {
      cache = { fingerprint, get: createQuotaCache(async () => {
        const raw = await request(base + '/v1/usage?days=30&timezone=Asia%2FShanghai', { headers: { Authorization: 'Bearer ' + key } }, true);
        const stats = (s: Json = {}) => ({ requests: num(s.requests), tokens: num(s.total_tokens ?? s.tokens), cost: num(s.actual_cost ?? s.cost) });
        const daily = Array.isArray(raw.daily_usage) ? raw.daily_usage : null;
        const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(now()));
        const sum = (days: number) => {
          if (!daily) return null;
          const start = Date.parse(day + 'T00:00:00+08:00') - (days - 1) * 86400000;
          const rows = daily.filter((r: Json) => typeof r.date === 'string' && Date.parse(r.date.slice(0, 10) + 'T00:00:00+08:00') >= start && r.date.slice(0, 10) <= day);
          return rows.reduce((total: Json, row: Json) => { const s = stats(row); for (const k of ['requests', 'tokens', 'cost'] as const) total[k] += s[k] || 0; return total; }, { requests: 0, tokens: 0, cost: 0 });
        };
        return { mode: 'relay', status: typeof raw.status === 'string' ? raw.status : null, unit: typeof raw.unit === 'string' ? raw.unit : 'USD', balance: num(raw.balance), remaining: num(raw.remaining), quota: num(raw.quota?.limit ?? raw.quota), used: num(raw.quota?.used),
          today: raw.usage?.today ? stats(raw.usage.today) : sum(1), last7d: sum(7), last30d: sum(30) };
      }, now) };
      keys.set(identity.userId, cache);
    }
    return cache.get();
  }
  return {
    overview: async (identity: { userId: number; role: string }) => {
      const [subscription, key] = await Promise.all([claude(), ownKey(identity)]);
      // Members never trigger or receive the administrator account pool, names, balances or warnings.
      return { claude: subscription, key, ...(identity.role === 'admin' ? { pool: await pool() } : {}) };
    },
    refreshPool: pool,
  };
}

let service: ReturnType<typeof createQuotaService> | undefined;
/** Quota routes obtain the process singleton; tests construct independent instances with mocks. */
export function getQuotaService() {
  service ||= createQuotaService({ readJson: async file => JSON.parse(await fs.readFile(file, 'utf8')), request: quotaFetch, paths: resolveUserConfigPaths,
    secretFile: path.join(os.homedir(), '.cloudcli', 'secrets', 'sub2api-admin.json'), db: getConnection,
    password: async () => (await promisify(execFile)(process.platform === 'win32' ? 'C:/Program Files/Amazon/AWSCLIV2/aws.exe' : 'aws', ['ssm', 'get-parameter', '--name', '/sub2api/admin-password', '--with-decryption', '--query', 'Parameter.Value', '--output', 'text', '--profile', 'sub2api-ops', '--region', 'ap-southeast-1'], { windowsHide: true, timeout: 30000 })).stdout.trim() });
  return service;
}
let interval: ReturnType<typeof setInterval> | undefined;
/** Server lifecycle initializes history and polls read-only upstream metadata every ten minutes. */
export function initializeQuota() {
  initializeQuotaTables(getConnection());
  const refresh = () => { void getQuotaService().refreshPool().catch(() => console.error('[Quota] Background refresh failed')); };
  refresh(); interval = setInterval(refresh, 600000); interval.unref();
}
/** Server shutdown cancels future quota polling. */
export function closeQuota() { clearInterval(interval); }
