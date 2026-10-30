import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { getConnection, getSessionOwnerId, messageQueueDb } from '@/modules/database/index.js';
import { getCloudCliHomeDir } from '@/shared/index.js';
import { createNormalizedMessage } from '@/shared/utils.js';
import type { AnyRecord, LLMProvider, ProviderRuntimeWriter, QueuedTurnRecord } from '@/shared/types.js';

import { DurableProvider } from './provider-supervisor.service.js';
import { launchSupervisedTurn, inspectSupervisedTurns } from './provider-turn-supervision.service.js';
import { supervisedRuntimeState as state } from './provider-supervision-state.service.js';
import { createProviderRestartLease } from './provider-restart-lease.service.js';

const restartLease = createProviderRestartLease(value => { state.draining = value; });
export const cancelProviderRestart = (handoffId: string) => restartLease.cancel(handoffId);
export const renewProviderRestart = (handoffId: string) => restartLease.renew(handoffId);

const root = () => path.join(getCloudCliHomeDir(), 'supervised-turns');
const queueRow = (spec: AnyRecord) => spec.options?.cloudcliQueueAttempt as QueuedTurnRecord | undefined;
function finishQueue(spec: AnyRecord, event: AnyRecord): void {
  const row = queueRow(spec);
  if (!row) return;
  if (row.user_id !== Number(spec.userId) || row.session_id !== spec.options.sessionId) throw new Error('Queue attempt ownership mismatch');
  const failed = event.success === false || (typeof event.exitCode === 'number' && event.exitCode !== 0);
  messageQueueDb.finish(row, event.aborted ? 'interrupted' : failed ? 'failed' : 'succeeded', failed ? 'Provider reported a failed turn.' : null);
}
function acknowledge(client: DurableProvider): void {
  const fd = fs.openSync(path.join(client.directory, 'acknowledged.json'), 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ at: new Date().toISOString() })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
async function consume(client: DurableProvider, writer: ProviderRuntimeWriter, spec: AnyRecord, ready?: () => void): Promise<void> {
  let terminal = false;
  let providerError = false;
  let settlementFailed = false;
  const sessionId = spec.options.sessionId as string;
  const replayBytes = fs.statSync(path.join(client.directory, 'output.ndjson')).size;
  if (!replayBytes) ready?.();
  try {
    for await (const { event, offset } of client.events()) {
      const entry = state.entries.get(sessionId);
      if (event.kind === 'turn-start') {
        spec = event.data.spec;
        terminal = false; providerError = false;
        if (entry) {
          entry.currentSpec = spec; entry.foregroundCompleted = false;
          if (event.data.id !== 'initial') {
            const continuation = entry.continuation;
            if (continuation && continuation.id === event.data.id) writer = continuation.writer;
            else {
              const { chatRunRegistry } = await import('@/modules/websocket/index.js');
              const run = chatRunRegistry.startRun({ appSessionId: sessionId, provider: spec.provider, providerSessionId: null,
                connection: null, userId: spec.userId, initialSeq: spec.options.cloudcliSupervisorInitialSeq || 0 });
              if (!run) throw new Error('Cannot restore continued foreground turn ' + sessionId);
              writer = run.writer;
            }
          }
        }
      }
      if (event.kind === 'approvals' && entry) entry.pending = event.data;
      if (event.kind === 'background' && entry) entry.background = Boolean(event.data);
      if (event.kind === 'settlement-error') settlementFailed = true;
      if (event.kind === 'session') writer.setSessionId?.(event.data);
      if (event.kind === 'monitor-finalized' && (event.data.receipt || spec.options.cloudcliMonitorReceipt)?.isolated && event.data.report) {
        const receipt = event.data.receipt || spec.options.cloudcliMonitorReceipt;
        const { connectedClients, clientUserIds } = await import('@/modules/websocket/index.js');
        const report = createNormalizedMessage({ id: 'monitor-report:' + receipt.runId, kind: 'text', role: 'assistant',
          provider: spec.provider, sessionId: receipt.row.session_id, timestamp: event.data.finished_at,
          content: '**监测「' + receipt.row.name + '」· 第 ' + (event.data.round_number || receipt.row.run_count + 1) + ' 轮**\n\n' + event.data.report + '\n\n[展开本轮会话](/session/' + receipt.sessionId + ')' });
        for (const client of connectedClients) if (client.readyState === 1 && clientUserIds.get(client) === Number(spec.userId)) client.send(JSON.stringify(report));
      }
      if (event.kind === 'message') {
        if (event.data.kind === 'error') providerError = true;
        if (entry && event.data.kind === 'permission_request') entry.pending = [...entry.pending.filter(row => row.requestId !== event.data.requestId), event.data];
        if (entry && ['permission_resolved', 'permission_cancelled'].includes(event.data.kind)) entry.pending = entry.pending.filter(row => row.requestId !== event.data.requestId);
        if (event.data.kind === 'complete') {
          terminal = true; finishQueue(spec, providerError ? { ...event.data, success: false } : event.data);
          if (entry) entry.foregroundCompleted = true;
        }
        writer.send({ ...event.data, supervisorRunId: path.basename(client.directory), supervisorSeq: event.seq });
        if (event.data.kind === 'complete' && entry?.continuation) {
          entry.continuation.resolve(); entry.continuation = undefined;
        }
      }
      if (event.kind === 'exit') {
        if (!terminal) {
          finishQueue(spec, { exitCode: 1 });
          writer.send({ kind: 'complete', sessionId, provider: spec.provider, exitCode: 1, success: false });
        }
        // Leave failed monitor settlement replayable on the next startup.
        if (!settlementFailed) acknowledge(client);
      }
      if (offset >= replayBytes) { ready?.(); ready = undefined; }
    }
  } finally {
    state.entries.get(sessionId)?.continuation?.reject(new Error('Supervisor ended before continued turn completed'));
    if (state.entries.get(sessionId)?.client === client) state.entries.delete(sessionId);
  }
}

