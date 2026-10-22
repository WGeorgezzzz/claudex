import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { PaletteSessionEntry, ProjectSession, RecentConversationListItem } from '@/shared/types';

const PAGE_SIZE = 50;

/** CommandPalette loads one page at a time; undefined projectId means all active projects. */
export function useSessionsSource(projectId: string | undefined, enabled: boolean) {
  // A scope-tagged snapshot prevents an old project's rows appearing during a scope change.
  const [state, setState] = useState<{scope?: string; items: PaletteSessionEntry[]; hasMore: boolean; loading: boolean; error: boolean}>({items: [], hasMore: false, loading: false, error: false});
  const scope = projectId ?? '*';
  const generation = useRef(0);
  const offset = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const load = useCallback(async (append: boolean) => {
    if (!enabled || (append && pending.current)) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const request = ++generation.current;
    const start = append ? offset.current : 0;
    setState(previous => ({scope, items: append && previous.scope === scope ? previous.items : [], hasMore: append && previous.hasMore, loading: true, error: false}));
    try {
      const response = projectId
        ? await api.projectSessions(projectId, {limit: PAGE_SIZE, offset: start}, {signal: controller.signal})
        : await api.recentConversations({limit: PAGE_SIZE, offset: start}, {signal: controller.signal});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const data = payload.data ?? payload;
      const raw = projectId ? data.sessions : data.conversations;
      if (!Array.isArray(raw)) throw new Error('Invalid session list');
      const items: PaletteSessionEntry[] = projectId
        ? (raw as ProjectSession[]).map(s => ({id: s.id, label: String(s.title || s.summary || s.name || s.id), provider: s.__provider || s.provider, projectId}))
        : (raw as RecentConversationListItem[]).map(s => ({id: s.sessionId, label: s.sessionTitle || s.sessionId, provider: s.provider, projectId: s.projectId, projectName: s.projectDisplayName}));
      if (controller.signal.aborted || request !== generation.current) return;
      offset.current = start + raw.length;
      const meta = projectId ? data.sessionMeta ?? data : data;
      const hasMore = raw.length > 0 && Boolean(meta.hasMore ?? (meta.total != null ? offset.current < meta.total : raw.length === PAGE_SIZE));
      setState(previous => ({scope, items: [...new Map([...(append ? previous.items : []), ...items].map(item => [item.id, item])).values()], hasMore, loading: false, error: false}));
    } catch {
      if (!controller.signal.aborted && request === generation.current) setState(previous => ({...previous, loading: false, error: true}));
    } finally { if (pending.current === controller) pending.current = null; }
  }, [enabled, projectId, scope]);
  useEffect(() => {
    offset.current = 0;
    if (enabled) void load(false);
    return () => { generation.current++; pending.current?.abort(); pending.current = null; };
  }, [enabled, load]);
  const visible = enabled && state.scope === scope;
  return {items: visible ? state.items : [], hasMore: visible && state.hasMore, loading: enabled && (!visible || state.loading), error: visible && state.error,
    loadMore: () => load(true), retry: () => load(offset.current > 0)};
}
