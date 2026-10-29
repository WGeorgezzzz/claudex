import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// Enabled only in isolated diagnostics. Never log argv, env values, prompt or
// error messages: those can include credentials or user content.
export function installProviderProcessTrace(directory: string): void {
  const file = path.join(directory, 'process-trace.ndjson');
  const stack = () => new Error().stack?.split('\n').slice(2).join('\n');
  const record = (type: string, data: Record<string, unknown>) => {
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, type, ...data }) + '\n');
  };
  const originalKill = process.kill;
  process.kill = function(pid, signal) { record('process.kill', { target: pid, signal, stack: stack() }); return originalKill.call(process, pid, signal); };
  const childKill = childProcess.ChildProcess.prototype.kill;
  childProcess.ChildProcess.prototype.kill = function(signal) { record('ChildProcess.kill', { target: this.pid, signal, stack: stack() }); return childKill.call(this, signal); };
  const abort = AbortController.prototype.abort;
  AbortController.prototype.abort = function(reason) { record('AbortController.abort', { reasonType: reason?.constructor?.name, stack: stack() }); return abort.call(this, reason); };
  const add = EventTarget.prototype.addEventListener;
  const watched = new WeakSet<AbortSignal>();
  EventTarget.prototype.addEventListener = function(type, callback, options) {
    if (this instanceof AbortSignal && !watched.has(this)) {
      watched.add(this); const registration = stack();
      add.call(this, 'abort', () => record('AbortSignal.abort', { registration, stack: stack() }), { once: true });
    }
    return add.call(this, type, callback, options);
  };
  const spawn = childProcess.spawn;
  childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
    const child = Reflect.apply(spawn, childProcess, args);
    const executable = args[0];
    let sha: string | null = null;
    try { sha = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'); } catch { /* PATH or unresolved launcher. */ }
    const options = (Array.isArray(args[1]) ? args[2] : args[1]) as {cwd?: string;env?: NodeJS.ProcessEnv;detached?: boolean;windowsHide?: boolean} | undefined;
    const env = options?.env || process.env;
    const apiBases: Record<string, string> = {};
    for (const key of ['ANTHROPIC_BASE_URL','OPENAI_BASE_URL']) if (env[key]) {
      try { const url = new URL(env[key]!); apiBases[key] = url.origin + url.pathname; } catch { apiBases[key] = 'invalid/redacted'; }
    }
    record('spawn', { childPid: child.pid, executable, sha256: sha, cwd: options?.cwd || process.cwd(),
      detached: options?.detached, windowsHide: options?.windowsHide,
      claudeConfigDir: env.CLAUDE_CONFIG_DIR, codexHome: env.CODEX_HOME, apiBases,
      credentialPresence: Object.fromEntries(['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','OPENAI_API_KEY','CLAUDE_CODE_OAUTH_TOKEN'].map(key => [key, Boolean(env[key])])), stack: stack() });
    child.on('exit', (code, signal) => record('child.exit', { childPid: child.pid, code, signal }));
    child.on('close', (code, signal) => record('child.close', { childPid: child.pid, code, signal }));
    child.on('error', error => record('child.error', { childPid: child.pid, name: error.name, stack: error.stack?.split('\n').slice(1).join('\n') }));
    return child;
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  const exit = process.exit;
  process.exit = ((code?: string | number | null) => { record('process.exit', { code, stack: stack() }); return exit(code); }) as typeof process.exit;
  process.on('unhandledRejection', reason => {
    record('unhandledRejection', { name: (reason as Error)?.name, stack: (reason as Error)?.stack?.split('\n').slice(1).join('\n') });
    queueMicrotask(() => { throw reason; }); // Keep Node's default fatal behavior.
  });
  process.on('uncaughtExceptionMonitor', error => record('uncaughtException', { name: error.name, stack: error.stack?.split('\n').slice(1).join('\n') }));
  process.on('exit', code => record('worker.exit', { code }));
  record('installed', { executable: process.execPath, nodeVersion: process.version, cwd: process.cwd(), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR });
}