// Default runtime dispatch starts exactly one SDK owner outside the web process.
export async function runSupervised(provider: LLMProvider, command: string, options: AnyRecord, writer: ProviderRuntimeWriter): Promise<void> {
  if (state.draining) throw new Error('Server is handing off providers for restart; retry after restart.');
  const sessionId = String(options.sessionId);
  const { chatRunRegistry } = await import('@/modules/websocket/index.js');
  const existing = state.entries.get(sessionId);
  if (existing) {
    if (existing.provider !== provider || !existing.foregroundCompleted || existing.continuation) throw new Error('A supervised foreground turn is already running for this session');
    const client = existing.client || await existing.launching;
    if (!client || Number(existing.currentSpec?.userId) !== Number(writer.userId)) throw new Error('Continuation ownership mismatch');
    const id = crypto.randomUUID();
    const spec = { mode: 'runtime', provider, command, options: { ...options, cloudcliSupervisorInitialSeq: chatRunRegistry.getRun(sessionId)?.lastSeq || 0 }, userId: writer.userId, isWebSocketWriter: writer.isWebSocketWriter };
    const completion = new Promise<void>((resolve, reject) => { existing.continuation = { id, writer, resolve, reject }; });
    // Observe rejection even if a transport failure occurs before awaiting it.
    void completion.catch(() => {});
    try { await client.control({ type: 'continue-turn', id, spec }); }
    catch (error) {
      // A lost HTTP ACK is not permission to send the prompt twice.
      const accepted = fs.readFileSync(path.join(client.directory, 'output.ndjson'), 'utf8').split('\n').some(line => {
        try { const event = JSON.parse(line); return event.kind === 'turn-start' && event.data.id === id; } catch { return false; }
      });
      if (!accepted) { state.entries.get(sessionId)?.continuation?.reject(error); existing.continuation = undefined; throw error; }
    }
    return completion;
  }
  const entry: NonNullable<ReturnType<typeof state.entries.get>> = { provider, pending: [], background: false };
  state.entries.set(sessionId, entry);
  const initialSeq = chatRunRegistry.getRun(sessionId)?.lastSeq || 0;
  const spec = { provider, options: { ...options, cloudcliSupervisorInitialSeq: initialSeq }, userId: writer.userId };
  try {
    entry.launching = launchSupervisedTurn(root(), provider, command, spec.options, writer);
    entry.client = await entry.launching;
    await consume(entry.client, writer, spec);
  } catch (error) {
    if (!entry.client) state.entries.delete(sessionId);
    throw error;
  }
}

