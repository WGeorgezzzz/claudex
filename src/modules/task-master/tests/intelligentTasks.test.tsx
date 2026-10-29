import {render,screen,fireEvent,waitFor,cleanup,within} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {IntelligentTasksPanel} from '@/modules/task-master/IntelligentTasksPanel';
const mocks=vi.hoisted(()=>({correct:vi.fn(),execute:vi.fn(),action:vi.fn(),snapshot:vi.fn()}));
const base={summary:'完成验收',project:'Nexagent',kind:'todo',due:null,people:[],next_action:'检查结果',urgency:1,groupId:'g',parent:{key:'p',title:'整合发布',goal:'完成前后端验收'}};
function snapshot(){return {groups:[{id:'g',name:'整合上线',summary:'整合发布与验收',project:'Nexagent'}],entries:{a:{...base},b:{...base},duplicate:{...base,mergedInto:'a'},maybe:{...base,parent:undefined,completion:{status:'done',confidence:.7,evidence:[{type:'file',path:'D:/evidence/STATUS.md',excerpt:'已完成局部核查'}]}}},tasks:[{id:'a',root:'D:/fixture',projectId:'project',project:'Nexagent',task:{id:1,title:'前端验收',status:'pending',sources:[{link:'source-a'}]}},{id:'b',root:'D:/fixture',projectId:'project',project:'Nexagent',task:{id:2,title:'后端验收',status:'done',sources:[{link:'source-b'}]}},{id:'duplicate',root:'D:/fixture',projectId:'project',project:'Nexagent',task:{id:3,title:'重复的前端验收',status:'pending'}},{id:'maybe',root:'D:/fixture',projectId:'project',project:'Nexagent',task:{id:4,title:'核对完整验收',status:'pending'}}],focus:[],audits:[],budget:1,spent:.01,running:false,updatedAt:'2026-10-28T00:00:00Z'};}
vi.mock('@/modules/task-master/TaskSourcesBar',()=>({TaskSourcesBar:()=> <div aria-label="来源状态"/>}));
vi.mock('@/shared/api',()=>({api:{readFile:async()=>new Response(JSON.stringify({content:'原始报告正文'}))},inboxTasksApi:{intelligence:async()=>new Response(JSON.stringify(mocks.snapshot()||snapshot())),action:async(...args:unknown[])=>{mocks.action(...args);return new Response(JSON.stringify({message:'此任务正在执行，请稍后再试'}),{status:409});},correctIntelligence:async(input:unknown)=>{mocks.correct(input);return new Response('{}');},executeIntelligence:async(...args:unknown[])=>{mocks.execute(...args);return new Response(JSON.stringify({sessionId:'executed'}));}}}));
vi.mock('@/modules/task-master/TaskExecutionPanel',()=>({prefetchTaskExecutionModels:()=>{},TaskExecutionPanel:({onConfirm,title,cwd}:{title:string;cwd:string;onConfirm:(settings:unknown)=>void})=><><p data-testid="execution-title">{title}</p><p data-testid="execution-cwd">{cwd}</p><button onClick={()=>onConfirm({provider:'codex',permissionMode:'bypassPermissions'})}>确认父任务执行</button></>}));
beforeEach(()=>{localStorage.clear();mocks.snapshot.mockReset();mocks.action.mockClear();});
afterEach(()=>{cleanup();mocks.correct.mockClear();mocks.execute.mockClear();});
function mount(){render(<MemoryRouter><IntelligentTasksPanel onReady={()=>{}}/></MemoryRouter>);}
test('parent progress and execution include both children and their source context',async()=>{mount();await screen.findByText('前端验收');expect(screen.getByText('整合发布 · 1/2')).toBeTruthy();fireEvent.click(screen.getByRole('tab',{name:/全部/}));await screen.findByText('后端验收');expect(screen.getByText('整合发布 · 1/2')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'执行父任务'}));fireEvent.click(screen.getByRole('button',{name:'确认父任务执行'}));await waitFor(()=>expect(mocks.execute).toHaveBeenCalled());expect(mocks.execute.mock.calls[0][0]).toEqual({id:'a',parent:true,userInput:undefined,settings:{provider:'codex',permissionMode:'bypassPermissions'}});});
test('automatic merges have a correction that records the exact pair',async()=>{mount();await screen.findByText('前端验收');fireEvent.click(screen.getByRole('button',{name:'详情 前端验收'}));await screen.findByRole('dialog',{name:'任务详情'});fireEvent.click(screen.getByRole('button',{name:'撤销合并'}));await waitFor(()=>expect(mocks.correct).toHaveBeenCalledWith({action:'separate',id:'duplicate',target:'a'}));});
test('uncertain completion stays pending and supports user denial',async()=>{mount();await screen.findByText(/可能已完成/);fireEvent.click(screen.getByRole('button',{name:'否认'}));await waitFor(()=>expect(mocks.correct).toHaveBeenCalledWith({action:'deny-completion',id:'maybe'}));});


