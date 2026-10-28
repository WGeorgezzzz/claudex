import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, Check, ChevronDown, ExternalLink, ListTodo, Menu, Play, RefreshCw, RotateCcw, Search, X } from 'lucide-react';

import { inboxTasksApi } from '@/shared/api';
import { TASK_WORKSTREAMS, taskWorkstream } from '@/modules/task-master/utils/taskWorkstreams';

type Task = { id: string | number; title: string; description?: string; details?: string; source?: string; due?: string; status: string; priority?: string; recommended?: string; options?: { key: string; label: string; plan: string }[]; executionSessionId?: string };
type ProjectTasks = { projectId: string; name: string; tasks: Task[]; error?: string; audits: { id: string; at: string; undone?: boolean; changes: { id: string | number; title: string; status: string }[] }[] };
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
function useGlobalTasks() {
  // Keeps the latest server snapshot for polling and explicit changes.
  const [projects, setProjects] = useState<ProjectTasks[]>([]);
  // Initial loading must not look like an empty task collection.
  const [loading, setLoading] = useState(true);
  // Network errors stay visible until the next successful refresh.
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { const value = await read(await inboxTasksApi.list()); setProjects(value.projects); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 10000); return () => clearInterval(timer); }, [load]);
  return { projects, error, loading, load, setError };
}

/** SidebarHeader uses the same global task collection to navigate and display open/high counts. */
export function TasksNavigation() {
  const navigate = useNavigate(), { projects, error, loading } = useGlobalTasks();
  const tasks = projects.flatMap(p => p.tasks).filter(isOpenTask);
  const high = tasks.filter(t => t.priority === 'high').length;
  return <button type="button" className="sidebar-nav-action" onClick={() => navigate('/tasks')} aria-label={`任务，${tasks.length} 项未完成`}>
    <ListTodo size={16}/><span>任务</span><span className="ml-auto text-xs text-muted-foreground">{error ? '连接异常' : loading ? '…' : tasks.length}</span>
    {high > 0 && <span className="text-xs text-red-600" aria-label={`${high} 项高优先级`}>{high}</span>}
  </button>;
}

