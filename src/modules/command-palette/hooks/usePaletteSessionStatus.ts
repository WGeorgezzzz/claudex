import { api } from '@/shared/api';
import type { SessionWorkspaceEntry } from '@/shared/types';
import { useApiSource } from '@/modules/command-palette/hooks/useApiSource';

/** Optional organization metadata: older servers still support the session switcher without badges. */
export function usePaletteSessionStatus(enabled: boolean) {
  return useApiSource<SessionWorkspaceEntry, {data?: SessionWorkspaceEntry[]}>({
    enabled, deps: [],
    fetcher: () => api.sessionWorkspace.list(),
    parse: body => Array.isArray(body.data) ? body.data : [],
  });
}
