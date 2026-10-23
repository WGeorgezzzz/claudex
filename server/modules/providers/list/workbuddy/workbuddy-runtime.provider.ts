import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderRuntime } from '@/shared/index.js';
import { createCompleteMessage, createNormalizedMessage, readObjectRecord } from '@/shared/index.js';
import { resolveWorkBuddyInstallation } from '@/modules/providers/list/workbuddy/workbuddy-auth.provider.js';
import { workBuddyTranscriptPath } from '@/modules/providers/list/workbuddy/workbuddy-sessions.provider.js';

const active = new Map<string, { child: ChildProcess; aborted: boolean }>();

/** Provider registry runs the official WorkBuddy CLI with local login and app-owned transcript persistence. */
export const workBuddyRuntime: IProviderRuntime = {
  async run(command, options, writer, context) {
    const install = resolveWorkBuddyInstallation();
    if (!install) throw new Error('WorkBuddy is not installed on this Windows host.');
    if ((options.images?.length || options.files?.length)) throw new Error('WorkBuddy attachments are not supported by this integration yet.');
    const model = await context.resolveResumeModel(options.sessionId, options.model) || 'fast-model';
    const previous = context.resolveProviderSessionId(options.sessionId);
    const nativeId = previous || randomUUID();
    const appId = options.sessionId || nativeId;
    if (active.has(appId)) throw new Error('This WorkBuddy conversation already has an active run.');
    const transcript = workBuddyTranscriptPath(appId);
    mkdirSync(path.dirname(transcript), { recursive: true });
    const persist = (row: unknown) => appendFileSync(transcript, JSON.stringify(row) + '\n', 'utf8');
    persist({ type: 'user', uuid: randomUUID(), __timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: command }] } });
    const args = [install.launcher, '-p', '--output-format', 'stream-json', '--model', model,
      '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--tools', 'StructuredOutput', '--permission-mode', 'default', '--max-turns', '1',
      ...(previous ? ['--resume', previous] : ['--session-id', nativeId]),
    ];
    return new Promise<void>((resolve, reject) => {
      let result: Record<string, unknown> | null = null;
      let stderr = '';
      let announced = false;
      let persistenceError = false;
      const child = spawn(install.executable, args, {
        cwd: options.cwd || options.projectPath || process.cwd(), windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDEX_WORKBUDDY_INSTALL: install.directory, NODE_OPTIONS: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const entry = { child, aborted: false };
      active.set(appId, entry);
      child.stdin.on('error', () => {});
      child.stdin.end(command);
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', line => {
        if (entry.aborted) return;
        let row: Record<string, unknown> | null;
        try { row = readObjectRecord(JSON.parse(line)); } catch { stderr = (stderr + line).slice(-4000); return; }
        if (!row) return;
        if (row.type === 'system' && row.subtype === 'init' && !announced) {
          if (row.session_id !== nativeId) { stderr = 'WorkBuddy returned an unexpected session id.'; child.kill(); return; }
          announced = true;
          writer.setSessionId?.(nativeId);
          if (!previous) writer.send(createNormalizedMessage({ kind: 'session_created', newSessionId: nativeId, model, cwd: options.cwd || options.projectPath, sessionId: nativeId, provider: 'workbuddy' }));
          if (options.sessionId) sessionsDb.repointSessionToProviderSession(options.sessionId, { providerSessionId: nativeId, jsonlPath: transcript });
        }
        if (row.type === 'assistant' || row.type === 'result') {
          try { persist(row); } catch { persistenceError = true; child.kill(); return; }
          if (row.type === 'result') result = row;
          else for (const message of context.normalizeMessage(row, nativeId)) writer.send(message);
        }
      });
      child.once('error', () => { stderr = 'Could not start the installed WorkBuddy client.'; });
      child.once('close', code => {
        if (active.get(appId) === entry) active.delete(appId);
        if (entry.aborted) { resolve(); return; }
        // The bundled CLI can exit 0 on auth/model errors. Require its semantic result as well.
        const succeeded = code === 0 && result?.subtype === 'success' && result?.is_error === false && !persistenceError;
        if (!succeeded) {
          const error = persistenceError ? 'Could not save the WorkBuddy conversation.'
            : typeof result?.result === 'string' ? result.result
              : stderr.trim() || 'WorkBuddy ended without a successful result. Check its local login and model permissions.';
          try { persist({ type: 'claudex_error', uuid: randomUUID(), __timestamp: new Date().toISOString(), content: error }); } catch { /* Preserve the runtime failure even when disk writes failed. */ }
          writer.send(createNormalizedMessage({ kind: 'error', content: error, provider: 'workbuddy', sessionId: nativeId }));
        }
        writer.send(createCompleteMessage({ provider: 'workbuddy', sessionId: nativeId, exitCode: succeeded ? 0 : 1 }));
        if (succeeded) resolve(); else reject(new Error('WorkBuddy did not complete successfully.'));
      });
    });
  },
  async abort(sessionId) {
    const entry = active.get(sessionId);
    if (!entry) return false;
    entry.aborted = true;
    if (process.platform === 'win32' && entry.child.pid) {
      await new Promise<void>(resolve => {
        const killer = spawn('taskkill.exe', ['/PID', String(entry.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { entry.child.kill(); resolve(); });
        killer.once('close', () => resolve());
      });
    } else entry.child.kill();
    // taskkill may finish before inherited stdout handles close. Release this run
    // before the gateway acknowledges stop; an old close must not evict a new run.
    if (active.get(sessionId) === entry) active.delete(sessionId);
    return true;
  },
};
