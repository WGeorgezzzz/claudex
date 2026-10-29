import { initializeDatabase, closeConnection } from '@/modules/database/index.js';
import { providerRuntimeService } from './provider-runtime.service.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';

// Supervisor entrypoint: the entire SDK generator, RPC pending map, permission
// callbacks and stdin owner remain in this process when the web server dies.
export async function executeSupervisedTurn(
  spec: AnyRecord,
  emit: (kind: string, data: unknown) => void,
  installControl: (handler: (operation: AnyRecord) => unknown | Promise<unknown>) => void,
): Promise<unknown> {
  await initializeDatabase();
  const provider = spec.provider as LLMProvider;
  const sessionId = spec.options.sessionId as string;
  installControl(async operation => {
    switch (operation.type) {
      case 'abort': return providerRuntimeService.abort(provider, sessionId);
      case 'approval': providerRuntimeService.resolveToolApproval(operation.requestId, operation.decision); return true;
      case 'pending-approvals': return providerRuntimeService.getPendingApprovalsForSession(sessionId);
      case 'live-input': return new Promise(resolve => providerRuntimeService.submitLiveInput(provider, sessionId, operation.id, operation.content, resolve));
      case 'background': return providerRuntimeService.hasBackgroundWork(sessionId);
      default: throw new Error('Unknown runtime control operation');
    }
  });
  try {
    return await providerRuntimeService.run(provider, spec.command, spec.options, {
      userId: spec.userId, isWebSocketWriter: spec.isWebSocketWriter,
      send(data) { emit('message', data); },
      setSessionId(id) { emit('session', id); },
    });
  } finally { closeConnection(); }
}
