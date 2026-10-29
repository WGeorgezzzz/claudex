import { render,screen,fireEvent,waitFor,cleanup } from '@testing-library/react';
import { afterEach,expect,test,vi } from 'vitest';
import { TaskSourcesBar } from '@/modules/task-master/TaskSourcesBar';
const mock=vi.hoisted(()=>({start:vi.fn(),settings:vi.fn(),sources:vi.fn()}));
vi.mock('@/shared/api',()=>({inboxTasksApi:{sources:mock.sources,startInfohub:mock.start,saveInfohubSettings:mock.settings}}));
function snapshot(phase='stopped'){return {sources:[{id:'infohub',name:'信息看板',status:phase==='idle'?'online':'stopped',count:22,taskCount:22,lastSyncedAt:'2026-10-29T12:00:00Z',error:null},{id:'lark',name:'飞书',status:'error',count:10,taskCount:2,lastSyncedAt:null,error:'token_missing: need_user_authorization',note:'请在信息看板完成飞书用户授权'}],infohub:{phase,running:phase==='idle',online:phase==='idle',error:null,idleMinutes:10,idleDeadline:null,progress:{completed:phase==='idle'?3:0,total:3}}};}
afterEach(()=>{cleanup();vi.resetAllMocks();});
test('shows real observations, expands actionable failure and only starts on click',async()=>{
  mock.sources.mockImplementation(async()=>new Response(JSON.stringify(snapshot())));
  mock.start.mockImplementation(async()=>new Response('{}'));
  render(<TaskSourcesBar onSynced={()=>{}}/>);
  await screen.findByRole('button',{name:'飞书来源状态'});
  expect(mock.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'飞书来源状态'}));
  expect(screen.getByText('token_missing: need_user_authorization')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'启动并同步'}));
  await waitFor(()=>expect(mock.start).toHaveBeenCalledTimes(1));
});
test('refreshes task rows when sync completes and reports transport errors',async()=>{
  mock.sources.mockImplementation(async()=>new Response(JSON.stringify(snapshot('idle'))));
  mock.start.mockImplementation(async()=>new Response(JSON.stringify({message:'Python 环境不存在'}),{status:500}));
  const ready=vi.fn();render(<TaskSourcesBar onSynced={ready}/>);
  await waitFor(()=>expect(ready).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button',{name:'启动并同步'}));
  await screen.findByText('Python 环境不存在');expect(ready).toHaveBeenCalledTimes(1);
});
test('organizer settings expose the idle timeout without starting collection',async()=>{
  mock.sources.mockImplementation(async()=>new Response(JSON.stringify(snapshot())));
  mock.settings.mockImplementation(async()=>new Response('{}'));
  render(<TaskSourcesBar onSynced={()=>{}} showSettings/>);
  const input=await screen.findByRole('spinbutton',{name:'信息看板空闲退出分钟'});
  fireEvent.change(input,{target:{value:'15'}});fireEvent.blur(input);
  await waitFor(()=>expect(mock.settings).toHaveBeenCalledWith(15));expect(mock.start).not.toHaveBeenCalled();
});
