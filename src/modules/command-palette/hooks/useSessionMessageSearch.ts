import { useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { ConversationProjectResult, PaletteSessionEntry, SessionTitleSearchResult } from '@/shared/types';

/** CommandPalette searches titles and transcript text across the selected scope, including unloaded pages. */
export function useSessionMessageSearch(projectId: string | undefined, query: string, enabled: boolean) {
  const key = `${projectId ?? '*'}:${query.trim()}`;
  // Tag results with their request so stale results cannot flash during typing or scope changes.
  const [state, setState] = useState<{key: string; items: PaletteSessionEntry[]; searching: boolean; error: boolean}>({key: '', items: [], searching: false, error: false});
  // Explicit retries restart the same search without changing the user's text.
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    if (!enabled || query.trim().length < 2) return;
    let es: EventSource | null = null;
    let finished = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const current = () => request === generation.current && !finished;
    setState({key, items: [], searching: true, error: false});
    const handle = setTimeout(() => {
      const matches = new Map<string, PaletteSessionEntry>();
      const publish = () => { if (current()) setState({key, items: [...matches.values()], searching: true, error: false}); };
      const finish = (error: boolean) => {
        if (!current()) return;
        finished = true;
        es?.close(); clearTimeout(timeout);
        setState({key, items: [...matches.values()], searching: false, error});
      };
      es = new EventSource(api.searchConversationsUrl(query.trim()));
      es.addEventListener('title-results', event => {
        if (!current()) return;
        try {
          const {titleResults} = JSON.parse((event as MessageEvent).data) as {titleResults: SessionTitleSearchResult[]};
          for (const row of titleResults) if (!projectId || row.projectId === projectId) {
            matches.set(row.sessionId, {...matches.get(row.sessionId), id: row.sessionId, label: row.sessionTitle || row.sessionId,
              provider: row.provider, projectId: row.projectId, projectName: row.projectDisplayName});
          }
          publish();
        } catch { finish(true); }
      });
      es.addEventListener('result', event => {
        if (!current()) return;
        try {
          const {projectResult: project} = JSON.parse((event as MessageEvent).data) as {projectResult: ConversationProjectResult};
          if (projectId && project.projectId !== projectId) return;
          for (const row of project.sessions) matches.set(row.sessionId, {id: row.sessionId, label: matches.get(row.sessionId)?.label ?? (row.sessionSummary || row.sessionId),
            provider: row.provider, projectId: project.projectId, projectName: project.projectDisplayName || project.projectName,
            snippet: row.matches[0]?.snippet, timestamp: row.matches[0]?.timestamp});
          publish();
        } catch { finish(true); }
      });
      es.addEventListener('done', () => finish(false));
      es.addEventListener('error', () => finish(true));
      timeout = setTimeout(() => finish(true), 60000);
    }, 250);
    return () => { generation.current++; clearTimeout(handle); clearTimeout(timeout); es?.close(); };
  }, [projectId, query, enabled, key, retry]);
  const active = enabled && query.trim().length >= 2;
  const visible = active && state.key === key;
  return {items: visible ? state.items : [], searching: active && (!visible || state.searching), error: visible && state.error, retry: () => setRetry(value => value + 1)};
}
