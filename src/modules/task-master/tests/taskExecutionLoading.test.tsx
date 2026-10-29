import {render,screen,cleanup,waitFor,fireEvent,act} from '@testing-library/react';
import {afterEach,expect,test,vi} from 'vitest';
import {TaskExecutionPanel} from '@/modules/task-master/TaskExecutionPanel';
const control=vi.hoisted(()=>({settings:undefined as undefined|(()=>Promise<Response>)}));
const response=(data:unknown)=>Promise.resolve(new Response(JSON.stringify({data})));
vi.mock('@/shared/api',()=>({inboxTasksApi:{executionSettings:()=>control.settings?control.settings():response({provider:'codex',model:'cached',permissionMode:'bypassPermissions'})},api:{providers:{discovery:()=>response({agents:[{id:'codex',enabled:true}]}),capabilities:()=>response({providers:[]}),models:(id:string)=>id==='gemini'?new Promise(()=>{}):response({models:{DEFAULT:id==='deepseek-harness'?'native-model':'cached',OPTIONS:[{value:id==='deepseek-harness'?'native-model':'cached',label:id==='deepseek-harness'?'Native':'Cached'}]}})}}}));
afterEach(()=>{cleanup();localStorage.clear();control.settings=undefined;});
test('a Gemini request that never resolves cannot hide the form or block cached execution',async()=>{
 localStorage.setItem('task-execution-cache-v2',JSON.stringify({settings:{provider:'codex',model:'cached',permissionMode:'bypassPermissions',effort:'',cwd:'D:/embodied'}}));
 render(<TaskExecutionPanel title="Example" cwd="D:/embodied" open busy={false} onClose={()=>{}} onConfirm={async()=>{}}/>);
 expect(screen.getByLabelText('执行工作目录')).toBeTruthy();
 expect(screen.getByRole('button',{name:'确认执行并打开对话'}).hasAttribute('disabled')).toBe(false);
 await waitFor(()=>expect((screen.getByLabelText('执行权限模式') as HTMLSelectElement).value).toBe('bypassPermissions'));
 expect(screen.queryByText('正在读取 Harness 与模型…')).toBeNull();
});


test('late stored settings cannot override a harness or directory the user selected',async()=>{
 let settle!:(response:Response)=>void;control.settings=()=>new Promise<Response>(resolve=>{settle=resolve;});const confirm=vi.fn(async()=>{});
 render(<TaskExecutionPanel title="Race" cwd="D:/embodied" open busy={false} onClose={()=>{}} onConfirm={confirm}/>);
 fireEvent.click(screen.getByRole('button',{name:/^DeepSeek Harness/}));await waitFor(()=>expect((screen.getByLabelText('执行模型') as HTMLSelectElement).value).toBe('native-model'));
 fireEvent.change(screen.getByLabelText('执行工作目录'),{target:{value:'D:/owned'}});
 await act(async()=>{settle(new Response(JSON.stringify({data:{provider:'claude',model:'cached',cwd:'D:/stale',permissionMode:'default'}})));await Promise.resolve();});
 expect(screen.getByRole('button',{name:/^DeepSeek Harness/}).getAttribute('aria-pressed')).toBe('true');expect((screen.getByLabelText('执行工作目录') as HTMLInputElement).value).toBe('D:/owned');
 fireEvent.click(screen.getByRole('button',{name:'确认执行并打开对话'}));await waitFor(()=>expect(confirm).toHaveBeenCalledWith(expect.objectContaining({provider:'deepseek-harness',model:'native-model',cwd:'D:/owned'})));
});

test('cached and server preferences never replace the task directory with an old fixture',async()=>{
 localStorage.setItem('task-execution-cache-v2',JSON.stringify({settings:{provider:'codex',model:'cached',cwd:'D:/embodied/nexagent-integrate2-20261028/production-project'}}));
 control.settings=()=>response({provider:'codex',model:'cached',cwd:'D:/embodied/copy-project'});
 render(<TaskExecutionPanel title="Real task" cwd="D:/embodied" open busy={false} onClose={()=>{}} onConfirm={async()=>{}}/>);
 expect((screen.getByLabelText('执行工作目录') as HTMLInputElement).value).toBe('D:/embodied');
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
 expect((screen.getByLabelText('执行工作目录') as HTMLInputElement).value).toBe('D:/embodied');
});

test('server preference metadata is never sent back as an execution setting',async()=>{
 control.settings=()=>response({provider:'codex',model:'cached',cwd:'D:/old-fixture',permissionMode:'bypassPermissions',permissionModeExplicit:true});const confirm=vi.fn(async(_settings:unknown)=>{});
 render(<TaskExecutionPanel title="Strict route" cwd="D:/embodied" open busy={false} onClose={()=>{}} onConfirm={confirm}/>);
 await waitFor(()=>expect((screen.getByLabelText('执行模型') as HTMLSelectElement).value).toBe('cached'));
 fireEvent.click(screen.getByRole('button',{name:'确认执行并打开对话'}));
 await waitFor(()=>expect(confirm).toHaveBeenCalled());expect(confirm.mock.calls[0][0]).not.toHaveProperty('permissionModeExplicit');
});
