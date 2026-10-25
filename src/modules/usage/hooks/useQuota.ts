import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { QuotaOverview } from '@/shared/types';

/** Quota panel and sidebar poll shared server caches without persisting UI preferences. */
export function useQuota() {
  // Retain the last successful response when an HTTP refresh fails.
  const [data, setData] = useState<QuotaOverview | null>(null);
  // Transport failures are separate from each provider's reported refresh failure.
  const [error, setError] = useState('');
  // Disable duplicate manual refreshes while loading.
  const [busy, setBusy] = useState(false);
  // A refresh-driven clock makes stale labels and reset countdowns advance without impure renders.
  const [now, setNow] = useState(() => Date.now());
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setBusy(true);
    try {
      const response = await api.quota.overview();
      if (!response.ok) throw new Error('额度暂时不可用');
      const value = await response.json() as QuotaOverview;
      if (!signal?.aborted) { setData(value); setError(''); }
    } catch { if (!signal?.aborted) setError('额度刷新失败'); }
    finally { if (!signal?.aborted) { setBusy(false); setNow(Date.now()); } }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) void refresh(controller.signal); });
    const interval = setInterval(() => { if (!document.hidden) void refresh(controller.signal); }, 60000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [refresh]);
  return { data, error, busy, refresh, now };
}
