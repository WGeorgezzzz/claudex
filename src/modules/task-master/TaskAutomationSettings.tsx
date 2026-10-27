import { useCallback, useEffect, useState } from 'react';
import { api } from '@/shared/api';
import type { TaskMasterAutoSettings } from '@/shared/types';

type Props = { root?: string | null };
/** Settings and the conversation task panel share account and per-project automation controls. */
export function TaskAutomationSettings({ root }: Props) {
  // Server-owned preferences are edited only after hydration succeeds.
  const [settings, setSettings] = useState<TaskMasterAutoSettings | null>(null);
  // Network errors are shown inline instead of silently losing a settings change.
  const [error, setError] = useState('');
  const load = useCallback(async () => { try { const r = await api.taskmaster.autoSettings(); if (!r.ok) throw new Error('无法读取任务设置'); setSettings(await r.json()); } catch (e) { setError(String(e)); } }, []);
  useEffect(() => { void load(); }, [load]);
  const save = async (next: TaskMasterAutoSettings) => { try { const r = await api.taskmaster.saveAutoSettings(next); if (!r.ok) throw new Error('保存失败'); setSettings(await r.json()); setError(''); } catch (e) { setError(String(e)); } };
  if (!settings) return <p className="text-xs text-muted-foreground">{error || '正在读取任务设置…'}</p>;
  return <div className="space-y-3 text-sm">
    <label className="flex items-center gap-2"><input type="checkbox" checked={settings.enabled} onChange={e => void save({ ...settings, enabled: e.target.checked })}/>自动从对话整理任务（默认开启）</label>
    <label className="flex items-center gap-2"><input type="checkbox" checked={settings.suggestOnly} onChange={e => void save({ ...settings, suggestOnly: e.target.checked })}/>只建议，确认后才写入任务</label>
    {root && <label className="flex items-center gap-2"><input type="checkbox" checked={!settings.disabledProjects.includes(root)} onChange={e => void save({ ...settings, disabledProjects: e.target.checked ? settings.disabledProjects.filter(p => p !== root) : [...settings.disabledProjects, root] })}/>在此项目自动整理</label>}
    <p className="text-xs text-muted-foreground">回复结束并空闲 90 秒后增量整理；低置信度保留为建议。无项目对话跳过。每次更改可在记录中撤销。</p>
    {error && <p role="alert" className="text-red-500">{error}</p>}
  </div>;
}