/** ProjectMainRegion shows broad workstreams first and expands the original task records on demand. */
export function GlobalTasksPage({ onMenuClick }: { onMenuClick: () => void }) {
  const { projects, error, loading, load, setError } = useGlobalTasks(), navigate = useNavigate();
  // Project scope stays stable while polling updates the collection.
  const [projectId, setProjectId] = useState('');
  // Priority filtering is independent of task status.
  const [priority, setPriority] = useState('');
  // Open work is the default; completed and ignored tasks stay accessible.
  const [status, setStatus] = useState('open');
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
  const act = async (run: () => Promise<Response>, targetProject: string) => {
    setBusy(true); setError('');
    try { const result = await read(await run()); if (result.auditId) setReceipt({ projectId: targetProject, auditId: result.auditId }); await load(); if (result.sessionId) navigate('/session/' + result.sessionId); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const all = projects.flatMap(project => project.tasks.map(task => ({ project, task, category: taskWorkstream(task.title, project.name) })))
    .filter(row => !projectId || row.project.projectId === projectId);
  const totals = { open: all.filter(row => isOpenTask(row.task)).length, running: all.filter(row => row.task.status === 'in-progress').length,
    attention: all.filter(row => ['blocked', 'review'].includes(row.task.status)).length, done: all.filter(row => row.task.status === 'done').length };
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const keywords = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered = all.filter(({ project, task }) => (!priority || task.priority === priority)
    && (status === 'all' || (status === 'open' ? isOpenTask(task) : status === 'attention' ? ['blocked', 'review'].includes(task.status) : task.status === status))
    && keywords.every(word => [task.title, task.description, task.details, task.source, project.name].filter(Boolean).join(' ').toLowerCase().includes(word)))
    .sort((a, b) => (rank[a.task.priority || 'medium'] ?? 1) - (rank[b.task.priority || 'medium'] ?? 1) || dueTime(a.task.due) - dueTime(b.task.due) || a.task.title.localeCompare(b.task.title));
  const tasks = filtered.filter(row => !category || row.category === category);
  const summary = [{ id: 'open', label: '未完成', count: totals.open, tone: 'text-foreground' },
    { id: 'in-progress', label: '进行中', count: totals.running, tone: 'text-blue-600 dark:text-blue-400' },
    { id: 'attention', label: '需关注', count: totals.attention, tone: 'text-amber-700 dark:text-amber-400' },
    { id: 'done', label: '已完成', count: totals.done, tone: 'text-emerald-700 dark:text-emerald-400' }];
  return <section className="flex h-full min-h-0 flex-col bg-muted/15" aria-label="全局任务">
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4 md:px-6">
      <button type="button" title="打开侧栏" aria-label="打开侧栏" className="workspace-icon-button md:hidden" onClick={onMenuClick}><Menu size={18}/></button>
      <ListTodo size={19}/><h1 className="text-lg font-semibold">任务</h1><span className="text-xs text-muted-foreground">按大类整理</span>
      <button type="button" aria-label="刷新任务" title="刷新任务" className="workspace-icon-button ml-auto" onClick={() => void load()}><RefreshCw size={17}/></button>
    </header>
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-6xl space-y-5 p-4 md:p-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="任务概览">
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
          <div className="flex flex-wrap gap-2" aria-label="任务大类筛选">
            {[{ id: '', name: '全部类别' }, ...TASK_WORKSTREAMS].map(group => <button key={group.id} type="button" aria-pressed={category === group.id} onClick={() => setCategory(group.id)} className={`rounded-full px-3 py-1.5 text-xs transition-colors ${category === group.id ? 'bg-foreground font-medium text-background' : 'border bg-background text-muted-foreground hover:text-foreground'}`}>
              {group.name}<span className="ml-2 tabular-nums opacity-70">{loading ? '—' : filtered.filter(row => !group.id || row.category === group.id).length}</span>
            </button>)}
          </div>
        </div>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30">{error}</p>}
        {projects.filter(p => p.error).map(p => <p key={p.projectId} className="text-sm text-red-600">{p.name}：{p.error}</p>)}
        {receipt && <div className="flex items-center gap-3 rounded-lg border bg-card p-3 text-sm"><Check size={16} className="text-emerald-600"/>状态已更新<button className="ml-auto flex items-center gap-1 text-primary" disabled={busy} onClick={() => void act(async () => { const response = await inboxTasksApi.undo(receipt.projectId, receipt.auditId); if (response.ok) setReceipt(null); return response; }, receipt.projectId)}><RotateCcw size={14}/>撤销</button></div>}
        {loading ? <p role="status" className="py-12 text-center text-muted-foreground">正在加载任务…</p> : !tasks.length ? <p className="rounded-xl border border-dashed py-12 text-center text-muted-foreground">{search || category || priority || status !== 'open' ? '没有符合筛选条件的任务' : '暂无任务'}</p> : null}
        <div className="space-y-4">
          {TASK_WORKSTREAMS.map(group => {
            const rows = tasks.filter(row => row.category === group.id);
            if (!rows.length) return null;
            const expanded = Boolean(!expandedGroups.includes(group.id));
            const visible = expanded ? rows : rows.slice(0, 3);
            const running = rows.filter(row => row.task.status === 'in-progress').length;
            const attention = rows.filter(row => ['blocked', 'review'].includes(row.task.status)).length;
            return <section key={group.id} data-testid="task-workstream" aria-label={group.name} className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <header className="flex flex-wrap items-center gap-3 border-b bg-muted/25 px-4 py-3">
                <span className={`h-8 w-1 rounded-full ${group.accent}`}/><div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">{group.name}<span className="ml-2 rounded-md bg-background px-1.5 py-0.5 text-xs font-normal text-muted-foreground">{rows.length} 项</span></h2><p className="mt-0.5 text-xs text-muted-foreground">{group.description}</p></div>
                <div className="flex gap-3 text-xs">{running > 0 && <span className="text-blue-600 dark:text-blue-400">{running} 进行中</span>}{attention > 0 && <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400"><AlertCircle size={13}/>{attention} 需关注</span>}</div>
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
      </div>
    </div>
  </section>;
}

function TaskRow({ project, task, busy, act }: { project: ProjectTasks; task: Task; busy: boolean; act: (run: () => Promise<Response>, project: string) => Promise<void> }) {
  // The selected option stays local until the user explicitly executes it.
  const [option, setOption] = useState(task.recommended || 'A');
  const navigate = useNavigate();
  return <details open className="group border-b border-border/60 last:border-b-0" data-testid="global-task-row">
    <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3.5 transition-colors hover:bg-muted/25">
      <ChevronDown className="mt-1 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" size={15}/>
      <div className="min-w-0 flex-1"><h3 className="break-words text-sm font-medium leading-6">{task.title}</h3>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]"><span className={`rounded-md px-2 py-0.5 font-medium ${statusStyles[task.status] || 'bg-muted text-muted-foreground'}`}>{labels[task.status] || task.status}</span><span className="text-muted-foreground">{project.name} · #{task.id}</span>{task.due && <span className="text-muted-foreground">截止 {task.due}</span>}{task.priority === 'high' && <span className="text-red-600 dark:text-red-400">高优先级</span>}</div>
      </div>
    </summary>
    <div className="space-y-4 border-t border-border/50 bg-muted/10 px-4 py-4 sm:pl-11">
      {(task.details || task.description) && <div><h4 className="mb-1.5 text-xs font-semibold text-muted-foreground">要做什么</h4><p className="whitespace-pre-wrap break-words text-sm leading-6">{task.details || task.description}</p></div>}
      {task.source && <p className="break-words text-xs text-muted-foreground">来源：{task.source}</p>}
      {!!task.options?.length && <div><h4 className="mb-2 text-xs font-semibold text-muted-foreground">选择做法</h4><div role="radiogroup" aria-label={`${task.title}的做法`} className="grid gap-2">{task.options.map(o => <label key={o.key} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${option === o.key ? 'border-primary/50 bg-primary/5' : 'border-border bg-background'}`}><input type="radio" className="mt-1" name={'option-' + project.projectId + task.id} checked={option === o.key} onChange={() => setOption(o.key)}/><span className="min-w-0 break-words"><strong className="font-medium">{o.key} · {o.label}{o.key === task.recommended && <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">推荐</span>}</strong><span className="mt-1 block text-xs leading-5 text-muted-foreground">{o.plan}</span></span></label>)}</div></div>}
      <div className="flex flex-wrap items-center gap-2"><button className="flex min-h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-40" disabled={busy || ['done', 'cancelled', 'in-progress'].includes(task.status)} onClick={() => void act(() => inboxTasksApi.execute(project.projectId, String(task.id), option), project.projectId)}><Play size={14}/>执行</button>
        {task.executionSessionId && <button className={control + ' flex items-center gap-2'} onClick={() => navigate('/session/' + task.executionSessionId)}><ExternalLink size={14}/>查看执行会话</button>}
        <button className={control + ' flex items-center gap-2'} disabled={busy || task.status === 'done'} onClick={() => void act(() => inboxTasksApi.action(project.projectId, String(task.id), 'done'), project.projectId)}><Check size={14}/>标记完成</button>
        <button className="flex min-h-10 items-center gap-1 px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40" disabled={busy || task.status === 'cancelled'} onClick={() => void act(() => inboxTasksApi.action(project.projectId, String(task.id), 'cancelled'), project.projectId)}><X size={14}/>忽略</button>
      </div>
    </div>
  </details>;
}
