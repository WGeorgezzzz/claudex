import { randomUUID } from 'node:crypto';
import { createNormalizedMessage, readObjectRecord } from '@/shared/index.js';
import type { AnyRecord, NormalizedMessage, ProviderPermissionDecision, ProviderRuntimeWriter } from '@/shared/index.js';

/** Codex runtime routes native approvals and questions through the same session-owned UI as other providers. */
export class CodexPermissionBridge {
  private pending = new Map<string, { sessionId: string; nativeId: string | number; event: NormalizedMessage;
    writer: ProviderRuntimeWriter; reply: (result: AnyRecord) => void; method: string; params: AnyRecord }>();

  request(sessionId: string, message: AnyRecord, writer: ProviderRuntimeWriter, reply: (result: AnyRecord) => void): boolean {
    const method = String(message.method);
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
      'item/permissions/requestApproval', 'item/tool/requestUserInput'];
    if (!supported.includes(method)) return false;
    const params = message.params ?? {};
    const requestId = `codex-${randomUUID()}`;
    const question = method === 'item/tool/requestUserInput';
    const toolName = question ? 'AskUserQuestion' : method.includes('fileChange') ? 'CodexFileChange'
      : method.includes('/permissions/') ? 'CodexPermissions' : 'CodexCommand';
    const input = question ? { questions: (params.questions ?? []).map((q: AnyRecord) => ({
      ...q, options: q.options ?? [], multiSelect: false,
    })) } : params;
    const event = createNormalizedMessage({ kind: 'permission_request', requestId, sessionId, provider: 'codex',
      toolName, toolId: params.itemId, input });
    this.pending.set(requestId, { sessionId, nativeId: message.id, event, writer, reply, method, params });
    writer.send(event);
    return true;
  }

  resolve(requestId: string, decision: ProviderPermissionDecision): void {
    const request = this.pending.get(requestId);
    if (!request) return;
    this.pending.delete(requestId);
    const available = Array.isArray(request.params.availableDecisions) ? request.params.availableDecisions : [];
    const denied = available.includes('cancel') && !available.includes('decline') ? 'cancel' : 'decline';
    let result: AnyRecord = { decision: decision.allow ? 'accept' : denied };
    if (request.method === 'item/permissions/requestApproval') {
      result = { permissions: decision.allow ? request.params.permissions ?? {} : {}, scope: 'turn' };
    } else if (request.method === 'item/tool/requestUserInput') {
      const input = readObjectRecord(decision.updatedInput);
      const answers = readObjectRecord(input?.answers) ?? {};
      result = { answers: Object.fromEntries((request.params.questions ?? []).map((q: AnyRecord) => [q.id,
        { answers: decision.allow && typeof answers[q.question] === 'string' ? [answers[q.question]] : [] }])) };
    }
    request.reply(result);
    request.writer.send(createNormalizedMessage({ kind: 'permission_resolved', requestId,
      sessionId: request.sessionId, provider: 'codex' }));
  }

  listPending(sessionId: string): NormalizedMessage[] {
    return [...this.pending.values()].filter(row => row.sessionId === sessionId).map(row => row.event);
  }

  cancel(sessionId: string, nativeId?: string | number): void {
    for (const [id, row] of this.pending) {
      if (row.sessionId !== sessionId || (nativeId !== undefined && row.nativeId !== nativeId)) continue;
      this.pending.delete(id);
      row.writer.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId: id, sessionId, provider: 'codex' }));
    }
  }
}