// Startup is awaited before queue recovery or HTTP listening. Replays durable
// completion before uncertain queue attempts can be marked interrupted.
export async function recoverProviderSupervision(): Promise<string[]> {
  fs.mkdirSync(root(), { recursive: true });
  const { chatRunRegistry } = await import('@/modules/websocket/index.js');
  const protectedSessions: string[] = [];
  for (const { client, record, adopted } of await inspectSupervisedTurns(root())) {
    if (fs.existsSync(path.join(client.directory, 'acknowledged.json'))) continue;
    const initialSpec = JSON.parse(fs.readFileSync(path.join(client.directory, 'launch.json'), 'utf8'));
    if (initialSpec.mode !== 'runtime') continue;
    const sessionId = initialSpec.options.sessionId as string;
    if (getSessionOwnerId(sessionId) !== Number(initialSpec.userId)) continue;
    const journal = fs.readFileSync(path.join(client.directory, 'output.ndjson'), 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    let spec = initialSpec;
    let turnId = 'initial';
    let complete: AnyRecord | undefined;
    let outcome: AnyRecord = { finalText: '', providerError: null, completed: false };
    for (const row of journal) {
      if (row.kind === 'turn-start') {
        spec = row.data.spec; turnId = row.data.id; complete = undefined;
        if (spec.provider !== initialSpec.provider || spec.userId !== initialSpec.userId || spec.options.sessionId !== sessionId) throw new Error('Durable turn ownership mismatch');
        outcome = { finalText: '', providerError: null, completed: false };
      }
      if (row.kind === 'message') {
        const event = row.data;
        if (event.text === 'monitor_usage') outcome.usage = event.monitorUsage;
        if (event.kind === 'text' && event.role === 'assistant') outcome.finalText = event.content;
        if (event.kind === 'error') outcome.providerError = String(event.content || 'Provider error');
        if (event.kind === 'complete') {
          complete = row; outcome.completed = true;
          if (event.aborted || event.success === false || (typeof event.exitCode === 'number' && event.exitCode !== 0)) outcome.providerError ||= 'Turn failed or was interrupted';
          finishQueue(spec, outcome.providerError ? { ...event, success: false } : event);
          if (!adopted && spec.options.cloudcliMonitorReceipt) {
            const receipt = spec.options.cloudcliMonitorReceipt;
            if (receipt.row.user_id !== Number(spec.userId) || receipt.sessionId !== sessionId) throw new Error('Monitor receipt ownership mismatch');
            const { finishSupervisedMonitorRound } = await import('@/modules/monitors/index.js');
            await finishSupervisedMonitorRound(receipt, outcome);
          }
        }
      }
    }
    if (adopted || complete) {
      if (state.entries.has(sessionId)) throw new Error('Multiple supervised owners for session ' + sessionId);
      const run = chatRunRegistry.startRun({ appSessionId: sessionId, provider: initialSpec.provider, providerSessionId: null, connection: null, userId: initialSpec.userId,
        initialSeq: initialSpec.options.cloudcliSupervisorInitialSeq || 0, startedAt: Date.parse(record.startedAt) });
      if (!run) throw new Error('Cannot register recovered provider ' + sessionId);
      state.entries.set(sessionId, { client, provider: spec.provider, pending: [], background: false, currentSpec: initialSpec });
      if (adopted) protectedSessions.push(sessionId);
      await new Promise<void>((resolve, reject) => {
        void consume(client, run.writer, initialSpec, resolve).catch(error => {
          chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 }); reject(error);
        });
      });
      const owned = state.entries.get(sessionId);
      if (adopted && owned) owned.pending = await client.control({ type: 'pending-approvals' });
      continue;
    }
    // Never launch a second owner while an authenticated endpoint is merely
    // unavailable. A live/reused PID is uncertain and blocks automatic replay.
    let alive = false;
    try { process.kill(record.pid, 0); alive = true; } catch { /* Confirmed gone. */ }
    if (alive) throw new Error('Supervisor identity could not be verified for live PID ' + record.pid);
    if (!record.metadata?.formerlyRunning || !record.metadata?.userTurn || record.metadata?.foregroundCompleted) { acknowledge(client); continue; }
    const requestId = 'restart:' + record.id + (turnId === 'initial' ? '' : ':' + turnId);
    const db = getConnection();
    db.transaction(() => {
      const row = queueRow(spec);
      if (row) messageQueueDb.finish(row, 'interrupted', 'Provider owner was lost during restart.');
      let recovery = messageQueueDb.byRequest(Number(spec.userId), requestId);
      if (!recovery) {
        const content = '服务已重启，继续上一步';
        recovery = messageQueueDb.create(Number(spec.userId), sessionId, requestId, crypto.createHash('sha256').update(requestId).digest('hex'), content,
          JSON.stringify(spec.options));
      }
      // Preserve the interrupted attempt and link its replacement atomically.
      // FIFO skips only this explicitly superseded head, never unrelated failures.
      if (row) db.prepare('UPDATE message_queue SET recovered_by=? WHERE id=? AND run_id=? AND user_id=?').run(recovery.id, row.id, row.run_id, Number(spec.userId));
    })();
    acknowledge(client);
  }
  return protectedSessions;
}

// Deployment asks the running service for authenticated adoption evidence and
// freezes new launches; legacy in-process turns make handoff fail closed.
export async function prepareProviderRestart(handoffId?: string): Promise<AnyRecord> {
  const lease = restartLease.begin(handoffId);
  try {
    const { chatRunRegistry } = await import('@/modules/websocket/index.js');
    const rows = chatRunRegistry.listRunningRuns();
    const evidence = [];
    for (const row of rows) {
      const entry = state.entries.get(row.sessionId);
      if (!entry) throw new Error('Legacy turn cannot be handed off: ' + row.sessionId);
    }
    // Include retained SDK owners whose foreground turn already completed.
    for (const [sessionId, entry] of state.entries) {
      const client = entry.client || await entry.launching;
      if (!client || !(await client.identity())) throw new Error('Supervisor not ready: ' + sessionId);
      evidence.push({ sessionId, ...client.registry() });
    }
    restartLease.assertCurrent(lease.handoffId);
    return { ready: true, ...restartLease.renew(lease.handoffId), sessions: evidence };
  } catch (error) {
    try { restartLease.cancel(lease.handoffId); } catch { /* A newer lease owns ingress. */ }
    throw error;
  }
}
