import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldLoop } from 'node:timers/promises';

import type { Database } from 'better-sqlite3';

import { getConnection } from '@/modules/database/index.js';
import { resolveUserConfigPaths } from '@/modules/auth/index.js';

type Counts = { requests: number; input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number; total: number };
type Event = Counts & { day: string; hour: number; model: string; at: string };
type State = { seen: Record<string, Event>; model: string; previous?: string };
type FileRow = { size: number; mtime_ms: number; offset: number; state_json: string };
type User = { id: number; username: string; role: string; is_active: number };
const empty = (): Counts => ({ requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 });
const dateParts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
function localTime(at: string | number) {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return null;
  const parts = Object.fromEntries(dateParts.formatToParts(d).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), at: d.toISOString() };
}
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
function add(target: Counts, source: Counts) { for (const key of Object.keys(target) as (keyof Counts)[]) target[key] += source[key]; }
function parse(line: string, provider: string, state: State, offset: number): { event: Event; previous?: Event } | undefined {
  let row;
  try { row = JSON.parse(line); } catch { return; }
  if (provider === 'codex' && row.type === 'turn_context') { state.model = row.payload?.model || 'unknown'; return; }
  let usage, model, id;
  if (provider === 'claude') {
    if (row.type !== 'assistant' || !row.message?.usage) return;
    usage = row.message.usage; model = row.message.model || 'unknown'; id = String(row.message.id || row.requestId || `offset:${offset}`);
  } else {
    if (row.type !== 'event_msg' || row.payload?.type !== 'token_count' || !row.payload.info) return;
    const info = row.payload.info;
    const total = info.total_token_usage;
    const fingerprint = total ? JSON.stringify(Object.keys(total).sort().map(k => [k, total[k]])) : undefined;
    if (fingerprint && state.previous === fingerprint) return;
    state.previous = fingerprint;
    usage = info.last_token_usage; model = state.model;
    if (!usage) return;
  }
  const time = localTime(row.timestamp);
  if (!time) return;
  const cacheRead = number(provider === 'claude' ? usage.cache_read_input_tokens : usage.cached_input_tokens);
  const cacheWrite = provider === 'claude' ? number(usage.cache_creation_input_tokens) : 0;
  const input = Math.max(0, number(usage.input_tokens) - (provider === 'codex' ? cacheRead : 0));
  // Codex output_tokens already includes reasoning_output_tokens; never count reasoning twice.
  const output = number(usage.output_tokens), reasoning = provider === 'codex' ? number(usage.reasoning_output_tokens) : 0;
  const total = input + cacheRead + cacheWrite + output;
  const previous = id ? state.seen[id] : undefined;
  const event = { ...time, model, requests: model === '<synthetic>' || (provider === 'claude' && !total) ? 0 : 1, input, cacheRead, cacheWrite, output, reasoning, total };
  if (!event.requests) Object.assign(event, empty());
  if (id) state.seen[id] = event;
  return { event, previous };
}

