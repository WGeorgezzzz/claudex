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
  const sessionId = spec.options.sessionId as string;
  const replayBytes = fs.statSync(path.join(client.directory, 'output.ndjson')).size;
  if (!replayBytes) ready?.();
  try {
    for await (const { event, offset } of client.events()) {
      const entry = state.entries.get(sessionId);
      if (event.kind === 'approvals' && entry) entry.pending = event.data;
      if (event.kind === 'background' && entry) entry.background = Boolean(event.data);
      if (event.kind === 'session') writer.setSessionId?.(event.data);
      if (event.kind === 'monitor-finalized' && spec.options.cloudcliMonitorReceipt?.isolated && event.data.report) {
        const receipt = spec.options.cloudcliMonitorReceipt;
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
        if (event.data.kind === 'complete') { terminal = true; finishQueue(spec, providerError ? { ...event.data, success: false } : event.data); }
        writer.send({ ...event.data, supervisorRunId: path.basename(client.directory), supervisorSeq: event.seq });
      }
      if (event.kind === 'exit') {
        if (!terminal) {
          finishQueue(spec, { exitCode: 1 });
          writer.send({ kind: 'complete', sessionId, provider: spec.provider, exitCode: 1, success: false });
        }
        acknowledge(client);
      }
      if (offset >= replayBytes) { ready?.(); ready = undefined; }
    }
  } finally {
    if (state.entries.get(sessionId)?.client === client) state.entries.delete(sessionId);
  }
}

// Default runtime dispatch starts exactly one SDK owner outside the web process.
export async function runSupervised(provider: LLMProvider, command: string, options: AnyRecord, writer: ProviderRuntimeWriter): Promise<void> {
  if (state.draining) throw new Error('Server is handing off providers for restart; retry after restart.');
  const sessionId = String(options.sessionId);
  if (state.entries.has(sessionId)) throw new Error('A supervised turn is already running for this session');
  const { chatRunRegistry } = await import('@/modules/websocket/index.js');
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
    const spec = JSON.parse(fs.readFileSync(path.join(client.directory, 'launch.json'), 'utf8'));
    if (spec.mode !== 'runtime') continue;
    const sessionId = spec.options.sessionId as string;
    if (getSessionOwnerId(sessionId) !== Number(spec.userId)) continue;
    const journal = fs.readFileSync(path.join(client.directory, 'output.ndjson'), 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const complete = journal.filter(row => row.kind === 'message' && row.data.kind === 'complete').at(-1);
    if (complete) finishQueue(spec, journal.some(row => row.kind === 'message' && row.data.kind === 'error') ? { ...complete.data, success: false } : complete.data);
    if (!adopted && complete && spec.options.cloudcliMonitorReceipt) {
      const receipt = spec.options.cloudcliMonitorReceipt;
      if (receipt.row.user_id !== Number(spec.userId) || receipt.sessionId !== sessionId) throw new Error('Monitor receipt ownership mismatch');
      const outcome: AnyRecord = { finalText: '', providerError: null, completed: false };
      for (const row of journal) if (row.kind === 'message') {
        const event = row.data;
        if (event.text === 'monitor_usage') outcome.usage = event.monitorUsage;
        if (event.kind === 'text' && event.role === 'assistant') outcome.finalText = event.content;
        if (event.kind === 'error') outcome.providerError = String(event.content || 'Provider error');
        if (event.kind === 'complete') { outcome.completed = true; if (event.aborted || event.success === false || (typeof event.exitCode === 'number' && event.exitCode !== 0)) outcome.providerError ||= 'Monitor turn failed or was interrupted'; }
      }
      const { finishSupervisedMonitorRound } = await import('@/modules/monitors/index.js');
      await finishSupervisedMonitorRound(receipt, outcome);
    }
    if (adopted || complete) {
      if (state.entries.has(sessionId)) throw new Error('Multiple supervised owners for session ' + sessionId);
      const run = chatRunRegistry.startRun({ appSessionId: sessionId, provider: spec.provider, providerSessionId: null, connection: null, userId: spec.userId,
        initialSeq: spec.options.cloudcliSupervisorInitialSeq || 0, startedAt: Date.parse(record.startedAt) });
      if (!run) throw new Error('Cannot register recovered provider ' + sessionId);
      state.entries.set(sessionId, { client, provider: spec.provider, pending: [], background: false });
      if (adopted) protectedSessions.push(sessionId);
      await new Promise<void>((resolve, reject) => {
        void consume(client, run.writer, spec, resolve).catch(error => {
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
    const requestId = 'restart:' + record.id;
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
export async function prepareProviderRestart(): Promise<AnyRecord> {
  state.draining = true;
  try {
    const { chatRunRegistry } = await import('@/modules/websocket/index.js');
    const rows = chatRunRegistry.listRunningRuns();
    const evidence = [];
    for (const row of rows) {
      const entry = state.entries.get(row.sessionId);
      if (!entry) throw new Error('Legacy turn cannot be handed off: ' + row.sessionId);
      const client = entry.client || await entry.launching;
      if (!client || !(await client.identity())) throw new Error('Supervisor not ready: ' + row.sessionId);
      evidence.push({ sessionId: row.sessionId, ...client.registry() });
    }
    return { ready: true, sessions: evidence };
  } catch (error) { state.draining = false; throw error; }
}
