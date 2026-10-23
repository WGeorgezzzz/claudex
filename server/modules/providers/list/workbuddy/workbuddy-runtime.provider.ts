import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderRuntime } from '@/shared/index.js';
import { appendFilesInputTag, appendImagesInputTag, buildClaudeUserContent, normalizeImageDescriptors, createCompleteMessage, createNormalizedMessage, readObjectRecord } from '@/shared/index.js';
import type { ProviderLiveInputResult } from '@/shared/types.js';
import { resolveWorkBuddyInstallation } from '@/modules/providers/list/workbuddy/workbuddy-auth.provider.js';
import { WorkBuddyProviderModels } from '@/modules/providers/list/workbuddy/workbuddy-models.provider.js';
import { WorkBuddyPermissionBridge } from '@/modules/providers/list/workbuddy/workbuddy-permissions.provider.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import { workBuddyTranscriptPath } from '@/modules/providers/list/workbuddy/workbuddy-sessions.provider.js';

import { workBuddyTextProtocolError } from './workbuddy-protocol.provider.js';

const active = new Map<string, { child: ChildProcess; aborted: boolean;
  submit: (id: string, content: string, settled: (result: ProviderLiveInputResult) => void) => void;
  settle: (result: ProviderLiveInputResult) => void }>();
const permissions = new WorkBuddyPermissionBridge();

