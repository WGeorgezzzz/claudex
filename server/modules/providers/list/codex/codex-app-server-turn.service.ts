import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import readline from 'node:readline';

import type { AnyRecord } from '@/shared/index.js';
import type { ProviderLiveInputResult } from '@/shared/types.js';

/**
 * Runs one Codex turn through `codex app-server` instead of `codex exec`.
 *
 * `exec` reads its prompt once and closes stdin, so nothing can reach a turn
 * that is already running. The app-server speaks JSON-RPC and has
 * `turn/steer`, the primitive the Codex clients use to fold a message the
 * user typed mid-turn into the running turn. Notifications are translated
 * back into the `codex exec` JSONL event shapes, so the runtime's existing
 * transform/normalize path is unchanged.
 */

type LiveChannel = {
  submit: (id: string, content: string, settled: (result: ProviderLiveInputResult) => void) => void;
};
const channels = new Map<string, LiveChannel>();

/** CodexProvider exposes this as `submitLiveInput`; it never starts a turn. */
export function submitCodexLiveInput(
  sessionId: string,
  id: string,
  content: string,
  settled: (result: ProviderLiveInputResult) => void,
): void {
  const channel = channels.get(sessionId);
  if (!channel) throw new Error('This Codex turn is no longer accepting input. Add the message to the queue instead.');
  channel.submit(id, content, settled);
}

export type CodexAppServerTurnOptions = {
  env: NodeJS.ProcessEnv;
  resumeThreadId?: string | null;
  cwd: string;
  model?: string | null;
  sandbox: string;
  approvalPolicy: string;
  effort?: string | null;
  planMode?: boolean;
  /** The runtime owns approval UI and clears it when native requests end. */
  onRequest?: (message: AnyRecord, reply: (result: AnyRecord) => void) => boolean;
  onRequestResolved?: (id: string | number) => void;
  /** A plain prompt, or `codex exec`-style input items (text / local_image). */
  input: string | AnyRecord[];
  signal: AbortSignal;
  /** Keys under which the live channel is reachable (app session id, thread id). */
  sessionKeys: () => Array<string | null | undefined>;
  /** Test seam: replaces the spawned child. */
  spawnServer?: () => ChildProcess;
};

const REQUEST_TIMEOUT_MS = 60_000;

function resolveLauncher(): string {
  return createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
}

function toUserInput(input: string | AnyRecord[]): AnyRecord[] {
  if (typeof input === 'string') return [{ type: 'text', text: input, text_elements: [] }];
  return input.map((item) => item?.type === 'local_image'
    ? { type: 'localImage', path: item.path }
    : { type: 'text', text: String(item?.text ?? ''), text_elements: [] });
}

const STATUS: Record<string, string> = { inProgress: 'in_progress', completed: 'completed', failed: 'failed', declined: 'failed' };

/** Maps an app-server ThreadItem to the `codex exec` item shape; null = not shown. */
export function mapCodexAppServerItem(item: AnyRecord | null | undefined): AnyRecord | null {
  if (!item || typeof item !== 'object') return null;
  const status = STATUS[String(item.status)] ?? item.status;
  switch (item.type) {
    case 'agentMessage':
      return { id: item.id, type: 'agent_message', text: item.text ?? '' };
    case 'reasoning': {
      const parts = [...(item.summary ?? []), ...((item.summary?.length ? [] : item.content) ?? [])];
      return { id: item.id, type: 'reasoning', text: parts.join('\n\n') };
    }
    case 'commandExecution':
      return {
        id: item.id, type: 'command_execution', command: item.command,
        aggregated_output: item.aggregatedOutput ?? '', exit_code: item.exitCode ?? undefined, status,
      };
    case 'fileChange':
      return {
        id: item.id, type: 'file_change', status,
        changes: (item.changes ?? []).map((change: AnyRecord) => ({ path: change.path, kind: change.kind?.type ?? change.kind })),
      };
    case 'mcpToolCall':
      return {
        id: item.id, type: 'mcp_tool_call', server: item.server, tool: item.tool,
        arguments: item.arguments, result: item.result, error: item.error, status,
      };
    case 'webSearch':
      return { id: item.id, type: 'web_search', query: item.query ?? '' };
    default:
      // userMessage (including steered input), hook prompts, compaction markers…
      return null;
  }
}

