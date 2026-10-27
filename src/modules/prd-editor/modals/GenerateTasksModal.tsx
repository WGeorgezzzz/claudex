import { useState } from 'react';
import { X } from 'lucide-react';
import { api } from '@/shared/api';
import { useTaskMaster } from '@/modules/task-master';

type Props = { isOpen: boolean; fileName: string; onClose: () => void };
/** PRD editor requests task generation from the saved project document without opening a terminal. */
export default function GenerateTasksModal({ isOpen, fileName, onClose }: Props) {
  const { currentProject, refreshTasks } = useTaskMaster();
  // Network state drives a bounded ordinary progress indicator.
  const [busy, setBusy] = useState(false);
  // The result remains reviewable before the dialog is closed.
  const [result, setResult] = useState('');
  if (!isOpen) return null;
  return <div role="dialog" aria-label="生成任务" className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4"><div className="w-full max-w-md space-y-4 rounded-xl border bg-card p-6">
    <div className="flex justify-between"><h2 className="font-semibold">从需求生成任务</h2><button disabled={busy} onClick={onClose} aria-label="关闭"><X/></button></div>
    <p className="text-sm text-muted-foreground">请先保存 {fileName}。系统将整理待办并合并已有任务。</p>
    {busy && <div role="status"><progress className="w-full"/>正在分析需求和已有任务…</div>}
    {result && <p role="status" className="text-sm">{result}</p>}
    <button disabled={busy || !currentProject} className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" onClick={async () => {
      if (!currentProject) return; setBusy(true); setResult('');
      try { const r = await api.taskmaster.generatePrd(currentProject.projectId, fileName), data = await r.json(); if (!r.ok) throw new Error(data.message || data.error?.message || '生成失败'); await refreshTasks(); setResult(`已新增 ${data.created ?? 0} 项，更新 ${data.updated ?? 0} 项。`); }
      catch (e) { setResult(String(e)); } finally { setBusy(false); }
    }}>{busy ? '生成中…' : '生成任务'}</button>
  </div></div>;
}
