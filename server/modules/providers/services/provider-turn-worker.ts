import { initializeDatabase, closeConnection, messageQueueDb, getConnection, sessionsDb, getSessionOwnerId } from '@/modules/database/index.js';
import type { AnyRecord, LLMProvider, QueuedTurnRecord } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

import { providerRuntimeService } from './provider-runtime.service.js';

// The worker owns SDK closures and settles durable queue receipts independently
// of the lifespan of the HTTP client that submitted them.
export async function executeSupervisedTurn(spec: AnyRecord, emit: (kind: string, data: unknown) => void,
  installControl: (handler: (operation: AnyRecord) => unknown | Promise<unknown>) => void): Promise<unknown> {
  await initializeDatabase();
  const provider = spec.provider as LLMProvider;
  const sessionId = spec.options.sessionId as string;
  let current = { id: 'initial', spec, completed: false };
  const accepted = new Set<string>(['initial']);
  const running = new Set<Promise<unknown>>();
  const settlements = new Set<Promise<unknown>>();
  let settlementError: unknown;
  const launch = (next: AnyRecord, id: string) => {
    const turn = { id, spec: next, completed: false };
    current = turn; accepted.add(id);
    // This fsynced journal boundary precedes SDK input and survives lost ACKs.
    emit('turn-start', { id, spec: next });
    const outcome: AnyRecord = { finalText: '', providerError: null, completed: false };
    const writer = {
      userId: next.userId, isWebSocketWriter: next.isWebSocketWriter,
      send(data: AnyRecord) {
        if (data.kind === 'complete' && turn.completed) return;
        if (data.text === 'monitor_usage' && data.monitorUsage) outcome.usage = data.monitorUsage;
        if (data.kind === 'text' && data.role === 'assistant' && typeof data.content === 'string') outcome.finalText = data.content;
        if (data.kind === 'error') outcome.providerError = String(data.content || 'Provider error');
        emit('message', data);
        if (data.kind !== 'complete') return;
        turn.completed = true; outcome.completed = true;
        if (data.aborted || data.success === false || (typeof data.exitCode === 'number' && data.exitCode !== 0)) outcome.providerError ||= 'Turn failed or was interrupted';
        const row = next.options.cloudcliQueueAttempt;
        if (row) {
          if (row.user_id !== Number(next.userId) || row.session_id !== sessionId) throw new Error('Queue attempt ownership mismatch');
          messageQueueDb.finish(row, data.aborted ? 'interrupted' : outcome.providerError ? 'failed' : 'succeeded', outcome.providerError || null);
        }
        const receipt = next.options.cloudcliMonitorReceipt;
        if (receipt) {
          if (receipt.row.user_id !== Number(next.userId) || receipt.sessionId !== sessionId) throw new Error('Monitor receipt ownership mismatch');
          const settlement = import('@/modules/monitors/index.js').then(async ({ finishSupervisedMonitorRound }) => {
            const settled = await finishSupervisedMonitorRound(receipt, outcome);
            if (settled) emit('monitor-finalized', { ...settled, receipt });
          });
          settlements.add(settlement);
          void settlement.then(() => settlements.delete(settlement), error => { settlementError = error; emit('settlement-error', String(error)); settlements.delete(settlement); });
        }
      },
      setSessionId(id: string) {
        emit('session', id);
        if (next.userId != null && getSessionOwnerId(sessionId) === Number(next.userId)) sessionsDb.assignProviderSessionId(sessionId, id);
      },
    };
    const promise = Promise.resolve().then(() => providerRuntimeService.run(provider, next.command, next.options, writer)).catch(error => {
      if (!turn.completed) {
        writer.send(createNormalizedMessage({kind:'error',provider,sessionId,content:String(error)}));
        writer.send(createNormalizedMessage({kind:'complete',provider,sessionId,success:false,exitCode:1}));
      }
    });
    running.add(promise); void promise.finally(() => running.delete(promise));
    return promise;
  };
  installControl(async operation => {
    switch (operation.type) {
      case 'continue-turn': {
        const next = operation.spec;
        if (!next || next.provider !== provider || next.userId !== spec.userId || next.options?.sessionId !== sessionId) throw new Error('Continuation ownership mismatch');
        if (typeof operation.id !== 'string' || !operation.id) throw new Error('Continuation requires a durable turn id');
        if (accepted.has(operation.id)) return { accepted: true, id: operation.id };
        if (!current.completed) throw new Error('The current foreground turn is still running');
        launch(next, operation.id);
        return { accepted: true, id: operation.id };
      }
      case 'abort': return providerRuntimeService.abort(provider, sessionId);
      case 'force-stop': return providerRuntimeService.forceStop(provider, sessionId);
      case 'stop-background': return providerRuntimeService.stopBackgroundTask(provider, sessionId, operation.taskId);
      case 'approval': providerRuntimeService.resolveToolApproval(operation.requestId, operation.decision); return true;
      case 'pending-approvals': return providerRuntimeService.getPendingApprovalsForSession(sessionId);
      case 'live-input': return new Promise(resolve => providerRuntimeService.submitLiveInput(provider, sessionId, operation.id, operation.content, result => {
        const row = getConnection().prepare("SELECT * FROM message_queue WHERE run_id=? AND session_id=? AND user_id=? AND delivery_mode='live'").get(operation.id, sessionId, Number(spec.userId)) as QueuedTurnRecord | undefined;
        if (row) messageQueueDb.finish(row, result.status, result.error);
        resolve(result);
      }));
      case 'background': return providerRuntimeService.hasBackgroundWork(sessionId);
      default: throw new Error('Unknown runtime control operation');
    }
  });
  let snapshot = '';
  const refresh = () => {
    const pending = providerRuntimeService.getPendingApprovalsForSession(sessionId);
    const background = providerRuntimeService.hasBackgroundWork(sessionId);
    const next = JSON.stringify({ pending, background });
    if (next !== snapshot) { snapshot = next; emit('approvals', pending); emit('background', background); }
  };
  const timer = setInterval(refresh, 200);
  try {
    await launch(spec, 'initial');
    while (running.size || settlements.size || providerRuntimeService.hasBackgroundWork(sessionId)) await new Promise(resolve => setTimeout(resolve, 100));
    if (settlementError) throw settlementError;
    return { completed: current.completed };
  } finally { clearInterval(timer); closeConnection(); }
}
