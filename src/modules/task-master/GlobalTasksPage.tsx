import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronDown, ExternalLink, ListTodo, Menu, Play, RefreshCw, RotateCcw, X } from 'lucide-react';
import { inboxTasksApi } from '@/shared/api';

type Task = { id: string | number; title: string; description?: string; details?: string; source?: string; due?: string; status: string; priority?: string; recommended?: string; options?: { key: string; label: string; plan: string }[]; executionSessionId?: string };
type ProjectTasks = { projectId: string; name: string; tasks: Task[]; error?: string; audits: { id: string; at: string; undone?: boolean; changes: { id: string | number; title: string; status: string }[] }[] };
const labels: Record<string, string> = { pending: '待处理', 'in-progress': '进行中', done: '已完成', cancelled: '已忽略', blocked: '受阻', deferred: '暂缓', review: '待验收', high: '高', medium: '中', low: '低' };
async function read(response: Response) { const value = await response.json(); if (!response.ok) throw new Error(value.message || value.error || '任务请求失败'); return value; }
function dueTime(due?: string) {
  const date = due?.match(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?/)?.[0];
  return date ? Date.parse(date) || Infinity : Infinity;
}

function useGlobalTasks() {
  // Keeps the latest server snapshot for polling and explicit changes.
  const [projects, setProjects] = useState<ProjectTasks[]>([]);
  // Network errors stay visible until the next successful refresh.
  const [error, setError] = useState('');
  const load = useCallback(async () => { try { const value = await read(await inboxTasksApi.list()); setProjects(value.projects); setError(''); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }, []);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 10000); return () => clearInterval(timer); }, [load]);
  return { projects, error, load, setError };
}

/** SidebarHeader uses the same global task collection to navigate and display open/high counts. */
export function TasksNavigation() {
  const navigate = useNavigate(), { projects, error } = useGlobalTasks();
  const tasks = projects.flatMap(p => p.tasks).filter(t => !['done', 'cancelled'].includes(t.status));
  const high = tasks.filter(t => t.priority === 'high').length;
  return <button type="button" className="sidebar-nav-action" onClick={() => navigate('/tasks')} aria-label={`任务，${tasks.length} 项未完成`}>
    <ListTodo size={16}/><span>任务</span><span className="ml-auto text-xs text-muted-foreground">{error ? '连接异常' : tasks.length}</span>
    {high > 0 && <span className="text-xs text-red-600" aria-label={`${high} 项高优先级`}>{high}</span>}
  </button>;
}