test('semantic search filters existing cards without changing their grouping',async()=>{mount();await screen.findByText('前端验收');fireEvent.change(screen.getByRole('textbox',{name:'搜索智能任务'}),{target:{value:'核对完整'}});await screen.findByText('核对完整验收');expect(screen.queryByText('前端验收')).toBeNull();});
test('project scope from the unified task entry also applies to semantic cards',async()=>{render(<MemoryRouter><IntelligentTasksPanel projectId="another-project" onReady={()=>{}}/></MemoryRouter>);await screen.findByRole('textbox',{name:'搜索智能任务'});expect(screen.queryByText('前端验收')).toBeNull();expect(screen.queryByText('核对完整验收')).toBeNull();});

test('child execution uses the child title; only parent execution includes the child count',async()=>{mount();await screen.findByText('前端验收');fireEvent.click(screen.getAllByRole('button',{name:'执行'})[0]);expect(screen.getByTestId('execution-title').textContent).toBe('前端验收');cleanup();mount();await screen.findByText('前端验收');fireEvent.click(screen.getByRole('button',{name:'执行父任务'}));expect(screen.getByTestId('execution-title').textContent).toBe('整合发布（含 2 个子任务）');});

test('a task conflict stays on that row and does not lock other tasks',async()=>{mount();await screen.findByText('前端验收');const row=screen.getByRole('button',{name:'详情 前端验收'});fireEvent.click(within(row).getByRole('button',{name:'标记完成 前端验收'}));await within(row).findByRole('alert');expect(within(screen.getByRole('button',{name:'详情 核对完整验收'})).getByRole('button',{name:'执行'}).hasAttribute('disabled')).toBe(false);});

function groupedSnapshot(){
 const value=snapshot();
 return {...value,groups:[...value.groups,{id:'quiet',name:'资料归档',summary:'知会事项',project:'Nexagent'},{id:'running',name:'执行队列',summary:'后台任务',project:'Nexagent'}],
  entries:{...value.entries,quiet:{...base,kind:'fyi',groupId:'quiet',parent:undefined},running:{...base,kind:'waiting',groupId:'running',parent:undefined}},
  tasks:[...value.tasks,{id:'quiet',root:'D:/fixture',projectId:'project',project:'Nexagent',task:{id:5,title:'安静的知会任务',status:'pending'}},{id:'running',root:'D:/fixture',projectId:'project',project:'Nexagent',task:{id:6,title:'后台正在执行',status:'in-progress'}}]};
}

test('only attention and running groups expand by default, with current filtered counts',async()=>{
 mocks.snapshot.mockReturnValue(groupedSnapshot());mount();await screen.findByText('前端验收');
 fireEvent.click(screen.getByRole('tab',{name:/全部/}));
 expect(screen.getByRole('button',{name:/Nexagent \/ 整合上线 3 项任务 需要我 2/}).getAttribute('aria-expanded')).toBe('true');
 expect(screen.getByRole('button',{name:/Nexagent \/ 资料归档/}).getAttribute('aria-expanded')).toBe('false');
 expect(screen.queryByText('安静的知会任务')).toBeNull();
 expect(screen.getByText('后台正在执行')).toBeTruthy();
 expect(screen.getByRole('progressbar',{name:'完整父任务进度'}).getAttribute('aria-valuenow')).toBe('1');
 expect(document.querySelector('details[data-parent-task]')).toBeNull();
});

test('explicit group choices survive remount and stay independent between views',async()=>{
 mount();await screen.findByText('前端验收');fireEvent.click(screen.getByRole('button',{name:/Nexagent \/ 整合上线/}));
 expect(screen.queryByText('前端验收')).toBeNull();cleanup();mount();
 await screen.findByRole('button',{name:/Nexagent \/ 整合上线/});expect(screen.queryByText('前端验收')).toBeNull();
 fireEvent.click(screen.getByRole('tab',{name:/全部/}));expect(screen.getByText('前端验收')).toBeTruthy();
 fireEvent.click(screen.getByRole('tab',{name:/需要我/}));expect(screen.queryByText('前端验收')).toBeNull();
 fireEvent.change(screen.getByRole('combobox',{name:'智能任务视图'}),{target:{value:'kind'}});expect(screen.getByText('前端验收')).toBeTruthy();
});

test('bulk controls update all currently displayed groups and search preserves the choice',async()=>{
 mocks.snapshot.mockReturnValue(groupedSnapshot());mount();await screen.findByText('前端验收');fireEvent.click(screen.getByRole('tab',{name:/全部/}));
 fireEvent.click(screen.getByRole('button',{name:'全部展开'}));expect(screen.getByText('安静的知会任务')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'全部折叠'}));expect(screen.queryAllByTestId('compact-task-row')).toHaveLength(0);
 fireEvent.change(screen.getByRole('textbox',{name:'搜索智能任务'}),{target:{value:'前端'}});expect(screen.queryAllByTestId('compact-task-row')).toHaveLength(0);
 fireEvent.click(screen.getByRole('button',{name:'全部展开'}));expect(screen.getByText('前端验收')).toBeTruthy();
});

