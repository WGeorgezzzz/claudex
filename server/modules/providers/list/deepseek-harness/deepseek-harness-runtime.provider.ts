import { readDeepSeekHarnessModels } from './deepseek-harness-models.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderRuntime } from '@/shared/index.js';
import { appendFilesInputTag, createCompleteMessage, createNormalizedMessage, readObjectRecord, killProcessTree } from '@/shared/index.js';
import { resolveDeepSeekHarnessInstallation } from '@/modules/providers/list/deepseek-harness/deepseek-harness-installation.provider.js';
import { deepSeekHarnessTranscriptPath, DeepSeekHarnessSessions } from '@/modules/providers/list/deepseek-harness/deepseek-harness-sessions.provider.js';

const active = new Map<string, { child: ChildProcess; aborted: boolean }>();
const modes: Record<string, string> = { default: 'workspace-write', acceptEdits: 'workspace-write', plan: 'read-only', bypassPermissions: 'danger-full-access' };
const normalizer = new DeepSeekHarnessSessions();

/** Registry invokes the official local headless Harness, preserving its native session id and failure outcome. */
export const deepSeekHarnessRuntime: IProviderRuntime = {
  async run(command, options, writer, context) {
    const install = resolveDeepSeekHarnessInstallation();
    if (!install?.configured) throw new Error('Configure the local DeepSeek Harness launcher and RP credential first.');
    if (options.images?.length) throw new Error('This Harness integration does not support image attachments.');
    const model = await context.resolveResumeModel(options.sessionId, options.model) || 'configured';
    if (model !== 'configured' && !readDeepSeekHarnessModels().OPTIONS.some(option => option.value === model)) throw new Error('所选模型不在本机 TokenHub Harness 配置中，请刷新模型列表。');
    const permission = modes[options.permissionMode || 'bypassPermissions'];
    if (!permission) throw new Error('Unsupported Harness permission mode.');
    const previous = context.resolveProviderSessionId(options.sessionId);
    if (previous && !/^session-[a-zA-Z0-9_-]{1,110}$/.test(previous)) throw new Error('Invalid native Harness session id.');
    const appId = options.sessionId || randomUUID();
    if (active.has(appId)) throw new Error('This Harness session already has an active turn.');
    const transcript = deepSeekHarnessTranscriptPath(appId);
    mkdirSync(path.dirname(transcript), { recursive: true });
    const persist = (row: Record<string, unknown>) => {
      const event = { ...row, uuid: randomUUID(), timestamp: new Date().toISOString() };
      appendFileSync(transcript, JSON.stringify(event) + '\n', 'utf8');
      return event;
    };
    const prompt = appendFilesInputTag(command, options.files);
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'nexagent-harness-'));
    const resolved = path.resolve(scratch);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('nexagent-harness-')) {
      throw new Error('Refusing to remove an unexpected Harness scratch directory.');
    }
    const taskFile = path.join(scratch, 'task.txt');
    writeFileSync(taskFile, prompt, 'utf8');
    persist({ type: 'user', text: prompt });
    let nativeId = previous;
    try {
      await new Promise<void>((resolve, reject) => {
        let stderr = '';
        let errorMessage = '';
        let final = false;
        let completed = false;
        let announced = false;
        let lastToolFailure = '';
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', install.bridge,
          '-Launcher', install.launcher, '-TaskFile', taskFile, '-Workspace', options.cwd || options.projectPath || process.cwd(), '-Model', model,
          ...(previous ? ['-SessionId', previous] : [])], {
          cwd: options.cwd || options.projectPath || process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, DSH_PERMISSION_MODE: permission },
        });
        const entry = { child, aborted: false };
        active.set(appId, entry);
        child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-6000); });
        const lines = readline.createInterface({ input: child.stdout! });
        lines.on('line', line => {
          if (entry.aborted || !line.trim()) return;
          let row: Record<string, unknown> | null;
          try { row = readObjectRecord(JSON.parse(line.replace(/^\uFEFF/, ''))); }
          catch { stderr = (stderr + line).slice(-6000); return; }
          if (!row) return;
          try {
            if (row.type === 'session') {
              if (announced || typeof row.sessionId !== 'string' || !/^session-[a-zA-Z0-9_-]{1,110}$/.test(row.sessionId)
                || (previous && previous !== row.sessionId)) throw new Error('Harness returned an unexpected native session id.');
              announced = true;
              nativeId = row.sessionId;
              writer.setSessionId?.(nativeId);
              if (!previous) writer.send(createNormalizedMessage({ kind: 'session_created', newSessionId: nativeId,
                sessionId: nativeId, provider: 'deepseek-harness', model, cwd: options.cwd || options.projectPath }));
              if (options.sessionId) sessionsDb.repointSessionToProviderSession(options.sessionId, { providerSessionId: nativeId, jsonlPath: transcript });
            }
            if (row.type === 'final') final = true;
            if (row.type === 'tool_result') lastToolFailure = row.status === 'error' ? String(row.result || 'Harness tool failed.') : '';
            if (row.type === 'status' && row.phase === 'turn_end') completed = readObjectRecord(row.reason)?.kind === 'completed';
            const event = persist(row);
            for (const message of normalizer.normalizeMessage(event, nativeId || appId)) writer.send(message);
          } catch (error) {
            errorMessage = error instanceof Error ? error.message : 'Could not persist Harness event.';
            if (child.pid) void killProcessTree(child.pid);
          }
        });
        child.once('error', error => { errorMessage = error.message; });
        child.once('close', code => {
          if (active.get(appId) === entry) active.delete(appId);
          if (entry.aborted) { resolve(); return; }
          // A tool error is already visible in its correlated result. The native
          // turn can still finish with an explanation or recovery; only native
          // completion and process/transport failures determine run completion.
          const succeeded = code === 0 && announced && final && completed && !errorMessage;
          if (!succeeded) {
            const message = errorMessage || lastToolFailure || stderr.trim() || 'Harness exited without a completed turn and final result.';
            try { persist({ type: 'nexagent_error', text: message }); } catch { /* Keep the original error when storage failed. */ }
            writer.send(createNormalizedMessage({ kind: 'error', provider: 'deepseek-harness', sessionId: nativeId || appId, content: message }));
          }
          writer.send(createCompleteMessage({ provider: 'deepseek-harness', sessionId: nativeId || appId, exitCode: succeeded ? 0 : 1 }));
          if (succeeded) resolve(); else reject(new Error('DeepSeek Harness did not complete successfully.'));
        });
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
  async abort(sessionId) {
    const entry = active.get(sessionId);
    if (!entry) return false;
    entry.aborted = true;
    if (!entry.child.pid || !await killProcessTree(entry.child.pid)) {
      entry.aborted = false;
      throw new Error('Harness process could not be stopped.');
    }
    if (active.get(sessionId) === entry) active.delete(sessionId);
    return true;
  },
};