/** ProjectMainRegion renders the global task workspace on desktop and mobile. */
export function GlobalTasksPage({ onMenuClick }: { onMenuClick: () => void }) {
  const { projects, error, load, setError } = useGlobalTasks(), navigate = useNavigate();
  // Filters persist while polling updates the underlying collection.
  const [projectId, setProjectId] = useState('');
  // Priority filtering is independent of the project selection.
  const [priority, setPriority] = useState('');
  // Open work is the default, while finished tasks remain accessible.
  const [status, setStatus] = useState('open');
  // Disables mutation controls for the duration of one server request.
  const [busy, setBusy] = useState(false);
  // Audit receipts support immediate undo without changing the task's provenance.
  const [receipt, setReceipt] = useState<{ projectId: string; auditId: string } | null>(null);
  const act = async (run: () => Promise<Response>, targetProject: string) => {
    setBusy(true); setError('');
    try { const result = await read(await run()); if (result.auditId) setReceipt({ projectId: targetProject, auditId: result.auditId }); await load(); if (result.sessionId) navigate('/session/' + result.sessionId); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const tasks = projects.flatMap(project => project.tasks.map(task => ({ project, task }))).filter(({ project, task }) =>
    (!projectId || project.projectId === projectId) && (!priority || task.priority === priority) &&
    (status === 'all' || (status === 'open' ? !['done', 'cancelled'].includes(task.status) : task.status === status)))
    .sort((a, b) => (rank[a.task.priority || 'medium'] ?? 1) - (rank[b.task.priority || 'medium'] ?? 1) || dueTime(a.task.due) - dueTime(b.task.due) || a.task.title.localeCompare(b.task.title));
  const control = 'min-h-10 rounded-md border bg-background px-3 text-sm disabled:opacity-50';
  return <section className="flex h-full min-h-0 flex-col" aria-label="全局任务">
    <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4"><button type="button" title="打开侧栏" aria-label="打开侧栏" className="workspace-icon-button md:hidden" onClick={onMenuClick}><Menu size={18}/></button><ListTodo size={19}/><h1 className="text-lg font-semibold">任务</h1><span className="text-sm text-muted-foreground">{tasks.length}</span><button type="button" aria-label="刷新任务" title="刷新任务" className="workspace-icon-button ml-auto" onClick={() => void load()}><RefreshCw size={17}/></button></header>
    <div className="flex flex-wrap gap-2 border-b p-4">
      <select aria-label="项目筛选" className={control + ' max-w-full'} value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">全部项目</option>{projects.map(p => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}</select>
      <select aria-label="优先级筛选" className={control} value={priority} onChange={e => setPriority(e.target.value)}><option value="">全部优先级</option>{['high', 'medium', 'low'].map(p => <option key={p} value={p}>{labels[p]}</option>)}</select>
      <select aria-label="状态筛选" className={control} value={status} onChange={e => setStatus(e.target.value)}><option value="open">未完成</option><option value="all">全部状态</option>{['pending', 'in-progress', 'done', 'cancelled', 'blocked', 'review', 'deferred'].map(s => <option key={s} value={s}>{labels[s]}</option>)}</select>
    </div>
    <div className="flex-1 overflow-auto px-4 pb-8">
      {error && <p role="alert" className="py-3 text-sm text-red-600">{error}</p>}
      {projects.filter(p => p.error).map(p => <p key={p.projectId} className="py-2 text-sm text-red-600">{p.name}：{p.error}</p>)}
      {receipt && <div className="flex items-center gap-2 border-b py-2 text-sm">状态已更新<button className={control + ' flex items-center gap-2'} disabled={busy} onClick={() => void act(async () => { const response = await inboxTasksApi.undo(receipt.projectId, receipt.auditId); if (response.ok) setReceipt(null); return response; }, receipt.projectId)}><RotateCcw size={15}/>撤销</button></div>}
      {!tasks.length && <p className="py-12 text-center text-muted-foreground">暂无任务</p>}
      {tasks.map(({ project, task }) => <TaskRow key={project.projectId + ':' + task.id} project={project} task={task} busy={busy} control={control} act={act}/>)}
      <details className="border-t py-3"><summary className="cursor-pointer text-sm text-muted-foreground">改动记录</summary>{projects.flatMap(p => p.audits.filter(a => !a.undone).slice(-5).reverse().map(a => <div key={a.id} className="flex flex-wrap items-center gap-2 border-b py-2 text-sm"><span className="min-w-0 flex-1 break-words">{p.name} · {new Date(a.at).toLocaleString()} · {a.changes.map(c => c.title).join('、')}</span><button className={control} disabled={busy} onClick={() => void act(() => inboxTasksApi.undo(p.projectId, a.id), p.projectId)}><RotateCcw size={16} aria-label="撤销此改动"/></button></div>))}</details>
    </div>
  </section>;
}

function TaskRow({ project, task, busy, control, act }: { project: ProjectTasks; task: Task; busy: boolean; control: string; act: (run: () => Promise<Response>, project: string) => Promise<void> }) {
  // The selected option stays local until the user explicitly executes it.
  const [option, setOption] = useState(task.recommended || 'A');
  const navigate = useNavigate();
  return <details className="border-b py-3" data-testid="global-task-row">
    <summary className="flex cursor-pointer list-none items-start gap-3"><ChevronDown className="mt-1 shrink-0 text-muted-foreground" size={16}/><div className="min-w-0 flex-1"><h2 className="break-words text-sm font-medium leading-6">{task.title}</h2><p className="mt-1 break-words text-xs text-muted-foreground">{project.name} · {labels[task.status] || task.status}{task.due ? ' · ' + task.due : ''}</p></div><span className={'mt-1 shrink-0 text-xs ' + (task.priority === 'high' ? 'text-red-600' : 'text-muted-foreground')}>{labels[task.priority || 'medium']}</span></summary>
    <div className="space-y-3 pb-1 pl-7 pt-3 text-sm"><p className="whitespace-pre-wrap break-words text-muted-foreground">{task.details || task.description}</p>{task.source && <p className="break-words">来源：{task.source}</p>}{task.due && <p className="break-words">截止：{task.due}</p>}
      <div role="radiogroup" aria-label={`${task.title}的做法`} className="flex flex-col gap-2">{task.options?.map(o => <label key={o.key} className={'flex min-h-10 cursor-pointer items-start gap-3 rounded-md border p-3 ' + (option === o.key ? 'border-emerald-600 bg-emerald-50 dark:bg-emerald-950/30' : '')}><input type="radio" className="mt-1" name={'option-' + project.projectId + task.id} checked={option === o.key} onChange={() => setOption(o.key)}/><span className="min-w-0 break-words"><strong>{o.key} · {o.label}{o.key === task.recommended && <span className="ml-2 text-xs text-emerald-700 dark:text-emerald-400">推荐</span>}</strong><span className="mt-1 block text-muted-foreground">{o.plan}</span></span></label>)}</div>
      <div className="flex flex-wrap gap-2"><button className={control + ' flex items-center gap-2'} disabled={busy || ['done', 'cancelled', 'in-progress'].includes(task.status)} onClick={() => void act(() => inboxTasksApi.execute(project.projectId, String(task.id), option), project.projectId)}><Play size={15}/>执行</button>
        {task.executionSessionId && <button className={control + ' flex items-center gap-2'} onClick={() => navigate('/session/' + task.executionSessionId)}><ExternalLink size={15}/>Codex 会话</button>}
        <button className={control + ' flex items-center gap-2'} disabled={busy || task.status === 'done'} onClick={() => void act(() => inboxTasksApi.action(project.projectId, String(task.id), 'done'), project.projectId)}><Check size={15}/>标记完成</button>
        <button className={control + ' flex items-center gap-2'} disabled={busy || task.status === 'cancelled'} onClick={() => void act(() => inboxTasksApi.action(project.projectId, String(task.id), 'cancelled'), project.projectId)}><X size={15}/>忽略</button></div>
    </div>
  </details>;
}