test('j/k move through visible tasks and x uses the focused task completion action',async()=>{
 mount();await screen.findByText('前端验收');fireEvent.keyDown(document.body,{key:'j'});
 expect(document.activeElement?.getAttribute('aria-label')).toBe('详情 前端验收');
 fireEvent.keyDown(document.activeElement!,{key:'j'});expect(document.activeElement?.getAttribute('aria-label')).toBe('详情 核对完整验收');
 fireEvent.keyDown(document.activeElement!,{key:'k'});fireEvent.keyDown(document.activeElement!,{key:'x'});
 await waitFor(()=>expect(mocks.action).toHaveBeenCalledWith('project','1','done'));
});

test('shortcuts do not mutate from inputs, dialogs or a task menu',async()=>{
 mount();await screen.findByText('前端验收');
 const input=screen.getByRole('textbox',{name:'搜索智能任务'});input.focus();fireEvent.keyDown(input,{key:'x'});fireEvent.keyDown(input,{key:'j'});expect(document.activeElement).toBe(input);
 fireEvent.click(screen.getByRole('button',{name:'更多 前端验收'}));fireEvent.keyDown(document.body,{key:'x'});expect(mocks.action).not.toHaveBeenCalled();
 fireEvent.keyDown(window,{key:'Escape'});fireEvent.click(screen.getByRole('button',{name:'详情 前端验收'}));fireEvent.keyDown(document.body,{key:'x'});expect(mocks.action).not.toHaveBeenCalled();
});

test('source links expose sessions, original messages and authenticated file evidence',async()=>{
 const value=snapshot();mocks.snapshot.mockReturnValue({...value,tasks:value.tasks.map(row=>row.id==='a'?{...row,task:{...row.task,source:'infohub',sourceId:42,sources:[{sessionId:'source-session',messageId:'m 1'}]}}:row)});
 mount();await screen.findByText('前端验收');
 const row=screen.getByRole('button',{name:'详情 前端验收'});
 expect(within(row).getByRole('link',{name:'信息看板'}).getAttribute('href')).toBe('/infohub?unit=42');
 expect(within(row).getByRole('link',{name:'源会话'}).getAttribute('href')).toBe('/session/source-session?message=m%201');
 fireEvent.click(screen.getByRole('button',{name:'原文件'}));
 await screen.findByText('原始报告正文');expect(screen.getByRole('dialog',{name:'任务详情'})).toBeTruthy();
});

test('invalid saved preferences fall back to defaults and unusable source links stay inert',async()=>{
 localStorage.setItem('task-group-preferences-v1','{"bad":null,"array":[],"view":{"group":"false"}}');
 const value=snapshot();mocks.snapshot.mockReturnValue({...value,tasks:value.tasks.map(row=>({...row,task:{...row.task,evidenceLink:'javascript:alert(1)',sources:[]}}))});
 mount();await screen.findByText('前端验收');expect(screen.queryByRole('link',{name:'原始来源'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'全部折叠'}));expect(screen.queryAllByTestId('compact-task-row')).toHaveLength(0);
});

test('infohub message evidence appears in compact rows and all original messages remain in the drawer',async()=>{
 const value=snapshot();mocks.snapshot.mockReturnValue({...value,tasks:value.tasks.map(row=>row.id==='a'?{...row,task:{...row.task,source:'infohub',sourceId:'42',evidenceLink:'/infohub?unit=42',infohubEvidence:[
  {unitId:42,link:'/infohub?unit=42'},
  {messageId:11,source:'lark',channel:'项目群',link:'https://applink.feishu.cn/client/chat/open?messageId=11',evidence:'飞书原消息正文'},
  {messageId:12,source:'wechat',channel:'交付群',link:'https://example.org/message/12',evidence:'微信原消息正文'},
  {messageId:13,source:'lark',link:'javascript:alert(1)'},
  {messageId:14,source:'lark',link:'/infohub?unit=42'},
 ]}}:row)});
 mount();await screen.findByText('前端验收');const row=screen.getByRole('button',{name:'详情 前端验收'});
 expect(within(row).getByRole('link',{name:'信息看板'}).getAttribute('href')).toBe('/infohub?unit=42');
 expect(within(row).getByRole('link',{name:'原消息 · 项目群'}).getAttribute('href')).toBe('https://applink.feishu.cn/client/chat/open?messageId=11');
 fireEvent.click(row);const drawer=await screen.findByRole('dialog',{name:'任务详情'});
 expect(within(drawer).getByRole('link',{name:/原消息 · 交付群/}).getAttribute('href')).toBe('https://example.org/message/12');
 expect(within(drawer).getByText('飞书原消息正文')).toBeTruthy();expect(within(drawer).getByText('微信原消息正文')).toBeTruthy();
 expect(within(drawer).getAllByRole('link')).toHaveLength(3);
});