/**
 * Starts the app-server, opens/resumes the thread, starts the turn and yields
 * exec-shaped events until the turn ends. Registers a live channel for
 * `turn/steer` while the turn is in progress.
 */
export async function* runCodexAppServerTurn(options: CodexAppServerTurnOptions): AsyncGenerator<AnyRecord> {
  const child = options.spawnServer?.() ?? spawn(process.execPath, [resolveLauncher(), 'app-server'], {
    windowsHide: true,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2000); });
  child.stderr?.on('error', () => {});

  const queue: AnyRecord[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: Error | null = null;
  const push = (event: AnyRecord) => { queue.push(event); wake?.(); };
  const end = (error?: Error) => { if (!finished) { finished = true; failure = error ?? null; } wake?.(); };

  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const write = (message: AnyRecord) => { try { child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); } catch { /* exit handler reports */ } };
  const call = (method: string, params: unknown) => new Promise<AnyRecord>((resolve, reject) => {
    if (finished && failure) { reject(failure); return; }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex app-server did not answer "${method}".`)); }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    write({ id, method, params });
  });
  const failAll = (reason: string) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
    pending.clear();
  };

  let threadId: string | null = options.resumeThreadId ?? null;
  let turnId: string | null = null;
  let turnOpen = false;
  let usage: AnyRecord | null = null;
  const steered = new Map<string, (result: ProviderLiveInputResult) => void>();
  const settleSteered = (result: ProviderLiveInputResult) => {
    for (const settled of steered.values()) settled(result);
    steered.clear();
  };

  const channel: LiveChannel = {
    submit(id, content, settled) {
      if (!turnOpen || !threadId || !turnId) throw new Error('Codex has not started this turn yet, or it already ended. Add the message to the queue instead.');
      if (steered.has(id)) return;
      if (steered.size >= 20) throw new Error('There are already 20 unconfirmed additions. Wait for Codex to respond.');
      steered.set(id, settled);
      call('turn/steer', {
        threadId, expectedTurnId: turnId, clientUserMessageId: id,
        input: [{ type: 'text', text: content, text_elements: [] }],
      }).catch((error: Error) => {
        if (!steered.delete(id)) return;
        settled({ status: 'failed', error: `Codex did not accept the insertion: ${error.message}`.slice(0, 1000) });
      });
    },
  };
  const registered: string[] = [];
  const register = () => {
    for (const key of options.sessionKeys()) {
      if (key && !registered.includes(key)) { registered.push(key); channels.set(key, channel); }
    }
  };
  const unregister = () => {
    for (const key of registered) if (channels.get(key) === channel) channels.delete(key);
    registered.length = 0;
  };

  const reader = readline.createInterface({ input: child.stdout! });
  reader.on('line', (line) => {
    let message: AnyRecord;
    try { message = JSON.parse(line); } catch { return; }
    if (typeof message.id === 'number' && !message.method) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || 'Codex app-server rejected the request.'));
      else entry.resolve(message.result ?? {});
      return;
    }
    if (message.method && message.id !== undefined) {
      const params = message.params ?? {};
      if ((!params.threadId || params.threadId === threadId) && (!params.turnId || !turnId || params.turnId === turnId)
        && options.onRequest?.(message, result => write({ id: message.id, result }))) return;
      // Unknown requests fail closed; known approvals are answered by the user.
      write({ id: message.id, error: { code: -32601, message: 'Unsupported client request or inactive owning turn.' } });
      return;
    }
    const params = message.params ?? {};
    if (params.threadId && threadId && params.threadId !== threadId) return; // subagent threads
    switch (message.method) {
      case 'serverRequest/resolved':
        options.onRequestResolved?.(params.requestId);
        break;
      case 'turn/started':
        turnId = params.turn?.id ?? turnId;
        turnOpen = true;
        register();
        push({ type: 'turn.started' });
        break;
      case 'item/started':
      case 'item/completed': {
        if (params.turnId && turnId && params.turnId !== turnId) break;
        const item = mapCodexAppServerItem(params.item);
        if (item) push({ type: message.method === 'item/started' ? 'item.started' : 'item.completed', item });
        break;
      }
      case 'turn/plan/updated':
        push({
          type: 'item.updated',
          item: {
            id: `plan-${params.turnId ?? turnId}`, type: 'todo_list',
            items: (params.plan ?? []).map((step: AnyRecord) => ({ text: step.step, completed: step.status === 'completed' })),
          },
        });
        break;
      case 'thread/tokenUsage/updated':
        usage = params.tokenUsage ?? usage;
        break;
      case 'turn/completed': {
        if (params.turn?.id && turnId && params.turn.id !== turnId) break;
        turnOpen = false;
        unregister();
        const turn = params.turn ?? {};
        const total = usage?.total ?? {};
        if (turn.status === 'failed') {
          settleSteered({ status: 'failed', error: String(turn.error?.message ?? 'Codex reported a failed turn.').slice(0, 1000) });
          push({ type: 'turn.failed', error: { message: turn.error?.message ?? 'Turn failed' } });
        } else if (turn.status === 'interrupted') {
          settleSteered({ status: 'interrupted', error: 'The Codex turn was interrupted before this addition was answered.' });
          push({ type: 'turn.interrupted' });
        } else {
          settleSteered({ status: 'succeeded', error: null });
          push({
            type: 'turn.completed',
            usage: {
              input_tokens: total.inputTokens ?? 0, cached_input_tokens: total.cachedInputTokens ?? 0,
              output_tokens: total.outputTokens ?? 0, total_tokens: total.totalTokens ?? 0,
              model_context_window: usage?.modelContextWindow ?? undefined,
            },
          });
        }
        end();
        break;
      }
      default:
        break;
    }
  });

  child.on('error', (error) => { failAll(error.message); end(error); });
  child.on('exit', (code, signal) => {
    const reason = `codex app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})${stderr ? `: ${stderr.trim().split('\n').slice(-1)[0]}` : ''}`;
    failAll(reason);
    if (!finished) end(options.signal.aborted ? undefined : new Error(reason));
  });
  child.stdin?.on('error', () => {});
  child.stdout?.on('error', () => {});

  const onAbort = () => {
    if (threadId && turnId && turnOpen) void call('turn/interrupt', { threadId, turnId }).catch(() => {});
    setTimeout(() => child.kill(), 1500).unref?.();
    end();
  };
  options.signal.addEventListener('abort', onAbort, { once: true });

  try {
    await call('initialize', { clientInfo: { name: 'claudex', title: 'Nexagent', version: '1' }, capabilities: { experimentalApi: true } });
    write({ method: 'initialized', params: {} });
    const threadParams = {
      cwd: options.cwd, model: options.model ?? null,
      sandbox: options.sandbox, approvalPolicy: options.approvalPolicy,
    };
    const opened = options.resumeThreadId
      ? await call('thread/resume', { threadId: options.resumeThreadId, ...threadParams, excludeTurns: true })
      : await call('thread/start', threadParams);
    threadId = opened.thread?.id ?? threadId;
    register();
    yield { type: 'thread.started', thread_id: threadId };
    if (options.signal.aborted) return;
    const started = await call('turn/start', {
      threadId, input: toUserInput(options.input),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.model ? { collaborationMode: { mode: options.planMode ? 'plan' : 'default',
        settings: { model: options.model, reasoning_effort: options.effort ?? null, developer_instructions: null } } } : {}),
    });
    turnId = turnId ?? started.turn?.id ?? null;
    turnOpen = !finished;
    if (turnOpen) register();

    while (true) {
      if (queue.length) { yield queue.shift()!; continue; }
      if (finished) break;
      await new Promise<void>((resolve) => { wake = resolve; });
      wake = null;
    }
    if (failure) throw failure;
  } finally {
    options.signal.removeEventListener('abort', onAbort);
    turnOpen = false;
    unregister();
    settleSteered({ status: 'interrupted', error: 'Codex closed before this addition was confirmed. Review it before retrying.' });
    reader.close();
    failAll('Codex turn closed.');
    child.kill();
  }
}
