import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { api } from '@/shared/api';
import { SessionMonitorBadge } from '@/shared/ui/SessionMonitorBadge';
import { refreshMonitorSummaries } from '@/shared/hooks/useMonitorSummaries';
import type { SessionMonitorSummary } from '@/shared/types';

vi.mock('@/shared/api',()=>({api:{monitors:{summaries:vi.fn(),action:vi.fn()}},readApiErrorMessage:()=> 'Forbidden'}));
let row:SessionMonitorSummary;
const response=(data:unknown,status=200)=>new Response(JSON.stringify({data}),{status});
beforeEach(()=>{
  vi.clearAllMocks();
  row={id:'m',session_id:'s',name:'Daily check',status:'active',interval_minutes:30,schedule_json:JSON.stringify({frequency:'daily',time:'09:00',timeZone:'America/New_York'}),next_run_at:'2026-10-28T13:00:00Z',running_id:null,last_error:null,consecutive_failures:0,last_result:'succeeded'};
  vi.mocked(api.monitors.summaries).mockImplementation(async()=>response({s:[row]}));
  vi.mocked(api.monitors.action).mockImplementation(async(_id,action)=>{row={...row,status:action==='pause'?'paused':'active'};return response(row);});
});
test('many rows use one batch, opening details keeps navigation still, lifecycle changes refresh every badge',async()=>{
  const navigate=vi.fn();render(<div onClick={navigate}>{Array.from({length:30},(_,i)=><SessionMonitorBadge key={i} sessionId="s"/>)}</div>);
  const badges=await screen.findAllByRole('button',{name:'监测：已启用'});
  expect(api.monitors.summaries).toHaveBeenCalledTimes(1);
  expect(badges[0].title).toContain('America/New_York');expect(badges[0].title).toContain(new Date(row.next_run_at).toLocaleString());
  fireEvent.click(badges[0]);expect(navigate).not.toHaveBeenCalled();expect(screen.getByRole('dialog',{name:'会话监测'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'暂停'}));
  await waitFor(()=>expect(screen.getAllByRole('button',{name:'监测：已暂停'})).toHaveLength(30));
  expect(api.monitors.action).toHaveBeenCalledWith('m','pause');
  fireEvent.click(screen.getByRole('button',{name:'恢复'}));
  await waitFor(()=>expect(screen.getAllByRole('button',{name:'监测：已启用'})).toHaveLength(30));
  row={...row,consecutive_failures:2,last_error:'Retry later',last_result:'failed'};await refreshMonitorSummaries();
  await screen.findAllByRole('button',{name:'监测：失败 / 退避中'});expect(screen.getByText('最近结果：Retry later')).toBeTruthy();
});
test('a failed lifecycle request remains visible and cannot optimistically change the status',async()=>{
  vi.mocked(api.monitors.action).mockResolvedValue(response({},403));render(<SessionMonitorBadge sessionId="s"/>);
  fireEvent.click(await screen.findByRole('button',{name:'监测：已启用'}));fireEvent.click(screen.getByRole('button',{name:'停止'}));
  expect((await screen.findByRole('alert')).textContent).toContain('Forbidden');expect(screen.getByRole('button',{name:'监测：已启用'})).toBeTruthy();
});
