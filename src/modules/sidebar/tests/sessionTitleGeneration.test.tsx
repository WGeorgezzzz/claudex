import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { api } from '@/shared/api';
import { useSessionTitleGeneration } from '@/modules/sidebar/hooks/useSessionTitleGeneration';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, options: {defaultValue: string}) => options.defaultValue }) }));
vi.mock('@/shared/api', () => ({ api: { regenerateSessionTitle: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('alert', vi.fn()); });

test('manual title action stays pending until the server confirms ready', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(api.regenerateSessionTitle).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(() => useSessionTitleGeneration('old-session'));
  act(() => { void result.current.regenerateTitle(); });
  expect(result.current.generatingTitle).toBe(true);
  expect(api.regenerateSessionTitle).toHaveBeenCalledWith('old-session');
  await act(async () => { finish({ ok: true, json: async () => ({ data: { status: 'ready', title: 'Generated title' } }) } as Response); });
  await waitFor(() => expect(result.current.generatingTitle).toBe(false));
  expect(alert).not.toHaveBeenCalled();
});

test('manual action surfaces failed or stale generation and becomes usable again', async () => {
  vi.mocked(api.regenerateSessionTitle).mockResolvedValue({ ok: true, json: async () => ({ data: { status: 'stale' } }) } as Response);
  const { result } = renderHook(() => useSessionTitleGeneration('old-session'));
  await act(async () => { await result.current.regenerateTitle(); });
  expect(alert).toHaveBeenCalledOnce();
  expect(result.current.generatingTitle).toBe(false);
});
