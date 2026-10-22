import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { api } from '@/shared/api';
import { MonitorDashboard } from '@/modules/sidebar/MonitorDashboard';

const task={id:'m1',session_id:'s1',name:'进度巡检',content:'查看日志',interval_minutes:30,status:'active',next_run_at:new Date().toISOString(),running_id:null,run_count:2,last_error:null,options:'{"permissionMode":"bypassPermissions"}'};
const response=(data:unknown)=>({ok:true,json:async()=>({data})}) as Response;
afterEach(()=>{cleanup();vi.restoreAllMocks();});
test('visible entry counts all enabled tasks and edits the selected one',async()=>{
  vi.spyOn(api.monitors,'list').mockResolvedValue(response([task]));
  const update=vi.spyOn(api.monitors,'update').mockResolvedValue(response({...task,interval_minutes:60}));
  render(<MonitorDashboard/>);
  fireEvent.click(await screen.findByRole('button',{name:'自动监测，1 个已启用'}));
  assert.ok(screen.getByText('Bypass · 全部允许'));
  fireEvent.click(screen.getByRole('button',{name:'调整'}));
  fireEvent.change(screen.getByLabelText('任务间隔分钟'),{target:{value:'60'}});
  fireEvent.click(screen.getByRole('button',{name:'保存调整'}));
  await waitFor(()=>assert.equal(update.mock.calls.length,1));
  assert.deepEqual(update.mock.calls[0],['m1',{name:'进度巡检',content:'查看日志',intervalMinutes:60}]);
});
test('pause and history target the selected task without switching its chat',async()=>{
  vi.spyOn(api.monitors,'list').mockResolvedValue(response([task]));
  const action=vi.spyOn(api.monitors,'action').mockResolvedValue(response({...task,status:'paused'}));
  const runs=vi.spyOn(api.monitors,'runs').mockResolvedValue(response([]));
  render(<MonitorDashboard/>);fireEvent.click(await screen.findByRole('button',{name:'自动监测，1 个已启用'}));
  fireEvent.click(screen.getByRole('button',{name:'暂停'}));await waitFor(()=>assert.equal(action.mock.calls.length,1));
  await waitFor(()=>assert.equal(screen.getByRole('button',{name:'运行记录'}).hasAttribute('disabled'),false));
  fireEvent.click(screen.getByRole('button',{name:'运行记录'}));await waitFor(()=>assert.equal(runs.mock.calls.length,1));
  assert.deepEqual(action.mock.calls[0],['m1','pause']);assert.deepEqual(runs.mock.calls[0],['m1']);
});

test('daily rule stays intact while editing a name and the displayed permission is truthful',async()=>{
  const schedule={frequency:'daily',time:'09:00',timeZone:'Asia/Shanghai'};
  vi.spyOn(api.monitors,'list').mockResolvedValue(response([{...task,schedule_json:JSON.stringify(schedule),options:'{"permissionMode":"default"}'}]));
  vi.spyOn(api.monitors,'capabilities').mockResolvedValue(response({calendar:true,scheduleVersion:1}));
  const update=vi.spyOn(api.monitors,'update').mockResolvedValue(response(task));
  render(<MonitorDashboard/>);fireEvent.click(await screen.findByRole('button',{name:'自动监测，1 个已启用'}));
  assert.ok(screen.getByText('Default · 按需审批'));assert.equal(screen.queryByText('Bypass · 全部允许'),null);
  fireEvent.click(screen.getByRole('button',{name:'调整'}));
  await waitFor(()=>assert.equal((screen.getByRole('option',{name:'每天'}) as HTMLOptionElement).disabled,false));
  fireEvent.change(screen.getByLabelText('任务名称'),{target:{value:'Daily renamed'}});
  fireEvent.click(screen.getByRole('button',{name:'保存调整'}));
  await waitFor(()=>assert.equal(update.mock.calls.length,1));
  assert.deepEqual(update.mock.calls[0][1].schedule,schedule);
});
