import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import spawn from 'cross-spawn';
import Database from 'better-sqlite3';

type ProbeOptions = {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => Promise<boolean>;
  list?: (directory: string) => Promise<string[]>;
  version?: (file: string) => Promise<string | null>;
  modified?: (file: string) => Promise<number>;
};

/** Discovery and its fixtures resolve native executables and Windows npm/PowerShell shims without invoking an agent turn. */
export async function probeAgent(commands: string[], options: ProbeOptions = {}) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const exists = options.exists ?? (async file => { try { return (await fs.stat(file)).isFile(); } catch { return false; } });
  const list = options.list ?? (async dir => { try { return await fs.readdir(dir); } catch { return []; } });
  const version = options.version ?? readAgentVersion;
  const modified = options.modified ?? (async file => { try { return (await fs.stat(file)).mtimeMs; } catch { return 0; } });
  const directories = [
    ...(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').map(v => v.replace(/^"|"$/g, '')),
    env.npm_config_prefix, env.NPM_CONFIG_PREFIX,
    ...(platform === 'win32' ? [] : [env.npm_config_prefix, env.NPM_CONFIG_PREFIX].filter((v): v is string => Boolean(v)).map(prefix => p.join(prefix, 'bin'))),
    p.join(home, '.npm-global', 'bin'), p.join(home, '.local', 'bin'), p.join(home, '.claude', 'local'),
    p.join(home, '.opencode', 'bin'), p.join(home, '.cursor', 'bin'), p.join(home, '.local', 'share', 'mise', 'shims'),
    ...(platform === 'win32' ? [p.join(env.APPDATA ?? p.join(home, 'AppData', 'Roaming'), 'npm'), p.dirname(process.execPath)]
      : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', p.join(home, '.npm', 'bin')]),
  ].filter((v): v is string => Boolean(v));
  if (platform === 'win32' && commands.includes('codex')) {
    const root = p.join(env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
    const versions = await Promise.all((await list(root)).map(async name => ({ name, modified: await modified(p.join(root, name)) })));
    directories.unshift(...versions.sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name, undefined, { numeric: true })).map(v => p.join(root, v.name)));
  }
  if (platform === 'win32' && commands.includes('workbuddy')) {
    directories.push(...['C:', 'D:', 'E:'].flatMap(d => ['WorkBuddyAI', 'WorkBuddy'].map(n => p.join(d, 'Program Files', n))),
      ...['WorkBuddyAI', 'WorkBuddy'].map(n => p.join(env.LOCALAPPDATA ?? home, 'Programs', n)));
    commands = [...commands, 'WorkBuddyAI', 'WorkBuddy'];
  }
  const suffixes = platform === 'win32' ? [...new Set(['.exe', '.cmd', '.bat', '.ps1', '.com', ...(env.PATHEXT ?? '').split(';').filter(Boolean).map(v => v.toLowerCase()), ''])] : [''];
  for (const directory of [...new Set(directories)]) for (const command of commands) for (const extension of suffixes) {
    const file = p.join(directory, command + extension);
    if (!await exists(file)) continue;
    const foundVersion = await version(file);
    if (foundVersion) return { executable: file, version: foundVersion };
  }
  return null;
}

/** Discovery uses an asynchronous five-second, hidden version probe; nonzero exits and timeouts never count as installed. */
export function readAgentVersion(executable: string): Promise<string | null> {
  return new Promise(resolve => {
    const ps = process.platform === 'win32' && executable.toLowerCase().endsWith('.ps1');
    const workbuddy = /workbuddy(?:ai)?\.exe$/i.test(executable);
    const child = spawn(ps ? 'powershell.exe' : executable, ps
      ? ['-NoProfile', '-NonInteractive', '-File', executable, '--version'] : workbuddy
        ? [path.join(path.dirname(executable), 'resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs'), '--version'] : ['--version'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: workbuddy ? { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' } : process.env });
    let output = '';
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 5000);
    child.stdout?.on('data', data => { output = (output + String(data)).slice(-4096); });
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('close', code => {
      clearTimeout(timer);
      resolve(code === 0 && output.trim() ? output.replace(/\x1b\[[0-9;]*m/g, '').trim().split(/\r?\n/)[0].slice(0, 200) : null);
    });
  });
}

/** Discovery counts transcript file names only, without reading content or following symlinks out of configuration directories. */
export async function countAgentSessions(root: string, sqliteDatabase?: string, pattern = /\.(jsonl|vscdb)$|^store\.db$/): Promise<number> {
  if (sqliteDatabase) {
    let database: Database.Database | undefined;
    try {
      await fs.access(sqliteDatabase);
      database = new Database(sqliteDatabase, { readonly: true, fileMustExist: true });
      return (database.prepare('SELECT COUNT(*) AS count FROM session').get() as { count: number }).count;
    } catch { /* Fall back to legacy transcript names when no compatible session-count database exists. */ }
    finally { database?.close(); }
  }
  let count = 0;
  const visit = async (dir: string, depth: number) => {
    if (depth > 10) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), depth + 1);
      else if (entry.isFile() && pattern.test(entry.name)) count++;
    }
  };
  await visit(root, 0);
  return count;
}
