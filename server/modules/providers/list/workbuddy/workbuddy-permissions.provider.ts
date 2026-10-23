import { randomUUID } from 'node:crypto';

import type { NormalizedMessage, ProviderPermissionDecision, ProviderRuntimeWriter } from '@/shared/index.js';
import { createNormalizedMessage, readObjectRecord } from '@/shared/index.js';

/** Runtime and focused tests share the native CLI permission bridge, scoped by app session and unique UI request IDs. */
export class WorkBuddyPermissionBridge {
  private pending = new Map<string, {
    sessionId: string;
    nativeId: string;
    event: NormalizedMessage;
    writer: ProviderRuntimeWriter;
    send: (value: unknown) => void;
  }>();

  request(sessionId: string, row: Record<string, unknown>, writer: ProviderRuntimeWriter, send: (value: unknown) => void): void {
    const request = readObjectRecord(row.request);
    if (typeof row.request_id !== 'string') return;
    if (request?.subtype !== 'can_use_tool' || typeof request.tool_name !== 'string') {
      send({ type: 'control_response', response: { subtype: 'error', request_id: row.request_id, error: 'Unsupported WorkBuddy control request.' } });
      return;
    }
    const requestId = `workbuddy-${randomUUID()}`;
    const event = createNormalizedMessage({ kind: 'permission_request', requestId, sessionId, provider: 'workbuddy',
      toolName: request.tool_name, toolId: request.tool_use_id, input: request.input });
    this.pending.set(requestId, { sessionId, nativeId: row.request_id, event, writer, send });
    writer.send(event);
  }

  resolve(requestId: string, decision: ProviderPermissionDecision): void {
    const request = this.pending.get(requestId);
    if (!request) return;
    this.pending.delete(requestId);
    request.send({ type: 'control_response', response: { subtype: 'success', request_id: request.nativeId,
      response: { allowed: decision.allow, updatedInput: decision.updatedInput ?? request.event.input,
        reason: decision.message || (decision.allow ? 'Approved by user' : 'Denied by user') } } });
    request.writer.send(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId: request.sessionId, provider: 'workbuddy' }));
  }

  listPending(sessionId: string): NormalizedMessage[] {
    return [...this.pending.values()].filter(request => request.sessionId === sessionId).map(request => request.event);
  }

  cancel(sessionId: string, nativeId?: string): void {
    for (const [requestId, request] of this.pending) {
      if (request.sessionId !== sessionId || (nativeId && request.nativeId !== nativeId)) continue;
      this.pending.delete(requestId);
      request.writer.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, sessionId, provider: 'workbuddy' }));
    }
  }
}
