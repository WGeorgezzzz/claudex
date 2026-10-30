import type { AnyRecord, LLMProvider, ProviderRuntimeWriter } from '@/shared/types.js';

import type { DurableProvider } from './provider-supervisor.service.js';

// Runtime dispatcher reads the cached approval/background surface synchronously;
// controller recovery rebuilds it before accepting browser traffic.
export const supervisedRuntimeState = {
  draining: false,
  entries: new Map<string, { client?: DurableProvider; launching?: Promise<DurableProvider>; provider: LLMProvider; pending: AnyRecord[]; background: boolean;
    foregroundCompleted?: boolean; currentSpec?: AnyRecord;
    continuation?: { id: string; writer: ProviderRuntimeWriter; resolve: () => void; reject: (error: unknown) => void };
  }>(),
};
