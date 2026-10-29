import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import type { UserRuntimeContext } from '@/shared/types.js';
import { getConnection } from '@/modules/database/index.js';
import { AppError, userContextStorage } from '@/shared/utils.js';


/** Auth runtime and Usage scanning share path rules; this resolver performs no filesystem writes or configuration sync. */
export function resolveUserConfigPaths(id: number, role: string) {
  const adminClaude = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  const adminCodex = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const configRoot = path.resolve(process.env.CLAUDEX_USER_CONFIG_ROOT || path.join(os.homedir(), '.cloudcli', 'users'));
  const root = path.join(configRoot, String(id));
  return { adminClaude, adminCodex, configRoot, root,
    claudeConfigDir: role === 'admin' ? adminClaude : path.join(root, 'claude'),
    codexHome: role === 'admin' ? adminCodex : path.join(root, 'codex') };
}

function denied(message: string): never {
  throw new AppError(message, { code: 'USER_PATH_FORBIDDEN', statusCode: 403 });
}

// Resolve the nearest existing ancestor too, so a new file under a junction
// cannot bypass the boundary. Broken links and permission failures fail closed.
function canonical(target: string): string {
  const absolute = path.resolve(target);
  try { return fs.realpathSync.native(absolute); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { fs.lstatSync(absolute); return denied('Unresolvable symbolic link.'); }
    catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;
    }
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(canonical(parent), path.basename(absolute));
  }
}

