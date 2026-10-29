import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';

import { TasksNavigation } from '@/modules/task-master/GlobalTasksPage';

const calls=vi.hoisted(()=>({legacy:vi.fn(),semantic:vi.fn()}));
vi.mock('@/shared/api',()=>({inboxTasksApi:{list:()=>calls.legacy(),intelligence:()=>calls.semantic()},api:{providers:{}}}));
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();});

test('a usable semantic count stops the duplicate legacy feed while keeping task counts current',async()=>{
  vi.useFakeTimers();vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
  calls.legacy.mockResolvedValue({ok:true,json:async()=>({projects:[]})});
  calls.semantic.mockResolvedValue({ok:true,json:async()=>({tasks:[{id:'one',task:{status:'pending',forMe:true}}],entries:{}})});
  await act(async()=>{render(<MemoryRouter><TasksNavigation/></MemoryRouter>);});
  expect(screen.getByRole('button',{name:'任务，需要你处理 1 · 未完成 1'})).toBeTruthy();
  const legacyReads=calls.legacy.mock.calls.length;
  await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});
  expect(calls.legacy.mock.calls.length).toBe(legacyReads);
  expect(calls.semantic.mock.calls.length).toBeGreaterThan(1);
});
