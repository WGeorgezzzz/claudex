import { initializeDatabase, closeConnection, messageQueueDb, getConnection } from '@/modules/database/index.js';
import type { AnyRecord, LLMProvider, QueuedTurnRecord } from '@/shared/types.js';

import { providerRuntimeService } from './provider-runtime.service.js';

// The worker owns SDK closures and settles durable queue receipts independently
// of the lifespan of the HTTP client that submitted them.
export async function executeSupervisedTurn(spec: AnyRecord, emit: (kind: string, data: unknown) => void,
  installControl: (handler: (operation: AnyRecord) => unknown | Promise<unknown>) => void): Promise<unknown> {
  await initializeDatabase();
  const provider = spec.provider as LLMProvider;
  const sessionId = spec.options.sessionId as string;
  installControl(async operation => {
    switch (operation.type) {
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
    const result = await providerRuntimeService.run(provider, spec.command, spec.options, {
      userId: spec.userId, isWebSocketWriter: spec.isWebSocketWriter,
      send(data) {
        emit('message', data);
        const event = data as AnyRecord;
        if (event.kind === 'complete' && spec.options.cloudcliQueueAttempt) {
          if (spec.options.cloudcliQueueAttempt.user_id !== Number(spec.userId) || spec.options.cloudcliQueueAttempt.session_id !== sessionId) throw new Error('Queue attempt ownership mismatch');
          messageQueueDb.finish(spec.options.cloudcliQueueAttempt, event.aborted ? 'interrupted' : event.success === false || (typeof event.exitCode === 'number' && event.exitCode !== 0) ? 'failed' : 'succeeded', null);
        }
      },
      setSessionId(id) { emit('session', id); },
    });
    while (providerRuntimeService.hasBackgroundWork(sessionId)) await new Promise(resolve => setTimeout(resolve, 200));
    return result;
  } finally { clearInterval(timer); closeConnection(); }
}
