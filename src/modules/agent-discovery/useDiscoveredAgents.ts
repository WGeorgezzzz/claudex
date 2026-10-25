import { useCallback, useEffect, useState } from 'react';
import { api } from '@/shared/api';
import type { AgentDiscoverySnapshot } from '@/shared/types';

/** Chat refreshes provider availability when Settings rescans or changes an administrator toggle. */
export function useDiscoveredAgents() {
  // A missing snapshot distinguishes loading/unavailable discovery from an explicit empty set.
  const [snapshot, setSnapshot] = useState<AgentDiscoverySnapshot | null>(null);
  const refresh = useCallback(async () => {
    try { const r = await api.providers.discovery(); if (r.ok) setSnapshot(await r.json()); } catch { /* Keep the last known availability. */ }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    window.addEventListener('nexagent:discovery-updated', refresh);
    return () => { clearInterval(timer); window.removeEventListener('nexagent:discovery-updated', refresh); };
  }, [refresh]);
  return snapshot;
}
