import { IntelligentTasksPanel } from '@/modules/task-master/IntelligentTasksPanel';
import { TaskExecutionPanel,prefetchTaskExecutionModels } from '@/modules/task-master/TaskExecutionPanel';
import type { LLMProvider } from '@/shared/types';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, Check, ChevronDown, ExternalLink, ListTodo, Menu, Play, RefreshCw, RotateCcw, Search, X } from 'lucide-react';

import { startVisiblePolling } from '@/shared/utils';
import { inboxTasksApi } from '@/shared/api';
import { LLMProviderLogo } from '@/shared/ui';


type Task = { evidenceLink?:string;forMe?:boolean;sourceId?:string;executionProvider?:string;executionStatus?:string; id: string | number; title: string; description?: string; details?: string; source?: string; due?: string; status: string; priority?: string; recommended?: string; options?: { key: string; label: string; plan: string }[]; executionSessionId?: string; userInput?: string; tags?: string[]; parentIds?:string[]; mergedInto?:string|number; sources?:{sessionId?:string;messageId?:string;evidence?:string}[];originEvidence?:unknown[] };
type Topic = {id:string;title:string;parentIds:string[]};
type ProjectTasks = { root?:string;projectId: string; name: string; tasks: Task[]; topics?:Topic[]; error?: string; audits: { id: string; at: string; undone?: boolean; changes: { id: string | number; title: string; status: string }[] }[] };
const labels: Record<string, string> = { pending: '待处理', 'in-progress': '进行中', done: '已完成', cancelled: '已忽略', blocked: '受阻', deferred: '暂缓', review: '待验收', high: '高优先级', medium: '普通', low: '低优先级' };
const statusStyles: Record<string, string> = {
  'in-progress': 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300',
  done: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  blocked: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300',
  review: 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
};
const control = 'min-h-10 rounded-lg border border-border bg-background px-3 text-sm disabled:opacity-50';
const isOpenTask = (task: Task) => !['done', 'cancelled'].includes(task.status);

async function read(response: Response) {
  const value = await response.json();
  if (!response.ok) throw new Error(value.message || value.error || '任务请求失败');
  return value;
}
function dueTime(due?: string) {
  const date = due?.match(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?/)?.[0];
  return date ? Date.parse(date) || Infinity : Infinity;
}
function useGlobalTasks(enabled = true) {
  // Keeps the latest server snapshot for polling and explicit changes.
  const [projects, setProjects] = useState<ProjectTasks[]>([]);
  const [infohub,setInfohub]=useState<{online:boolean;lastSyncedAt?:string;error?:string|null}|null>(null);
  // Initial loading must not look like an empty task collection.
  const [loading, setLoading] = useState(true);
  // Network errors stay visible until the next successful refresh.
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { const value = await read(await inboxTasksApi.list()); setProjects(previous=>JSON.stringify(previous)===JSON.stringify(value.projects)?previous:value.projects);setInfohub(previous=>JSON.stringify(previous)===JSON.stringify(value.infohub||null)?previous:value.infohub||null); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => enabled ? startVisiblePolling(load,15000) : undefined,[enabled,load]);
  return { projects, error, loading, load, setError,infohub };
}

/** SidebarHeader uses the same global task collection to navigate and display open/high counts. */
export function TasksNavigation() {
  // The sidebar uses the same default visibility and attention predicate as the unified task page.
  const [counts,setCounts]=useState<{attention:number;open:number}|null>(null);
  // The intelligence snapshot already includes the global task collection.
  // Retain the legacy feed only as a fallback until that endpoint succeeds.
  const navigate = useNavigate(), { projects, error, loading } = useGlobalTasks(counts === null);
  const tasks = projects.flatMap(p => p.tasks).filter(isOpenTask);
  useEffect(()=>{if(!inboxTasksApi.intelligence)return;let active=true;const load=async()=>{try{const snapshot=await read(await inboxTasksApi.intelligence());const rows=snapshot.tasks.filter((r:any)=>!r.testSource&&!snapshot.entries[r.id]?.mergedInto&&!['done','cancelled'].includes(r.task.status));if(active){const next={open:rows.length,attention:rows.filter((r:any)=>['blocked','review'].includes(r.task.status)||r.task.forMe||snapshot.entries[r.id]?.kind==='todo').length};setCounts(previous=>previous?.open===next.open&&previous?.attention===next.attention?previous:next);}}catch{/* Keep the last count when offline. */}};const stop=startVisiblePolling(load,30000);return()=>{active=false;stop();};},[]);
  const high = counts?.attention??tasks.filter(t => ['blocked','review'].includes(t.status)||t.forMe).length;
  const openCount=counts?.open??tasks.length;
  return <button type="button" className="sidebar-nav-action" onClick={() => navigate('/tasks')} title={`需要你处理 ${high} · 未完成 ${openCount}`} aria-label={`任务，需要你处理 ${high} · 未完成 ${openCount}`}>
    <ListTodo size={16}/><span>任务</span><span className="ml-auto text-xs text-muted-foreground">{error && !counts ? '连接异常' : loading && !counts ? '…' : high}</span>

  </button>;
}

