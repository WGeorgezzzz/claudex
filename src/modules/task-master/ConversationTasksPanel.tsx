import { useCallback, useEffect, useState } from 'react';
import { ListChecks, Play, RefreshCw, Undo2 } from 'lucide-react';
import { api } from '@/shared/api';
import { TaskAutomationSettings } from '@/modules/task-master/TaskAutomationSettings';
import type { TaskMasterConversationSnapshot } from '@/shared/types';

type Props = { sessionId: string | null; busy: boolean; onExecute: (prompt: string) => void; onSource: (id: string, evidence: string) => void };
/** Chat displays conversation-linked tasks without creating another model conversation or terminal. */
export function ConversationTasksPanel({ sessionId, busy, onExecute, onSource }: Props) {
  // Snapshot is refreshed independently of chat messages so automatic updates remain visible.
  const [snapshot, setSnapshot] = useState<TaskMasterConversationSnapshot | null>(null);
  // One operation at a time prevents double confirmations and overlapping undo requests.
  const [working, setWorking] = useState(false);
  // Manual request failures remain actionable alongside background extraction failures.
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const r = await api.taskmaster.conversation(sessionId); if (!r.ok) throw new Error('无法读取本对话任务');
    setSnapshot(await r.json());
  }, [sessionId]);
  useEffect(() => { setSnapshot(null); setError(''); if (!sessionId) return; let alive = true;
    const read = () => { if (alive) void refresh().catch(e => { if (alive) setError(String(e)); }); };
    read(); const timer = setInterval(read, 10000); return () => { alive = false; clearInterval(timer); };
  }, [refresh, sessionId]);
  const action = async (operation: 'extract' | 'confirm' | 'undo', auditId?: string) => {
    if (!sessionId) return; setWorking(true); setError('');
    try { const r = await api.taskmaster.conversationAction(sessionId, operation, auditId); const data = await r.json(); if (!r.ok) throw new Error(data.message || data.error?.message || '操作失败'); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setWorking(false); }
  };
  const nextTask = snapshot?.tasks.find(task => ['pending', 'in-progress'].includes(task.status || 'pending') && (task.dependencies ?? []).every(id => snapshot.tasks.some(t => String(t.id) === String(id) && t.status === 'done')));
  if (!sessionId) return null;
  return <details className="mx-4 my-2 max-h-72 shrink-0 overflow-auto rounded-xl border bg-card p-3" data-testid="conversation-tasks">
    <summary className="cursor-pointer text-sm font-medium"><ListChecks className="mr-2 inline h-4 w-4"/>本对话的任务 · {snapshot?.tasks.length ?? 0}</summary>
    <div className="mt-3 space-y-3">
      <button disabled={busy || working} onClick={() => void action('extract')} className="flex items-center gap-2 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"><RefreshCw className={working ? 'h-3 w-3 animate-spin' : 'h-3 w-3'}/>{working ? '正在整理任务…' : '从本对话整理任务'}</button>
      {(error || snapshot?.error) && <p role="alert" className="text-xs text-red-500">{error || snapshot?.error}</p>}
      {snapshot?.skipped && <p className="text-xs">{snapshot.skipped}</p>}
      {nextTask && <div className="flex items-center justify-between gap-3 rounded-lg bg-primary/10 p-3 text-sm"><span>下一个任务：{nextTask.title}</span><button disabled={busy} onClick={() => onExecute(`请执行任务 #${nextTask.id}：${nextTask.title}\n${nextTask.description || ''}\n验收标准：${nextTask.testStrategy || '按描述完成并验证'}`)} className="shrink-0 rounded bg-primary px-2 py-1 text-xs text-primary-foreground">一键执行</button></div>}
      {snapshot?.tasks.map(task => <article key={task.id} className="rounded-lg border p-3 text-sm">
        <div className="flex justify-between gap-2"><strong>{task.title}</strong><span className="text-xs text-muted-foreground">{({ pending: '待办', 'in-progress': '进行中', done: '已完成', blocked: '阻塞', cancelled: '已取消' } as Record<string, string>)[task.status || 'pending'] || task.status}</span></div>
        <p className="my-1 text-xs text-muted-foreground">{task.description}</p>
        {task.autoUpdate && <p className="text-xs text-green-600">自动更新：依据 {task.autoUpdate.evidence}</p>}
        {task.sources?.filter(s => s.sessionId === sessionId).slice(-1).map(source => <button key={source.messageId} onClick={() => onSource(source.messageId, source.evidence)} className="mr-3 text-xs text-blue-500 underline">查看原对话位置</button>)}
        {task.status !== 'done' && task.status !== 'cancelled' && <button disabled={busy} onClick={() => onExecute(`请执行任务 #${task.id}：${task.title}\n${task.description || ''}\n验收标准：${task.testStrategy || '按任务描述完成并验证。'}`)} className="text-xs text-blue-500"><Play className="mr-1 inline h-3 w-3"/>发到当前对话执行</button>}
      </article>)}
      {!!snapshot?.suggestions.length && <div className="rounded-lg border border-amber-500/30 p-3 text-sm"><strong>建议任务（待确认）</strong>{snapshot.suggestions.map((s, i) => <p key={i} className="my-1 text-xs">{s.title} · {s.evidence}</p>)}<button disabled={working || busy} onClick={() => void action('confirm')} className="text-xs text-blue-500">确认这些建议</button></div>}
      {!!snapshot?.audits.length && <details><summary className="text-xs">自动改动记录</summary>{[...snapshot.audits].reverse().map(a => <div key={a.id} className="my-2 flex justify-between text-xs"><span>{new Date(a.at).toLocaleString()} · {a.changes.length} 项变动 {a.undone ? '（已撤销）' : ''}</span>{!a.undone && <button disabled={working} onClick={() => void action('undo', a.id)}><Undo2 className="mr-1 inline h-3 w-3"/>撤销</button>}</div>)}</details>}
      <details><summary className="text-xs text-muted-foreground">任务整理设置</summary><div className="mt-3"><TaskAutomationSettings root={snapshot?.root}/></div></details>
    </div>
  </details>;
}
