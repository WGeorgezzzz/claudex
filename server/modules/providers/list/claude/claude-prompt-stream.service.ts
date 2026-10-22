import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderLiveInputResult } from '@/shared/types.js';

type LiveInputResult = ProviderLiveInputResult;
type LiveChannel = { submit: (id: string, content: string, settled: (result: LiveInputResult) => void) => void };
const channels = new Map<string, LiveChannel>();

/** ClaudeProvider exposes this to the runtime service; it never creates or interrupts a process. */
export function submitClaudeLiveInput(sessionId: string, id: string, content: string, settled: (result: LiveInputResult) => void): void {
  const channel = channels.get(sessionId);
  if (!channel) throw new Error('This Claude process is no longer accepting input. Add the message to the queue instead.');
  channel.submit(id, content, settled);
}

/** Used by the Claude provider to submit additional turns without closing the live CLI's stdin. */
export function createHeldPromptStream(messages: SDKUserMessage[], sessionId?: string) {
  const queue = [...messages];
  let open = true;
  let correlated = false;
  const suppliedIds = new Set(messages.map(message => message.uuid));
  const pending = new Map<string, (result: LiveInputResult) => void>();
  let wake: (() => void) | undefined;
  const stream = (async function* () {
    while (open || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    }
  })();
  const channel: LiveChannel = {
    submit(id, content, settled) {
      if (!open || !correlated) throw new Error('Claude has not confirmed this input channel yet. Keep the draft or add it to the queue.');
      if (pending.size >= 20) throw new Error('There are already 20 unconfirmed additions. Wait for Claude to respond.');
      if (pending.has(id)) return;
      pending.set(id, settled);
      suppliedIds.add(id as SDKUserMessage['uuid']);
      queue.push({ type: 'user', uuid: id, message: { role: 'user', content }, parent_tool_use_id: null } as SDKUserMessage);
      wake?.();
    },
  };
  if (sessionId) channels.set(sessionId, channel);
  return {
    stream,
    isOpen: () => open,
    hasPendingInputs: () => pending.size > 0,
    observeMessage(message: Record<string, unknown>) {
      if (message.parent_tool_use_id) return;
      const ids = Array.isArray(message.user_message_uuids) ? message.user_message_uuids : [message.user_message_uuid];
      if (ids.some(id => suppliedIds.has(id as SDKUserMessage['uuid']))) correlated = true;
      if (message.type !== 'result') return;
      for (const id of ids) {
        if (typeof id !== 'string') continue;
        const settled = pending.get(id);
        if (!settled) continue;
        pending.delete(id);
        const failed = message.is_error === true || (message.subtype && message.subtype !== 'success');
        settled({ status: failed ? 'failed' : 'succeeded', error: failed ? String(message.result || (Array.isArray(message.errors) ? message.errors.join('; ') : '') || 'Claude reported a failed turn.').slice(0,1000) : null });
      }
    },
    push(next: SDKUserMessage[]) {
      if (!open) throw new Error('The Claude input stream has closed; retry after the session settles.');
      queue.push(...next);
      next.forEach(message => suppliedIds.add(message.uuid));
      wake?.();
    },
    release() {
      open = false;
      if (sessionId && channels.get(sessionId) === channel) channels.delete(sessionId);
      for (const settled of pending.values()) settled({ status: 'interrupted', error: 'Claude closed before this addition was confirmed. Review it before retrying.' });
      pending.clear();
      wake?.();
    },
  };
}
