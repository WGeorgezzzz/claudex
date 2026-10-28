import { useEffect, useRef } from 'react';
import type { QueuedConversationMessage } from '@/shared/types';

/** An idle subscription can precede a detached task run. Queue receipts reconnect its audience. */
export function useQueuedTurnSync(sessionId: string | null, items: QueuedConversationMessage[], sync: () => void) {
  const callback = useRef(sync);
  callback.current = sync;
  const activity = items.filter(item => item.session_id === sessionId && item.delivery_mode !== 'live' && item.status !== 'queued')
    .map(item => `${item.id}:${item.status}:${item.attempt_count}`).sort().join('|');
  useEffect(() => {
    if (sessionId && activity) callback.current();
  }, [sessionId, activity]);
}
