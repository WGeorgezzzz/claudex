import { watch, type FSWatcher } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveUserConfigPaths, withUserContext } from '@/modules/auth/index.js';
import { getConnection } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { broadcastSessionUpsertedBatch } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';

type Root = { provider: LLMProvider; rootPath: string; userIds: number[]; watcher?: FSWatcher };
type Pending = { root: Root; filePath: string; startedAt: number; timer?: ReturnType<typeof setTimeout>; running: boolean; dirty: boolean };
const roots = new Map<string, Root>();
const pending = new Map<string, Pending>();
const signatures = new Map<string, string>();
let fallbackTimer: ReturnType<typeof setInterval> | undefined;
let fallbackInFlight: Promise<void> | undefined;
let closed = true;

const ignoredDirectories = new Set(['.tmp', 'plugins', '.git', 'node_modules', 'dist', 'build', 'subagents', 'tool-results']);
function ignored(filePath: string): boolean {
  return filePath.split(/[\\/]/).some(part => ignoredDirectories.has(part));
}
function target(provider: LLMProvider, filePath: string): boolean {
  if (ignored(filePath)) return false;
  const name = path.basename(filePath);
  return provider === 'opencode' ? name === 'opencode.db' || name === 'opencode.db-wal' : name.endsWith('.jsonl');
}
function rootKey(provider: LLMProvider, directory: string): string {
  const resolved = path.resolve(directory);
  return `${provider}:${process.platform === 'win32' ? resolved.toLowerCase() : resolved}`;
}

async function synchronize(item: Pending): Promise<void> {
  if (closed) return;
  item.running = true;
  item.dirty = false;
  try {
    const stat = await fs.stat(item.filePath);
    const signature = `${stat.size}:${stat.mtimeMs}`;
    for (const userId of item.root.userIds) {
      await withUserContext(userId, async () => {
        const filePath = item.root.provider === 'opencode' ? path.join(item.root.rootPath, 'opencode.db') : item.filePath;
        const result = await sessionSynchronizerService.synchronizeProviderFileIncremental(item.root.provider, filePath);
        if (result.sessionId) await broadcastSessionUpsertedBatch([result.sessionId]);
      });
    }
    signatures.set(item.filePath, signature);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Session watcher synchronization failed', item.filePath, error);
  } finally {
    item.running = false;
    if (item.dirty && !closed) { item.startedAt = Date.now(); schedule(item.root, item.filePath); }
    else pending.delete(item.filePath);
  }
}

function schedule(root: Root, filePath: string): void {
  if (closed || !target(root.provider, filePath)) return;
  let item = pending.get(filePath);
  if (!item) {
    item = { root, filePath, startedAt: Date.now(), running: false, dirty: false };
    pending.set(filePath, item);
  }
  item.dirty = true;
  if (item.running) return;
  if (item.timer) clearTimeout(item.timer);
  const queued = item;
  // Bound debounce even during continuous CLI output; serialize reads per artifact.
  item.timer = setTimeout(() => { queued.timer = undefined; void synchronize(queued); }, Math.min(150, Math.max(0, 500 - (Date.now() - item.startedAt))));
  item.timer.unref();
}

async function discoverRoots(): Promise<void> {
  const users = getConnection().prepare('SELECT id, role FROM users WHERE is_active=1 ORDER BY id').all() as Array<{ id: number; role: string }>;
  const desired = new Map<string, Root>();
  for (const user of users) {
    const config = resolveUserConfigPaths(user.id, user.role);
    const candidates: Array<[LLMProvider, string]> = [
      ['claude', path.join(config.claudeConfigDir, 'projects')], ['codex', path.join(config.codexHome, 'sessions')],
    ];
    if (user.role === 'admin') candidates.push(['cursor', path.join(os.homedir(), '.cursor', 'projects')], ['opencode', path.join(os.homedir(), '.local', 'share', 'opencode')]);
    for (const [provider, rootPath] of candidates) {
      const physicalPath = await fs.realpath(rootPath).catch(() => path.resolve(rootPath));
      const key = rootKey(provider, physicalPath);
      const previous = desired.get(key);
      if (previous) previous.userIds.push(user.id);
      else desired.set(key, { provider, rootPath: physicalPath, userIds: [user.id] });
    }
  }
  for (const [key, root] of roots) {
    const next = desired.get(key);
    if (next) root.userIds = next.userIds;
    else { root.watcher?.close(); roots.delete(key); }
  }
  for (const [key, root] of desired) {
    if (roots.has(key) || closed) continue;
    await fs.mkdir(root.rootPath, { recursive: true });
    if (closed) return;
    try {
      root.watcher = watch(root.rootPath, { recursive: true }, (_event, name) => {
        if (name) schedule(root, path.join(root.rootPath, String(name)));
      });
      root.watcher.on('error', error => console.error('Native session watcher failed; fallback remains active', root.rootPath, error));
    } catch (error) {
      console.warn('Native session watcher unavailable; using low frequency fallback', root.rootPath, error);
    }
    roots.set(key, root);
  }
}

async function scan(root: Root, directory: string, seed: boolean): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (closed) return;
    const filePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || ignored(filePath)) continue;
    if (entry.isDirectory()) { await scan(root, filePath, seed); continue; }
    if (!target(root.provider, filePath)) continue;
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) continue;
    const signature = `${stat.size}:${stat.mtimeMs}`;
    if (seed) signatures.set(filePath, signature);
    else if (signatures.get(filePath) !== signature) schedule(root, filePath);
  }
}

async function reconcile(seed = false): Promise<void> {
  if (fallbackInFlight || closed) return fallbackInFlight;
  fallbackInFlight = (async () => {
    await discoverRoots();
    for (const root of roots.values()) await scan(root, root.rootPath, seed);
  })().finally(() => { fallbackInFlight = undefined; });
  return fallbackInFlight;
}

/** Server startup installs one native recursive watcher per provider root and a 60-second recovery scan. */
export async function initializeSessionsWatcher(): Promise<void> {
  if (!closed) return;
  closed = false;
  await discoverRoots();
  await sessionSynchronizerService.synchronizeSessions();
  await reconcile(true);
  console.log('Native session watchers ready', { roots: roots.size, fallbackMs: 60_000 });
  fallbackTimer = setInterval(() => { void reconcile().catch(error => console.error('Session watcher fallback failed', error)); }, 60_000);
  fallbackTimer.unref();
}

/** Server shutdown closes native handles and cancels pending work without altering transcripts. */
export async function closeSessionsWatcher(): Promise<void> {
  closed = true;
  if (fallbackTimer) clearInterval(fallbackTimer);
  fallbackTimer = undefined;
  for (const item of pending.values()) if (item.timer) clearTimeout(item.timer);
  for (const root of roots.values()) root.watcher?.close();
  await fallbackInFlight;
  roots.clear(); pending.clear(); signatures.clear();
}