/** Provider registry runs the official WorkBuddy CLI with local login and app-owned transcript persistence. */
export const workBuddyRuntime: IProviderRuntime = {
  permissions,
  async run(command, options, writer, context) {
    const install = resolveWorkBuddyInstallation();
    if (!install) throw new Error('WorkBuddy is not installed on this Windows host.');
    const freeModels = await new WorkBuddyProviderModels().getSupportedModels();
    const model = await context.resolveResumeModel(options.sessionId, options.model) || freeModels.DEFAULT;
    if (!model || !freeModels.OPTIONS.some(option => option.value === model)) {
      const content = 'WorkBuddy 仅允许免费模型。请在模型菜单中选择标价 0 积分的模型后重试。';
      writer.send(createNormalizedMessage({ kind: 'error', content, provider: 'workbuddy', sessionId: options.sessionId }));
      throw new Error(content);
    }
    const permissionMode = options.permissionMode || 'default';
    if (!providerCapabilitiesService.getProviderCapabilities('workbuddy').permissionModes.includes(permissionMode)) throw new Error('Unsupported WorkBuddy permission mode.');
    const previous = context.resolveProviderSessionId(options.sessionId);
    const nativeId = previous || randomUUID();
    const appId = options.sessionId || nativeId;
    if (active.has(appId)) throw new Error('This WorkBuddy conversation already has an active run.');
    const transcript = workBuddyTranscriptPath(appId);
    mkdirSync(path.dirname(transcript), { recursive: true });
    const persist = (row: unknown) => appendFileSync(transcript, JSON.stringify(row) + '\n', 'utf8');
    const selectedModel = freeModels.OPTIONS.find(option => option.value === model)!;
    const effort = typeof options.effort === 'string' && options.effort !== 'default' ? options.effort : undefined;
    if (effort && !selectedModel.effort?.values.some(level => level.value === effort)) throw new Error('This WorkBuddy model does not support the selected reasoning effort.');
    const prompt = appendFilesInputTag(command, options.files);
    const content = await buildClaudeUserContent(prompt, options.images, options.cwd || options.projectPath);
    if (content.filter(block => block.type === 'image').length !== normalizeImageDescriptors(options.images).length) throw new Error('A WorkBuddy image attachment could not be loaded.');
    persist({ type: 'user', uuid: randomUUID(), __timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: appendImagesInputTag(prompt, options.images) }] } });
    const args = [install.launcher, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model,
      '--setting-sources', 'user,project,local', '--replay-user-messages',
      ...(effort ? ['--effort', effort] : []),
      '--permission-mode', permissionMode,
      ...(previous ? ['--resume', previous] : ['--session-id', nativeId]),
    ];
    return new Promise<void>((resolve, reject) => {
      let result: Record<string, unknown> | null = null;
      let stderr = '';
      let announced = false;
      let persistenceError = false;
      let protocolError: string | null = null;
      let nativeRequestId = '';
      const additions = new Map<string, { accepted: boolean; content: string; settled: (result: ProviderLiveInputResult) => void; timer: NodeJS.Timeout }>();
      const child = spawn(install.executable, args, {
        cwd: options.cwd || options.projectPath || process.cwd(), windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDEX_WORKBUDDY_INSTALL: install.directory, NODE_OPTIONS: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.on('error', () => {});
      const send = (value: unknown) => {
        if (!entry.aborted && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(JSON.stringify(value) + '\n');
      };
      const entry = { child, aborted: false,
        submit(id: string, content: string, settled: (result: ProviderLiveInputResult) => void) {
          if (!announced || result || !nativeRequestId || child.stdin.writableEnded) throw new Error('WorkBuddy is not accepting insertions. Queue this message instead.');
          if (additions.has(id)) return;
          if (additions.size >= 20) throw new Error('Wait for pending WorkBuddy insertions before adding more.');
          const timer = setTimeout(() => { const pending = additions.get(id); if (!pending || pending.accepted) return;
            additions.delete(id); pending.settled({ status: 'failed', error: 'WorkBuddy did not confirm this insertion. Review before retrying.' }); }, 15000);
          timer.unref();
          additions.set(id, { accepted: false, content, settled, timer });
          send({ type: 'control_request', request_id: id, request: { subtype: 'steer', session_id: nativeId,
            expected_request_id: nativeRequestId, content_blocks: [{ type: 'text', text: content }] } });
        },
        settle(outcome: ProviderLiveInputResult) {
          for (const pending of additions.values()) { clearTimeout(pending.timer);
            pending.settled(pending.accepted ? outcome : { status: 'failed', error: 'The turn ended before WorkBuddy confirmed this insertion.' }); }
          additions.clear();
        },
      };
      active.set(appId, entry);
      send({ type: 'control_request', request_id: 'initialize', request: { subtype: 'initialize' } });
      send({ type: 'user', session_id: nativeId, message: { role: 'user', content }, parent_tool_use_id: null });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', line => {
        if (entry.aborted) return;
        let row: Record<string, unknown> | null;
        try { row = readObjectRecord(JSON.parse(line)); } catch { stderr = (stderr + line).slice(-4000); return; }
        if (!row) return;
        if (!row.parent_tool_use_id && typeof row._requestId === 'string') nativeRequestId = row._requestId;
        if (row.type === 'control_response') {
          // The initialize response may include credentials. Never persist or forward it.
          const response = readObjectRecord(row.response);
          const id = String(response?.request_id ?? '');
          const pending = additions.get(id);
          if (pending) {
            clearTimeout(pending.timer);
            if (response?.subtype === 'success' && readObjectRecord(response.response)?.steered === true) {
              pending.accepted = true;
              try {
                persist({ type: 'user', uuid: id, __timestamp: new Date().toISOString(), insertedMidTurn: true,
                  message: { role: 'user', content: [{ type: 'text', text: pending.content }] } });
              } catch { persistenceError = true; child.kill(); }
            } else { additions.delete(id); pending.settled({ status: 'failed', error: 'WorkBuddy rejected this insertion because its active turn changed or ended.' }); }
          }
          return;
        }
        if (row.type === 'control_request') { permissions.request(appId, row, writer, send); return; }
        if (row.type === 'control_cancel_request') { permissions.cancel(appId, String(row.request_id)); return; }
        if (row.type === 'system' && row.subtype === 'init' && !announced) {
          if (row.session_id !== nativeId) { stderr = 'WorkBuddy returned an unexpected session id.'; child.kill(); return; }
          announced = true;
          writer.setSessionId?.(nativeId);
          if (!previous) writer.send(createNormalizedMessage({ kind: 'session_created', newSessionId: nativeId, model, cwd: options.cwd || options.projectPath, sessionId: nativeId, provider: 'workbuddy' }));
          if (options.sessionId) sessionsDb.repointSessionToProviderSession(options.sessionId, { providerSessionId: nativeId, jsonlPath: transcript });
        }
        const isToolResult = row.type === 'user' && Array.isArray(readObjectRecord(row.message)?.content)
          && (readObjectRecord(row.message)!.content as unknown[]).some(block => readObjectRecord(block)?.type === 'tool_result');
        if (row.type === 'assistant' || row.type === 'result' || isToolResult) {
          try { persist(row); } catch { persistenceError = true; child.kill(); return; }
          if (row.type === 'assistant') {
            const blocks = readObjectRecord(row.message)?.content;
            if (Array.isArray(blocks)) for (const value of blocks) {
              const block = readObjectRecord(value);
              if (block?.type === 'text') protocolError ||= workBuddyTextProtocolError(block.text);
            }
          }
          if (row.type === 'result') {
            protocolError ||= workBuddyTextProtocolError(row.result);
            result = row; child.stdin.end();
            const used = Number(readObjectRecord(row._meta)?.['codebuddy.ai/contextUsed']);
            if (Number.isFinite(used) && used >= 0) writer.send(createNormalizedMessage({ kind: 'status', text: 'token_budget',
              provider: 'workbuddy', sessionId: nativeId, tokenBudget: { used } }));
          }
          else for (const message of context.normalizeMessage(row, nativeId)) writer.send(message);
        }
      });
      child.once('error', () => { stderr = 'Could not start the installed WorkBuddy client.'; });
      child.once('close', code => {
        if (active.get(appId) === entry) { permissions.cancel(appId); active.delete(appId); }
        if (entry.aborted) { resolve(); return; }
        // The bundled CLI can exit 0 on auth/model errors. Require its semantic result as well.
        const succeeded = code === 0 && result?.subtype === 'success' && result?.is_error === false && !persistenceError && !protocolError;
        entry.settle({ status: succeeded ? 'succeeded' : 'failed', error: succeeded ? null : 'WorkBuddy failed before completing the inserted instruction.' });
        if (!succeeded) {
          const error = persistenceError ? 'Could not save the WorkBuddy conversation.'
            : protocolError || (typeof result?.result === 'string' ? result.result
              : stderr.trim() || 'WorkBuddy ended without a successful result. Check its local login and model permissions.');
          try { persist({ type: 'claudex_error', uuid: randomUUID(), __timestamp: new Date().toISOString(), content: error }); } catch { /* Preserve the runtime failure even when disk writes failed. */ }
          writer.send(createNormalizedMessage({ kind: 'error', content: error, provider: 'workbuddy', sessionId: nativeId }));
        }
        writer.send(createCompleteMessage({ provider: 'workbuddy', sessionId: nativeId, exitCode: succeeded ? 0 : 1 }));
        if (succeeded) resolve(); else reject(new Error('WorkBuddy did not complete successfully.'));
      });
    });
  },
  submitLiveInput(sessionId, id, content, settled) {
    const entry = active.get(sessionId);
    if (!entry || entry.aborted) throw new Error('No running WorkBuddy turn accepts input. Queue this message instead.');
    entry.submit(id, content, settled);
  },
  async abort(sessionId) {
    const entry = active.get(sessionId);
    if (!entry) return false;
    entry.aborted = true;
    entry.settle({ status: 'interrupted', error: 'WorkBuddy was stopped before this addition completed.' });
    permissions.cancel(sessionId);
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