function share(source: string, destination: string, credential = false): 'junction' | 'copy' | 'missing' {
  if (!fs.existsSync(source)) return 'missing';
  const sourceStat = fs.statSync(source);
  if (sourceStat.isDirectory()) {
    try { fs.symlinkSync(source, destination, 'junction'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return 'junction';
  }
  // Private snapshots cannot write back through a hardlink/symlink. Comparing
  // contents also catches atomic credential replacement and same-size updates.
  const content = fs.readFileSync(source);
  const fingerprint = createHash('sha256').update(content).digest('hex');
  const marker = destination + '.shared-source.sha256';
  let current: fs.Stats | undefined;
  try { current = fs.lstatSync(destination); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (credential && current && !current.isSymbolicLink() && current.nlink === 1
      && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === fingerprint) return 'copy';
  if (current && !current.isSymbolicLink() && current.nlink === 1
      && fs.readFileSync(destination).equals(content)) {
    if (credential) fs.writeFileSync(marker, fingerprint, { mode: 0o600 });
    return 'copy';
  }
  const temporary = destination + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    // Rename replaces the directory entry rather than the linked source inode.
    fs.renameSync(temporary, destination);
    if (credential) fs.writeFileSync(marker, fingerprint, { mode: 0o600 });
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Could not remove shared config temporary file:', temporary);
    }
  }
  return 'copy';
}

// Copy only global MCP/login configuration; project trust and onboarding history
// remain private even when the administrator's config contains those fields.
function syncClaudeLoginConfig(source: string, destination: string): void {
  if (!fs.existsSync(source)) return;
  const sourceConfig = JSON.parse(fs.readFileSync(source, 'utf8')) as Record<string, unknown>;
  let privateConfig: Record<string, unknown> = {};
  if (fs.existsSync(destination)) privateConfig = JSON.parse(fs.readFileSync(destination, 'utf8')) as Record<string, unknown>;
  const before = JSON.stringify(privateConfig);
  for (const key of ['mcpServers', 'oauthAccount', 'primaryApiKey', 'hasCompletedOnboarding']) {
    if (Object.hasOwn(sourceConfig, key)) privateConfig[key] = sourceConfig[key];
    else delete privateConfig[key];
  }
  if (JSON.stringify(privateConfig) === before) return;
  const temporary = destination + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(privateConfig, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, destination);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

/** Providers, WebSocket and authorization consumers resolve a fresh user row per request. */
export function getUserContext(userId: number | string): UserRuntimeContext {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id < 1) denied('Invalid user identity.');
  const row = getConnection().prepare(
    'SELECT id, role, work_root, allowed_folders, is_active, git_name, git_email FROM users WHERE id = ?',
  ).get(id) as { id: number; role: string; work_root: string | null; allowed_folders: string | null; is_active: number; git_name: string | null; git_email: string | null } | undefined;
  if (!row || !row.is_active) denied('User is unavailable.');
  if (row.role !== 'admin' && row.role !== 'member') denied('Invalid user role.');
  const folders: unknown = JSON.parse(row.allowed_folders || '[]');
  if (!Array.isArray(folders) || folders.some(folder => typeof folder !== 'string' || !path.isAbsolute(folder))) {
    return denied('Invalid allowed folder configuration.');
  }
  const { adminClaude, adminCodex, configRoot, root, claudeConfigDir, codexHome } = resolveUserConfigPaths(id, row.role);
  if (row.role === 'member') {
    fs.mkdirSync(claudeConfigDir, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    const sharedFiles: Record<string, string> = {};
    const sourceClaudeConfig = process.env.CLAUDE_CONFIG_DIR
      ? path.join(adminClaude, '.claude.json') : path.join(os.homedir(), '.claude.json');
    syncClaudeLoginConfig(sourceClaudeConfig, path.join(claudeConfigDir, '.claude.json'));
    sharedFiles['claude/.claude.json'] = 'selected-fields-copy';
    for (const entry of ['.credentials.json', 'settings.json', 'plugins', 'skills', '.mcp.json']) {
      sharedFiles['claude/' + entry] = share(path.join(adminClaude, entry), path.join(claudeConfigDir, entry), entry === '.credentials.json');
    }
    // An administrator template replaces inherited defaults: members get the
    // template CLAUDE.md, and a template Codex config means each member keeps a
    // private auth.json (own relay key) instead of the administrator login.
    const template = path.resolve(process.env.CLAUDEX_MEMBER_TEMPLATE_DIR || path.join(path.dirname(configRoot), 'member-template'));
    sharedFiles['claude/CLAUDE.md'] = share(path.join(template, 'claude', 'CLAUDE.md'), path.join(claudeConfigDir, 'CLAUDE.md'));
    if (fs.existsSync(path.join(template, 'codex', 'config.toml'))) {
      sharedFiles['codex/config.toml'] = share(path.join(template, 'codex', 'config.toml'), path.join(codexHome, 'config.toml'));
      sharedFiles['codex/auth.json'] = fs.existsSync(path.join(codexHome, 'auth.json')) ? 'private' : 'missing';
    } else {
      for (const entry of ['auth.json', 'config.toml']) sharedFiles['codex/' + entry] = share(path.join(adminCodex, entry), path.join(codexHome, entry), entry === 'auth.json');
    }
    fs.writeFileSync(path.join(root, 'shared-config.json'), JSON.stringify(sharedFiles, null, 2));
  }
  const gitEnv = { ...process.env };
  if (row.role === 'member') {
    for (const key of ['GIT_AUTHOR_NAME','GIT_AUTHOR_EMAIL','GIT_COMMITTER_NAME','GIT_COMMITTER_EMAIL']) delete gitEnv[key];
  }
  return { userId: id, role: row.role, workRoot: row.work_root, allowedFolders: folders,
    claudeConfigDir, codexHome, env: { ...gitEnv, CLAUDE_CONFIG_DIR: claudeConfigDir, CODEX_HOME: codexHome,
      ...(row.git_name ? { GIT_AUTHOR_NAME: row.git_name, GIT_COMMITTER_NAME: row.git_name } : {}),
      ...(row.git_email ? { GIT_AUTHOR_EMAIL: row.git_email, GIT_COMMITTER_EMAIL: row.git_email } : {}) } };
}

/** Files, runtime and terminal consumers validate real filesystem containment before use. */
export function assertUserPath(userId: number | string, target: string): string {
  // Auth has already resolved this request's identity. Rebuilding its full
  // CLI environment for every checked project path dominates task-list reads.
  // Different identities and calls outside an authenticated context still
  // resolve fresh; a new request always enters through withUserContext().
  const activeContext = getCurrentUserContext();
  const context = activeContext?.userId === Number(userId) ? activeContext : getUserContext(userId);
  if (context.role === 'admin') return path.resolve(target);
  if (!target || target.includes('\0') || !path.isAbsolute(target)) denied('An absolute user path is required.');
  try {
    const resolved = canonical(target);
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    for (const root of [context.workRoot, ...context.allowedFolders]) {
      if (!root || !path.isAbsolute(root)) continue;
      const relative = path.relative(normalize(canonical(root)), normalize(resolved));
      if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) return resolved;
    }
  } catch { denied('Cannot resolve permitted user path.'); }
  return denied('Path is outside the user allowed folders.');
}

/** Runtime dispatch and request adapters keep concurrent user environments separate. */
export function withUserContext<T>(userId: number | string, fn: () => T): T {
  return userContextStorage.run(getUserContext(userId), fn);
}

/** Provider adapters read the context without mutating process.env. */
export function getCurrentUserContext(): UserRuntimeContext | undefined { return userContextStorage.getStore(); }
