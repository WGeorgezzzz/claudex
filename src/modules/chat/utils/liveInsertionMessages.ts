import type { ChatMessage, QueuedConversationMessage } from '@/shared/types';

/** ChatInterface restores confirmed live user messages when provider history omits its streaming-input echoes. */
export function restoreLiveInsertionMessages(messages: ChatMessage[], receipts: QueuedConversationMessage[]): ChatMessage[] {
  const restored = [...messages];
  const claimed = new Set<number>();
  const time = (message: ChatMessage) => new Date(message.timestamp).getTime();
  const firstTimestamp = messages.length ? Math.min(...messages.map(time).filter(Number.isFinite)) : Number.NEGATIVE_INFINITY;
  for (const receipt of receipts) {
    if (receipt.delivery_mode !== 'live' || !['running', 'succeeded'].includes(receipt.status)) continue;
    const timestamp = Date.parse(receipt.created_at);
    if (!Number.isFinite(timestamp)) continue;
    let nearest = -1;
    let distance = 5 * 60 * 1000;
    restored.forEach((message, index) => {
      const difference = Math.abs(time(message) - timestamp);
      if (!claimed.has(index) && message.type === 'user' && message.content === receipt.content && difference < distance) {
        nearest = index; distance = difference;
      }
    });
    if (nearest >= 0) {
      claimed.add(nearest);
      if (!restored[nearest].insertedMidTurn) restored[nearest] = {...restored[nearest], insertedMidTurn: true};
    } else if (timestamp >= firstTimestamp) {
      // Do not inject older receipts above a paginated tail the user has not loaded.
      // Receipt IDs keep reconstruction stable, and one-to-one matching preserves repeated insertions.
      restored.push({id: `live_receipt_${receipt.id}`, type: 'user', content: receipt.content, timestamp: receipt.created_at, insertedMidTurn: true});
      claimed.add(restored.length - 1);
    }
  }
  // Preserve the provider's original row order; insert only missing receipts by timestamp.
  const original = new Set(messages);
  const missing = restored.filter(message => message.id?.startsWith('live_receipt_') && !original.has(message));
  const ordered = restored.filter(message => !missing.includes(message));
  for (const message of missing) {
    const index = ordered.findIndex(row => time(row) > time(message));
    if (index < 0) ordered.push(message); else ordered.splice(index, 0, message);
  }
  return ordered;
}
