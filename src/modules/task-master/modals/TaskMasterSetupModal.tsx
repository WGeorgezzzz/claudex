import { useEffect, useState } from 'react';
import { CheckCircle, ListChecks, X } from 'lucide-react';
import { api } from '@/shared/api';
import type { TaskMasterProject } from '@/shared/types';

type Props = { isOpen: boolean; project: TaskMasterProject | null; onClose: () => void; onAfterClose?: (() => void) | null };
/** Task board and chat banner initialize projects through an ordinary authenticated request. */
export default function TaskMasterSetupModal({ isOpen, project, onClose, onAfterClose }: Props) {
  // Request outcome drives progress, readable failures and retry availability.
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  // Failure text stays visible until the user retries or closes the dialog.
  const [error, setError] = useState('');
  useEffect(() => { if (isOpen) { setState('idle'); setError(''); } }, [isOpen, project?.projectId]);
  if (!isOpen || !project) return null;
  const initialize = async () => {
    setState('busy'); setError('');
    try {
      const response = await api.taskmaster.initialize(project.projectId), result = await response.json();
      if (!response.ok) throw new Error(result.message || result.error?.message || '初始化失败，请检查项目写入权限。');
      setState('done'); onAfterClose?.();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '初始化失败'); setState('idle'); }
  };
  return <div role="dialog" aria-label="初始化任务管理" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
    <div className="w-full max-w-lg rounded-xl border bg-card p-6 shadow-xl">
      <div className="flex items-center justify-between"><h2 className="flex gap-2 text-lg font-semibold"><ListChecks/>初始化任务管理</h2><button disabled={state === 'busy'} onClick={onClose} aria-label="关闭"><X/></button></div>
      <p className="my-4 text-sm text-muted-foreground">为 {project.displayName} 创建空任务集和模型设置。无需填写密钥，随后即可从聊天整理任务。</p>
      <ol className="my-4 space-y-2 text-sm"><li>1. 创建项目任务目录</li><li>2. 保留已有任务和配置</li><li>3. 准备对话任务管理</li></ol>
      {state === 'busy' && <div role="status" className="my-4"><progress className="w-full"/>正在准备项目任务集…</div>}
      {error && <p role="alert" className="my-4 text-sm text-red-500">{error}</p>}
      {state === 'done' ? <div className="flex items-center justify-between text-green-600"><span className="flex gap-2"><CheckCircle/>已准备好</span><button onClick={onClose}>完成并继续</button></div> : <button disabled={state === 'busy'} onClick={() => void initialize()} className="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{state === 'busy' ? '正在初始化…' : error ? '重试初始化' : '一键初始化'}</button>}
    </div>
  </div>;
}