/** Usage scanner and module tests consume complete lines only; file counts and cursor commit atomically. */
export async function scanUsageFile(db: Database, file: string, userId: number, provider: string) {
  const stat = await fs.stat(file);
  if (stat.size > 200 * 1024 * 1024) { console.warn('[Usage] Skipping file over 200 MB:', file); return; }
  const old = db.prepare('SELECT * FROM usage_scan_files WHERE path=?').get(file) as FileRow | undefined;
  if (old && old.size === stat.size && old.mtime_ms === stat.mtimeMs) return;
  // Session JSONL files are append-only; a timestamp-only touch must not
  // replay a large transcript from the beginning.
  const reset = !old || stat.size < old.size || stat.mtimeMs < old.mtime_ms;
  const state: State = reset ? { seen: {}, model: 'unknown' } : JSON.parse(old.state_json);
  state.seen = Object.assign(Object.create(null), state.seen);
  let offset = reset ? 0 : old.offset;
  // Collapse each file into hourly deltas before touching SQLite: a long transcript
  // must not turn into one blocking transaction containing thousands of writes.
  const changes = new Map<string, Event>();
  const accumulate = (event: Event, sign: number) => {
    const key = JSON.stringify([event.day, event.hour, event.model]);
    const delta = changes.get(key) || { ...event, ...empty() };
    for (const field of Object.keys(empty()) as (keyof Counts)[]) delta[field] += sign * event[field];
    if (event.at > delta.at) delta.at = event.at;
    changes.set(key, delta);
  };
  const handle = await fs.open(file, 'r');
  try {
    let pending = Buffer.alloc(0), readAt = offset;
    while (readAt < stat.size) {
      const buffer = Buffer.alloc(Math.min(256 * 1024, stat.size - readAt));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, readAt);
      if (!bytesRead) break;
      readAt += bytesRead; pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      let start = 0, end, lines = 0;
      while ((end = pending.indexOf(10, start)) !== -1) {
        const result = parse(pending.subarray(start, end).toString('utf8'), provider, state, offset);
        if (result) { if (result.previous) accumulate(result.previous, -1); accumulate(result.event, 1); }
        offset += end - start + 1; start = end + 1;
        if (++lines % 100 === 0) await yieldLoop();
      }
      pending = pending.subarray(start);
      await yieldLoop();
    }
  } finally { await handle.close(); }
  const update = db.prepare(`INSERT INTO usage_events_daily
    (user_id,day,hour,provider,model,requests,input,cache_read,cache_write,output,reasoning,source_path,last_active_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,day,hour,provider,model,source_path) DO UPDATE SET
    requests=requests+excluded.requests,input=input+excluded.input,cache_read=cache_read+excluded.cache_read,
    cache_write=cache_write+excluded.cache_write,output=output+excluded.output,reasoning=reasoning+excluded.reasoning,
    last_active_at=MAX(last_active_at,excluded.last_active_at)`);
  const apply = (e: Event, sign: number) => update.run(userId, e.day, e.hour, provider, e.model, sign*e.requests, sign*e.input, sign*e.cacheRead, sign*e.cacheWrite, sign*e.output, sign*e.reasoning, file, e.at);
  db.transaction(() => {
    if (reset) db.prepare('DELETE FROM usage_events_daily WHERE source_path=?').run(file);
    for (const delta of changes.values()) apply(delta, 1);
    db.prepare('INSERT OR REPLACE INTO usage_scan_files VALUES (?,?,?,?,?,?,?)').run(file,userId,provider,stat.size,stat.mtimeMs,offset,JSON.stringify(state));
  })();
  await yieldLoop();
}
async function* files(root: string, provider: string): AsyncGenerator<string> {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    // Never follow links into other users' histories or shared directories.
    if (entry.isDirectory()) yield* files(file, provider);
    else if (entry.isFile() && entry.name.endsWith('.jsonl') && (provider === 'claude' || entry.name.startsWith('rollout-'))) yield file;
  }
}
let active: Promise<void> | null = null;
let scannedAt: string | null = null;
let initial: ReturnType<typeof setTimeout> | undefined;
let periodic: ReturnType<typeof setInterval> | undefined;
let stopping = false;
let scanStats: { durationMs: number; peakRss: number; files: number; errors: number } | null = null;
/** Routes coalesce manual scans with the startup/periodic scan so only one scan runs at a time. */
export function rescanUsage(): Promise<void> {
  if (active) return active;
  active = (async () => {
    const db = getConnection(), started = performance.now();
    let peakRss = process.memoryUsage().rss, count = 0, errors = 0;
    const memory = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);
    try {
      const users = db.prepare('SELECT id,username,role,is_active FROM users').all() as User[];
      const { configRoot } = resolveUserConfigPaths(1, 'member');
      for (const entry of await fs.readdir(configRoot, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory() && /^\d+$/.test(entry.name) && !users.some(u => u.id === Number(entry.name))) users.push({ id: Number(entry.name), username: `#${entry.name}`, role: 'member', is_active: 0 });
      }
      for (const user of users) {
        const dirs = resolveUserConfigPaths(user.id, user.role);
        for (const [provider, roots] of [['claude', [path.join(dirs.claudeConfigDir,'projects')]], ['codex', [path.join(dirs.codexHome,'sessions'),path.join(dirs.codexHome,'archived_sessions')]]] as const) {
          for (const root of roots) {
            try { for await (const file of files(root, provider)) {
              if (stopping) return;
              try { await scanUsageFile(db,file,user.id,provider); count++; }
              catch (error) { errors++; console.warn('[Usage] File scan failed:',file,error); }
            } } catch (error) { errors++; console.warn('[Usage] Directory scan failed:',root,error); }
          }
        }
      }
      scannedAt = new Date().toISOString();
      db.prepare("INSERT OR REPLACE INTO app_config(key,value) VALUES ('usage_scanned_at',?)").run(scannedAt);
    } finally {
      clearInterval(memory); scanStats = { durationMs: Math.round(performance.now()-started), peakRss: Math.max(peakRss,process.memoryUsage().rss), files: count, errors };
      console.log('[Usage] Scan completed',JSON.stringify(scanStats));
    }
  })().finally(() => { active = null; });
  return active;
}
/** Server lifecycle starts scanning after 30 seconds and then every ten minutes. */
export function initializeUsage() {
  stopping = false;
  const run = () => { void rescanUsage().catch(e => console.error('[Usage]',e)); };
  initial = setTimeout(run,30000); initial.unref();
  periodic = setInterval(run,600000); periodic.unref();
}
/** Server shutdown stops future work and lets the current read close cleanly. */
export function closeUsage() { stopping = true; clearTimeout(initial); clearInterval(periodic); }

