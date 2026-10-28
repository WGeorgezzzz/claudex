import {render,screen,cleanup,waitFor} from '@testing-library/react';
import {afterEach,expect,test,vi} from 'vitest';
import {TaskExecutionPanel} from '@/modules/task-master/TaskExecutionPanel';
const response=(data:unknown)=>Promise.resolve(new Response(JSON.stringify({data})));
vi.mock('@/shared/api',()=>({inboxTasksApi:{executionSettings:()=>response({provider:'codex',model:'cached',permissionMode:'bypassPermissions'})},api:{providers:{discovery:()=>response({agents:[{id:'codex',enabled:true}]}),capabilities:()=>response({providers:[]}),models:(id:string)=>id==='gemini'?new Promise(()=>{}):response({models:{DEFAULT:'cached',OPTIONS:[{value:'cached',label:'Cached'}]}})}}}));
afterEach(()=>{cleanup();localStorage.clear();});
test('a Gemini request that never resolves cannot hide the form or block cached execution',async()=>{
 localStorage.setItem('task-execution-cache-v2',JSON.stringify({settings:{provider:'codex',model:'cached',permissionMode:'bypassPermissions',effort:'',cwd:'D:/embodied'}}));
 render(<TaskExecutionPanel title="Example" cwd="D:/embodied" open busy={false} onClose={()=>{}} onConfirm={async()=>{}}/>);
 expect(screen.getByLabelText('执行工作目录')).toBeTruthy();
 expect(screen.getByRole('button',{name:'确认执行并打开对话'}).hasAttribute('disabled')).toBe(false);
 await waitFor(()=>expect((screen.getByLabelText('执行权限模式') as HTMLSelectElement).value).toBe('bypassPermissions'));
 expect(screen.queryByText('正在读取 Harness 与模型…')).toBeNull();
});