/** SidebarHeader places the authenticated info-hub beside the unified task entry. */
export function InfoHubNavigation() {
  const navigate = useNavigate();
  return <button type="button" className="sidebar-nav-action" onClick={() => navigate('/information')} aria-label="信息看板"><ListTodo size={16}/><span>信息看板</span></button>;
}

/** ProjectMainRegion shows broad workstreams first and expands the original task records on demand. */
export function GlobalTasksPage({ onMenuClick }: { onMenuClick: () => void }) {
  const { projects, error, loading, load, setError,infohub } = useGlobalTasks(), navigate = useNavigate();
  const [searchParams] = useSearchParams();
  useEffect(()=>{prefetchTaskExecutionModels();},[]);
  // Project scope stays stable while polling updates the collection.
  const [projectId, setProjectId] = useState(searchParams.get('project') || '');
  // Priority filtering is independent of task status.
  const [priority, setPriority] = useState('');
  // Open work is the default; completed and ignored tasks stay accessible.
  const [status, setStatus] = useState(searchParams.get('task')?'all':'open');
  // A category selection gives one workstream the full page without changing ownership.
  const [category, setCategory] = useState('');
  // Search includes details and source so collapsed items stay discoverable.
  const [search, setSearch] = useState('');
  // Overview groups show three tasks; explicit expansion reveals all remaining tasks.
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  // Disables mutation controls for the duration of one server request.
  const [busy, setBusy] = useState(false);
  // Audit receipts support immediate undo without changing provenance.
  const [receipt, setReceipt] = useState<{ projectId: string; auditId: string } | null>(null);
  // The quick-create form creates a native inbox task in the selected project.
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState('medium');
  // Info-hub views are deterministic client filters over namespaced task tags.
  const [view, setView] = useState<'all' | 'today' | 'mine' | 'explore'>('all');
  // Semantic view is default once a persisted result exists; legacy remains an explicit fallback.
  const semantic=searchParams.get('view')!=='legacy';
  const [intelligenceReady,setIntelligenceReady]=useState(false);
  const [layout,setLayout]=useState<'tree'|'groups'|'list'|'board'>('tree');
  const [tags,setTags]=useState<string[]>([]);
  const [viewName,setViewName]=useState('');
  const [savedViews,setSavedViews]=useState<{name:string;tags:string[];projectId:string;view:typeof view}[]>([]);
  const [topicName,setTopicName]=useState('');
  useEffect(()=>{const id=searchParams.get('task');if(id&&projects.length){const timer=setTimeout(()=>document.querySelector('[data-task-id="'+CSS.escape(id)+'"]')?.scrollIntoView({block:'center'}),50);return()=>clearTimeout(timer);}},[projects,searchParams]);
  useEffect(()=>{void inboxTasksApi.views().then(read).then(v=>setSavedViews(Array.isArray(v)?v:[])).catch(()=>{});},[]);
  const act = async (run: () => Promise<Response>, targetProject: string) => {
    setBusy(true); setError('');
    try { const result = await read(await run()); if (result.auditId) setReceipt({ projectId: targetProject, auditId: result.auditId }); await load(); if (result.sessionId) navigate('/session/' + result.sessionId); return true; }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; } finally { setBusy(false); }
  };
  const all = projects.flatMap(project => project.tasks.filter(task=>task.mergedInto===undefined).map(task => ({ project, task, category: task.tags?.find(t=>t.startsWith('topic:'))||task.tags?.find(t=>t.startsWith('project:'))||'project:'+project.name })))
    .filter(row => !projectId || row.project.projectId === projectId);
  const sourceGroups=[...new Set(all.map(r=>r.category))].map(id=>({id,name:id.slice(id.indexOf(':')+1),description:'来源标签 / 项目',accent:'bg-blue-500'}));
  const totals = { open: all.filter(row => isOpenTask(row.task)).length, running: all.filter(row => row.task.status === 'in-progress').length,
    attention: all.filter(row => ['blocked', 'review'].includes(row.task.status)).length, done: all.filter(row => row.task.status === 'done').length };
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const keywords = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const today = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const filtered = all.filter(({ project, task }) => (!priority || task.priority === priority)
    && (view === 'all' || (view === 'mine' && (task.forMe||task.tags?.some(t=>t==='person:我'||t==='person:me') || /我该|需要我|@我/.test(task.title+' '+(task.details||'')))) || (view === 'today' && Boolean(task.due) && dueTime(task.due) <= today) || view === 'explore')
    && tags.every(tag=>task.tags?.includes(tag))
    && (status === 'all' || (status === 'open' ? isOpenTask(task) : status === 'attention' ? ['blocked', 'review'].includes(task.status) : task.status === status))
    && keywords.every(word => [task.title, task.description, task.details, task.source, project.name].filter(Boolean).join(' ').toLowerCase().includes(word)))
    .sort((a, b) => (rank[a.task.priority || 'medium'] ?? 1) - (rank[b.task.priority || 'medium'] ?? 1) || dueTime(a.task.due) - dueTime(b.task.due) || a.task.title.localeCompare(b.task.title));
  const tasks = filtered.filter(row => !category || row.category === category);
  const summary = [{ id: 'pending', label: '待处理', count: all.filter(row => row.task.status === 'pending').length, tone: 'text-slate-700 dark:text-slate-200' },
    { id: 'open', label: '未完成', count: totals.open, tone: 'text-foreground' },
    { id: 'in-progress', label: '进行中', count: totals.running, tone: 'text-blue-600 dark:text-blue-400' },
    { id: 'attention', label: '需关注', count: totals.attention, tone: 'text-amber-700 dark:text-amber-400' },
    { id: 'done', label: '已完成', count: totals.done, tone: 'text-emerald-700 dark:text-emerald-400' }];
  if(semantic)return <IntelligentTasksPanel onReady={setIntelligenceReady} onMenuClick={onMenuClick}/>;
  return <section className="flex h-full min-h-0 flex-col bg-slate-50/70 dark:bg-slate-950/40" aria-label="全局任务">
    <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-slate-200/80 bg-white/95 px-4 shadow-sm dark:border-slate-800 dark:bg-slate-950/95 md:px-7">
      <button type="button" title="打开侧栏" aria-label="打开侧栏" className="workspace-icon-button md:hidden" onClick={onMenuClick}><Menu size={18}/></button>
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-900 text-white dark:bg-white dark:text-slate-900"><ListTodo size={19}/></span><div><h1 className="text-xl font-bold tracking-tight">任务</h1><span className="text-xs text-slate-500 dark:text-slate-400">{semantic&&intelligenceReady?'按项目智能整理':'按来源主题整理'}</span></div>
      <button type="button" className={control+' ml-auto text-xs'} disabled={busy} onClick={()=>void act(()=>inboxTasksApi.syncInfohub(),projectId)}>同步信息看板</button><button type="button" aria-label="刷新任务" title="刷新任务" className="workspace-icon-button" onClick={() => void load()}><RefreshCw size={17}/></button>
    </header>
    <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-7xl space-y-5 p-4 md:p-7">
        <form className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:flex-row" onSubmit={async e => { e.preventDefault(); if (!newTitle.trim() || busy) return; const target = projectId || projects.find(p => p.tasks.length)?.projectId; if (!target) { setError('请先选择一个项目'); return; } setBusy(true); try { await read(await inboxTasksApi.create(target, { title: newTitle.trim(), priority: newPriority })); setNewTitle(''); await load(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }}>
          <input aria-label="新建任务" value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="输入任务，按 Enter 创建…" className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none transition focus:border-slate-400 focus:bg-white dark:border-slate-700 dark:bg-slate-950 dark:focus:bg-slate-900" />
          <select aria-label="新任务优先级" className={control} value={newPriority} onChange={e => setNewPriority(e.target.value)}><option value="high">高优先级</option><option value="medium">普通</option><option value="low">低优先级</option></select>
          <button type="submit" className="min-h-11 rounded-xl bg-slate-900 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-700 disabled:opacity-50 dark:bg-white dark:text-slate-900" disabled={!newTitle.trim() || busy}>新建任务</button>
        </form>
        {(!semantic||!intelligenceReady)&&<div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5" aria-label="任务概览">
          {summary.map(item => <button key={item.id} type="button" aria-pressed={status === item.id} onClick={() => setStatus(item.id)} className={`rounded-xl border bg-card px-4 py-3 text-left transition-colors hover:border-primary/40 ${status === item.id ? 'border-primary/50 ring-1 ring-primary/10' : 'border-border'}`}>
            <span className="text-xs font-medium text-muted-foreground">{item.label}</span><span className={`mt-1 block text-2xl font-semibold tabular-nums ${item.tone}`}>{loading ? '—' : item.count}</span>
          </button>)}
        </div>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-w-48 flex-1 items-center gap-2 rounded-lg border bg-background px-3"><Search size={16} className="shrink-0 text-muted-foreground"/><input aria-label="搜索任务" placeholder="搜索任务、来源或项目" value={search} onChange={e => setSearch(e.target.value)} className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none"/></label>
            <select aria-label="项目筛选" className={control + ' max-w-48'} value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">全部项目</option>{projects.filter(p => p.tasks.length || p.error).map(p => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}</select>
            <select aria-label="优先级筛选" className={control} value={priority} onChange={e => setPriority(e.target.value)}><option value="">全部优先级</option>{['high', 'medium', 'low'].map(p => <option key={p} value={p}>{labels[p]}</option>)}</select>
            <select aria-label="状态筛选" className={control} value={status} onChange={e => setStatus(e.target.value)}><option value="open">未完成</option><option value="all">全部状态</option><option value="attention">需关注</option>{['pending', 'in-progress', 'done', 'cancelled', 'blocked', 'review', 'deferred'].map(s => <option key={s} value={s}>{labels[s]}</option>)}</select>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="任务视图"><span className="self-center text-xs text-muted-foreground">视图</span>{[['all','全部'],['today','今天'],['mine','需要我'],['explore','探索']].map(([id,label]) => <button key={id} type="button" className={`min-h-10 rounded-lg px-3 text-xs ${view === id ? 'bg-foreground text-background' : 'border bg-background text-muted-foreground'}`} onClick={() => setView(id as typeof view)}>{label}</button>)}</div>
          <div className="flex flex-wrap items-center gap-2" aria-label="展示方式">{[['tree','主题树'],['groups','按大类'],['list','列表'],['board','看板']].map(([id,label])=><button key={id} type="button" className={control+(layout===id?' border-primary text-primary':'')} onClick={()=>setLayout(id as typeof layout)}>{label}</button>)}<button className={control} disabled={busy} onClick={()=>{const target=projectId||projects.find(p=>p.tasks.length)?.projectId;if(target)void act(()=>inboxTasksApi.organize(target),target);}}>迁移来源标签（备份/可撤销）</button></div>
          {view==='explore'&&<div className="space-y-2 rounded-lg border p-3"><p className="text-xs text-muted-foreground">选择多个标签，任务须同时符合全部标签</p><div className="flex flex-wrap gap-2">{[...new Set(all.flatMap(row=>row.task.tags||[]))].sort().map(tag=><button key={tag} className={control+(tags.includes(tag)?' border-primary text-primary':'')} aria-pressed={tags.includes(tag)} onClick={()=>setTags(old=>old.includes(tag)?old.filter(t=>t!==tag):[...old,tag])}>{tag}</button>)}</div></div>}
          <details><summary className="min-h-10 cursor-pointer text-xs text-muted-foreground">常用视图</summary><div className="flex flex-wrap gap-2"><input aria-label="视图名称" value={viewName} onChange={e=>setViewName(e.target.value)} placeholder="常用视图名称" className={control}/><button className={control} disabled={!viewName.trim()} onClick={async()=>{try{const next=[...savedViews.filter(v=>v.name!==viewName.trim()),{name:viewName.trim(),tags,projectId,view}];await read(await inboxTasksApi.saveViews(next));setSavedViews(next);setViewName('');}catch(e){setError(String(e));}}}>保存视图</button>{savedViews.map(v=><button key={v.name} className={control} onClick={()=>{setView(v.view);setTags(v.tags);setProjectId(v.projectId);}}>{v.name}</button>)}</div></details>
          {projectId&&<details><summary className="min-h-10 cursor-pointer text-xs text-muted-foreground">手动主题</summary><form className="flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();if(topicName.trim())void act(()=>inboxTasksApi.linkUnit(projectId,{id:'topic:'+topicName.trim(),title:topicName.trim(),parentIds:[]}),projectId).then(()=>setTopicName(''));}}><input aria-label="新主题" value={topicName} onChange={e=>setTopicName(e.target.value)} placeholder="新建手动主题" className={control}/><button className={control} disabled={!topicName.trim()||busy}>创建主题</button></form><div className="mt-3 space-y-3">{(projects.find(p=>p.projectId===projectId)?.topics||[]).filter(t=>!t.id.startsWith('infohub-unit:')).map(topic=><TopicPicker key={topic.id} label={topic.title+'的父主题'} options={(projects.find(p=>p.projectId===projectId)?.topics||[]).filter(t=>t.id!==topic.id)} selected={topic.parentIds} disabled={busy} onChange={parentIds=>void act(()=>inboxTasksApi.linkUnit(projectId,{id:topic.id,parentIds}),projectId)}/>)}</div></details>}
          <div className="flex flex-wrap gap-2" aria-label="任务大类筛选">
            {[{ id: '', name: '全部类别' }, ...sourceGroups].map(group => <button key={group.id} type="button" aria-pressed={category === group.id} onClick={() => setCategory(group.id)} className={`rounded-full px-3 py-1.5 text-xs transition-colors ${category === group.id ? 'bg-foreground font-medium text-background' : 'border bg-background text-muted-foreground hover:text-foreground'}`}>
              {group.name}<span className="ml-2 tabular-nums opacity-70">{loading ? '—' : filtered.filter(row => !group.id || row.category === group.id).length}</span>
            </button>)}
          </div>
        </div>
        {infohub&&!infohub.online&&<p role="status" className="rounded-lg border bg-muted p-3 text-sm text-muted-foreground">信息看板离线，稍后同步{infohub.error?` · ${infohub.error}`:''}</p>}
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30">{error}</p>}
        {projects.filter(p => p.error).map(p => <p key={p.projectId} className="text-sm text-red-600">{p.name}：{p.error}</p>)}
        {receipt && <div className="flex items-center gap-3 rounded-lg border bg-card p-3 text-sm"><Check size={16} className="text-emerald-600"/>状态已更新<button className="ml-auto flex items-center gap-1 text-primary" disabled={busy} onClick={() => void act(async () => { const response = await inboxTasksApi.undo(receipt.projectId, receipt.auditId); if (response.ok) setReceipt(null); return response; }, receipt.projectId)}><RotateCcw size={14}/>撤销</button></div>}
        {loading ? <p role="status" className="py-12 text-center text-muted-foreground">正在加载任务…</p> : !tasks.length ? <p className="rounded-xl border border-dashed py-12 text-center text-muted-foreground">{search || category || priority || status !== 'open' ? '没有符合筛选条件的任务' : '暂无任务'}</p> : null}
        <div className="space-y-4">
          {layout==='tree'&&projects.filter(p=>!projectId||p.projectId===projectId).map(project=><TaskTopicTree key={project.projectId} project={project} tasks={tasks.filter(r=>r.project.projectId===project.projectId).map(r=>r.task)} busy={busy} act={act}/>)}
          {layout==='list'&&tasks.map(({project,task})=><TaskRow key={project.projectId+':'+task.id} project={project} task={task} busy={busy} act={act}/>)}
          {layout==='board'&&<div className="flex gap-3 overflow-x-auto pb-3">{['pending','in-progress','review','blocked','deferred','done','cancelled'].map(s=><section key={s} className="w-80 shrink-0 rounded-xl border bg-card"><h2 className="p-3 text-sm font-semibold">{labels[s]} · {tasks.filter(r=>r.task.status===s).length}</h2>{tasks.filter(r=>r.task.status===s).map(({project,task})=><TaskRow key={project.projectId+':'+task.id} project={project} task={task} busy={busy} act={act}/>)}</section>)}</div>}
          {layout==='groups'&&sourceGroups.map(group => {
            const rows = tasks.filter(row => row.category === group.id);
            if (!rows.length) return null;
            const expanded = Boolean(!expandedGroups.includes(group.id));
            const visible = expanded ? rows : rows.slice(0, 3);
            const pending = rows.filter(row => row.task.status === 'pending').length;
            const running = rows.filter(row => row.task.status === 'in-progress').length;
            const attention = rows.filter(row => ['blocked', 'review'].includes(row.task.status)).length;
            return <section key={group.id} data-testid="task-workstream" aria-label={group.name} className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <header className="flex flex-wrap items-center gap-3 border-b bg-muted/25 px-4 py-3">
                <span className={`h-8 w-1 rounded-full ${group.accent}`}/><div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">{group.name}<span className="ml-2 rounded-md bg-background px-1.5 py-0.5 text-xs font-normal text-muted-foreground">{rows.length} 项</span></h2><p className="mt-0.5 text-xs text-muted-foreground">{group.description}</p></div>
                <div className="flex flex-wrap gap-3 text-xs"><span className="text-muted-foreground">待处理 {pending} · 进行中 {running}</span>{attention > 0 && <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400"><AlertCircle size={13}/>{attention} 需关注</span>}</div>
              </header>
              {visible.map(({ project, task }) => <TaskRow key={project.projectId + ':' + task.id} project={project} task={task} busy={busy} act={act}/>)}
              {rows.length > 3 && !category && !search.trim() && <button type="button" className="flex w-full items-center justify-center gap-2 border-t bg-muted/15 py-2.5 text-xs font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground" onClick={() => setExpandedGroups(previous => previous.includes(group.id) ? previous.filter(id => id !== group.id) : [...previous, group.id])} aria-expanded={expanded}>
                <ChevronDown size={14} className={expanded ? 'rotate-180' : ''}/>{expanded ? '收起为重点概览' : `展开其余 ${rows.length - 3} 项`}
              </button>}
            </section>;
          })}
        </div>
        {!loading && <p className="text-xs text-muted-foreground">当前筛选共 {tasks.length} 项</p>}
        <details className="border-t pt-3"><summary className="cursor-pointer text-xs text-muted-foreground">改动记录</summary>{projects.flatMap(p => p.audits.filter(a => !a.undone).slice(-5).reverse().map(a => <div key={p.projectId + a.id} className="flex flex-wrap items-center gap-2 border-b py-2 text-sm"><span className="min-w-0 flex-1 break-words">{p.name} · {new Date(a.at).toLocaleString()} · {a.changes.map(c => c.title).join('、')}</span><button className={control} disabled={busy} onClick={() => void act(() => inboxTasksApi.undo(p.projectId, a.id), p.projectId)}><RotateCcw size={16} aria-label="撤销此改动"/></button></div>))}</details>
        </div>}
      </div>
    </div>
  </section>;
}

function TaskTopicTree({project,tasks,busy,act}:{project:ProjectTasks;tasks:Task[];busy:boolean;act:(run:()=>Promise<Response>,project:string)=>Promise<boolean>}) {
  const sourceTags=[...new Set(tasks.flatMap(t=>t.tags?.filter(tag=>tag.startsWith('topic:')||tag.startsWith('project:'))||[]))];
  const topics=project.topics?.length?project.topics:sourceTags.map(id=>({id,title:id.slice(id.indexOf(':')+1),parentIds:[]}));
  const parents=(task:Task)=>task.parentIds?.length?task.parentIds:task.tags?.filter(t=>t.startsWith('topic:')||t.startsWith('project:')) || [];
  const render=(topic:Topic,trail:string[]):React.ReactNode=>{
    if(trail.includes(topic.id))return null;
    const descendants=(id:string,seen=new Set<string>()):Set<string>=>{if(seen.has(id))return seen;seen.add(id);topics.filter(t=>t.parentIds.includes(id)).forEach(t=>descendants(t.id,seen));return seen;};
    const subtree=descendants(topic.id),all=tasks.filter(t=>parents(t).some(id=>subtree.has(id))),direct=tasks.filter(t=>parents(t).includes(topic.id)&&!parents(t).some(id=>id!==topic.id&&subtree.has(id)));
    if(!all.length)return null;
    return <details open key={topic.id} data-testid="task-workstream" className="rounded-xl border bg-card"><summary className="min-h-10 cursor-pointer p-3"><span className="text-sm font-semibold">{topic.title}</span><span className="ml-3 text-xs text-muted-foreground">{all.length} 项 · 待处理 {all.filter(t=>t.status==='pending').length} · 进行中 {all.filter(t=>t.status==='in-progress').length} · 需关注 {all.filter(t=>['review','blocked'].includes(t.status)).length}</span></summary><div className="space-y-2 px-2 pb-2">{direct.map(task=><TaskRow key={task.id} project={project} task={task} busy={busy} act={act}/>)}<div className="space-y-2 pl-3">{topics.filter(t=>t.parentIds.includes(topic.id)).map(t=>render(t,[...trail,topic.id]))}</div></div></details>;
  };
  return <div className="space-y-3">{tasks.length>0&&<p className="text-xs text-muted-foreground">{project.name}</p>}{topics.filter(t=>!t.parentIds.length).map(t=>render(t,[]))}{tasks.filter(t=>!parents(t).some(id=>topics.some(topic=>topic.id===id))).map(task=><TaskRow key={task.id} project={project} task={task} busy={busy} act={act}/>)}</div>;
}

function TaskRow({ project, task, busy, act }: { project: ProjectTasks; task: Task; busy: boolean; act: (run: () => Promise<Response>, project: string) => Promise<boolean> }) {
  // The selected option stays local until the user explicitly executes it.
  const [option, setOption] = useState(task.recommended || 'A');
  // Retains a user-written execution note until it is explicitly saved or executed.
  const [userInput, setUserInput] = useState(task.userInput || '');
  const navigate = useNavigate();
  const [executeOpen,setExecuteOpen]=useState(false);
  const currentConversation=localStorage.getItem('nexagent.currentSession');
  return <details open className="group border-b border-border/60 last:border-b-0" data-task-id={String(task.id)} data-testid="global-task-row">
    <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3.5 transition-colors hover:bg-muted/25">
      <ChevronDown className="mt-1 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" size={15}/>
      <div className="min-w-0 flex-1"><h3 className="break-words text-sm font-medium leading-6">{task.title}</h3>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]"><span className={`rounded-md px-2 py-0.5 font-medium ${statusStyles[task.status] || 'bg-muted text-muted-foreground'}`}>{labels[task.status] || task.status}</span><span className="text-muted-foreground">{project.name} · #{task.id}</span>{task.due && <span className={dueTime(task.due)<Date.now()&&isOpenTask(task)?'font-medium text-red-600 dark:text-red-400':'text-muted-foreground'}>{dueTime(task.due)<Date.now()&&isOpenTask(task)?'已逾期 · ':'截止 '}{task.due}</span>}{task.priority === 'high' && <span className="text-red-600 dark:text-red-400">高优先级</span>}</div>
      </div>
    </summary>
    <div className="space-y-4 border-t border-border/50 bg-muted/10 px-4 py-4 sm:pl-11">
      {(task.details || task.description) && <div><h4 className="mb-1.5 text-xs font-semibold text-muted-foreground">要做什么</h4><p className="whitespace-pre-wrap break-words text-sm leading-6">{task.details || task.description}</p></div>}
      {task.source && <p className="break-words text-xs text-muted-foreground">来源：{task.source}</p>}
      {!!task.tags?.length&&<p className="flex flex-wrap gap-2 text-xs text-muted-foreground">{task.tags.map(tag=><span key={tag} className="rounded bg-muted px-2 py-1">{tag}</span>)}</p>}
      {task.source==='infohub'&&task.evidenceLink?<a href={task.evidenceLink} className="inline-flex min-h-10 items-center gap-2 text-xs text-primary">在信息看板查看来源与主题</a>:!!project.topics?.length&&<TopicPicker label={task.title+'的主题'} options={project.topics} selected={task.parentIds||[]} disabled={busy} onChange={parentIds=>void act(()=>inboxTasksApi.linkUnit(project.projectId,{id:'task:'+task.id,parentIds}),project.projectId)}/>}
      {!!task.sources?.length&&<details><summary className="min-h-10 cursor-pointer text-xs text-muted-foreground">来源证据（{task.sources.length}）</summary>{task.sources.map((s,i)=><div key={i} className="my-2 break-words text-xs"><p>{s.evidence}</p>{s.sessionId&&<button className={control} onClick={()=>navigate('/session/'+s.sessionId+'?message='+encodeURIComponent(s.messageId||''))}>查看原对话位置</button>}</div>)}</details>}
      {!!task.originEvidence?.length&&<details><summary className="min-h-10 cursor-pointer text-xs text-muted-foreground">桥接来源（{task.originEvidence.length}）</summary><pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(task.originEvidence,null,2)}</pre></details>}
      <div className="space-y-2"><label className="block text-xs font-semibold text-muted-foreground" htmlFor={`task-input-${project.projectId}-${task.id}`}>自己写做法/补充要求</label><textarea id={`task-input-${project.projectId}-${task.id}`} value={userInput} onChange={e => setUserInput(e.target.value)} placeholder="补充执行要求，也可以只保存为备注" className="min-h-20 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm"/><div className="flex flex-wrap gap-2"><button type="button" className={control} disabled={busy} onClick={() => void act(() => inboxTasksApi.saveInput(project.projectId, String(task.id), userInput), project.projectId)}>保存备注</button></div></div>
      {!!task.options?.length && <div><h4 className="mb-2 text-xs font-semibold text-muted-foreground">选择做法</h4><div role="radiogroup" aria-label={`${task.title}的做法`} className="grid gap-2">{task.options.map(o => <label key={o.key} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${option === o.key ? 'border-primary/50 bg-primary/5' : 'border-border bg-background'}`}><input type="radio" className="mt-1" name={'option-' + project.projectId + task.id} checked={option === o.key} onChange={() => setOption(o.key)}/><span className="min-w-0 break-words"><strong className="font-medium">{o.key} · {o.label}{o.key === task.recommended && <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">推荐</span>}</strong><span className="mt-1 block text-xs leading-5 text-muted-foreground">{o.plan}</span></span></label>)}</div></div>}
      <TaskExecutionPanel title={task.title} cwd={project.root||''} open={executeOpen} busy={busy} onClose={()=>setExecuteOpen(false)} onConfirm={async settings=>{const ok=await act(()=>inboxTasksApi.execute(project.projectId,String(task.id),option,userInput,settings),project.projectId);if(ok)setExecuteOpen(false);}}/>
      <div className="flex flex-wrap items-center gap-2"><button className={control} disabled={!currentConversation} title={!currentConversation?'先打开一个对话':''} onClick={()=>{if(!currentConversation)return;const text='任务 #'+task.id+'：'+task.title+'\n'+(task.details||task.description||'')+(userInput?'\n补充要求：'+userInput:'');sessionStorage.setItem('nexagent.taskDraft:'+currentConversation,text);navigate('/session/'+currentConversation);}}>发到当前对话</button><button className="flex min-h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-40" disabled={busy || ['done', 'cancelled', 'in-progress'].includes(task.status)} onClick={()=>setExecuteOpen(true)}><Play size={14}/>执行</button>
        {task.executionSessionId && <button className={control + ' flex items-center gap-2'} onClick={() => navigate('/session/' + task.executionSessionId)}><LLMProviderLogo provider={(task.executionProvider||'codex') as LLMProvider} className="h-4 w-4"/><ExternalLink size={14}/>查看执行会话{task.executionStatus?' · '+({running:'运行中',completed:'完成',failed:'失败'}[task.executionStatus]||task.executionStatus):''}</button>}
        {['done', 'cancelled', 'in-progress'].includes(task.status) && <span className="text-xs text-muted-foreground">{task.status === 'in-progress' ? '正在执行，可打开执行会话查看进度' : '此任务已结束，撤销状态后可再次执行'}</span>}
        <button className={control + ' flex items-center gap-2'} disabled={busy || task.status === 'done'} onClick={() => void act(() => inboxTasksApi.action(project.projectId, String(task.id), 'done'), project.projectId)}><Check size={14}/>标记完成</button>
        <button className="flex min-h-10 items-center gap-1 px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40" disabled={busy || task.status === 'cancelled'} onClick={() => void act(() => inboxTasksApi.action(project.projectId, String(task.id), 'cancelled'), project.projectId)}><X size={14}/>忽略</button>
      </div>
    </div>
  </details>;
}

function TopicPicker({label,options,selected,disabled,onChange}:{label:string;options:Topic[];selected:string[];disabled:boolean;onChange:(ids:string[])=>void}){const [query,setQuery]=useState('');return <fieldset className="rounded-lg border p-3"><legend className="px-1 text-xs text-muted-foreground">{label}</legend><input aria-label={label+'筛选'} placeholder="搜索来源标签或主题" value={query} onChange={e=>setQuery(e.target.value)} className={control+' mb-2 w-full text-xs'}/><div className="flex max-h-40 flex-wrap gap-2 overflow-auto">{options.filter(t=>t.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(t=><button key={t.id} type="button" aria-pressed={selected.includes(t.id)} disabled={disabled} onClick={()=>onChange(selected.includes(t.id)?selected.filter(id=>id!==t.id):[...selected,t.id])} className={'min-h-10 rounded-full border px-3 text-xs '+(selected.includes(t.id)?'border-primary bg-primary/10 text-primary':'bg-background')}>{selected.includes(t.id)?'✓ ':''}{t.title}</button>)}</div></fieldset>;}