/** Authenticated routes and isolated tests obtain a server-enforced account scope and zero-filled time buckets. */
export function usageOverview(db: Database, identity: { id: number; role: string }, range: string, groupBy: string, requestedId?: number, now = Date.now()) {
  const userId = identity.role === 'admin' ? requestedId : identity.id;
  const current = localTime(now)!;
  const dayStart = new Date(`${current.day}T00:00:00+08:00`).getTime();
  const hourly = range === '24h', n = hourly ? 24 : Number(range.slice(0,-1));
  const start = hourly ? Math.floor(now/3600000)*3600000 - 23*3600000 : dayStart-(n-1)*86400000;
  const buckets = Array.from({length:n},(_,i) => { const p = localTime(start+i*(hourly?3600000:86400000))!; return hourly ? `${p.day}T${String(p.hour).padStart(2,'0')}:00:00+08:00` : p.day; });
  const params: number[] = []; let scope = '';
  if (identity.role !== 'admin') { scope = ' WHERE user_id=?'; params.push(identity.id); }
  const rows = db.prepare(`SELECT user_id,day,hour,provider,model,SUM(requests) requests,SUM(input) input,SUM(cache_read) cacheRead,SUM(cache_write) cacheWrite,SUM(output) output,SUM(reasoning) reasoning,MAX(last_active_at) at FROM usage_events_daily${scope} GROUP BY user_id,day,hour,provider,model HAVING SUM(requests)>0`).all(...params) as (Event & { user_id: number; provider: string })[];
  const users = db.prepare(`SELECT id,username,role,is_active FROM users${identity.role === 'admin' ? '' : ' WHERE id=?'}`).all(...params) as User[];
  for (const row of rows) if (!users.some(u=>u.id===row.user_id)) users.push({ id:row.user_id,username:`#${row.user_id}`,role:'member',is_active:0 });
  const series = new Map<string,{key:string;label:string;points:(Counts & {t:string})[]}>(), totals=empty();
  const perUser = users.map(u => ({ userId:u.id,username:u.username,role:u.role,isActive:!!u.is_active,today:empty(),last7d:empty(),last30d:empty(),lastActiveAt:null as string|null,topModel:null as string|null }));
  const models = new Map<number,Map<string,number>>();
  for (const row of rows) {
    row.total = row.input+row.cacheRead+row.cacheWrite+row.output;
    const user = perUser.find(u=>u.userId===row.user_id)!;
    if (!user.lastActiveAt || row.at>user.lastActiveAt) user.lastActiveAt=row.at;
    if (row.day<=current.day) {
      const age = Math.round((dayStart-new Date(`${row.day}T00:00:00+08:00`).getTime())/86400000);
      if (age===0) add(user.today,row); if (age<7) add(user.last7d,row); if (age<30) add(user.last30d,row);
    }
    const byModel=models.get(row.user_id)||new Map<string,number>(); byModel.set(row.model,(byModel.get(row.model)||0)+row.requests); models.set(row.user_id,byModel);
    if (userId && row.user_id!==userId) continue;
    const t = hourly ? `${row.day}T${String(row.hour).padStart(2,'0')}:00:00+08:00` : row.day;
    const index=buckets.indexOf(t); if(index<0)continue;
    const key=groupBy==='user'?String(row.user_id):groupBy==='provider'?row.provider:row.model;
    if (!series.has(key)) series.set(key,{ key,label:groupBy==='user'?`${user.username}${user.isActive?'':' (disabled)'}`:key,points:buckets.map(t=>({...empty(),t})) });
    add(series.get(key)!.points[index],row); add(totals,row);
  }
  for(const user of perUser)user.topModel=[...(models.get(user.userId)||new Map()).entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||null;
  return {range,buckets,series:[...series.values()],totals,perUser,scannedAt:scannedAt||(db.prepare("SELECT value FROM app_config WHERE key='usage_scanned_at'").get() as {value:string}|undefined)?.value||null,scanning:!!active,scanStats};
}
