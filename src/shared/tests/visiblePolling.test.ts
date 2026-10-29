import { afterEach, expect, test, vi } from 'vitest';

import { startVisiblePolling } from '@/shared/utils';

afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

test('hidden pages release polling timers and refresh once when visible again',async()=>{
  vi.useFakeTimers();
  const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
  const refresh=vi.fn().mockResolvedValue(undefined);
  const close=startVisiblePolling(refresh,15000);
  await vi.advanceTimersByTimeAsync(15000);
  expect(refresh).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue('hidden');document.dispatchEvent(new Event('visibilitychange'));
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60000);
  expect(refresh).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue('visible');document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledTimes(3);
  close();expect(vi.getTimerCount()).toBe(0);
});
