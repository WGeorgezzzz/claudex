import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Download, LogIn, RefreshCw } from 'lucide-react';
import { api } from '@/shared/api';
import type { AgentDiscoverySnapshot, LLMProvider } from '@/shared/types';
import { useAuth } from '@/modules/auth';
import { Button } from '@/shared/ui';

/** Settings and first-login onboarding show machine discovery with per-account authentication and administrator controls. */
export function AgentDiscoveryPanel({ onLogin }: { onLogin: (provider: LLMProvider) => void }) {
  const { user } = useAuth();
  const isAdmin = (user as {role?: string} | null)?.role === 'admin';
  // Preserve the last successful scan while a rescan or provider toggle is in flight.
  const [snapshot, setSnapshot] = useState<AgentDiscoverySnapshot | null>(null);
  // Disable duplicate operations and show request failures without losing discovery results.
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async (force = false) => {
    setPending(true); setError('');
    try {
      const response = await (force ? api.providers.rescan() : api.providers.discovery());
      if (!response.ok) throw new Error('扫描失败，请重试');
      setSnapshot(await response.json());
      window.dispatchEvent(new Event('nexagent:discovery-updated'));
    } catch (e) { setError(e instanceof Error ? e.message : '扫描失败'); }
    finally { setPending(false); }
  }, []);
  useEffect(() => {
    void refresh(true);
    const update = () => { void api.providers.discovery().then(async r => { if (r.ok) setSnapshot(await r.json()); }).catch(() => {}); };
    window.addEventListener('nexagent:discovery-updated', update);
    return () => window.removeEventListener('nexagent:discovery-updated', update);
  }, [refresh]);
  const toggle = async (id: string, enabled: boolean) => {
    setPending(true); setError('');
    try {
      const response = await api.providers.setDiscoveredEnabled(id, enabled);
      if (!response.ok) throw new Error('设置失败');
      setSnapshot(await response.json()); window.dispatchEvent(new Event('nexagent:discovery-updated'));
    } catch { setError('设置失败，请重试'); } finally { setPending(false); }
  };
  return <section data-testid="agent-discovery" className="min-w-0 border-b border-border pb-5">
    <div className="mb-3 flex items-center justify-between gap-3">
      <h3 className="text-sm font-semibold">本地 Agent</h3>
      <Button size="sm" variant="outline" onClick={() => void refresh(true)} disabled={pending}>
        <RefreshCw className={`mr-2 h-4 w-4 ${pending ? 'animate-spin' : ''}`} />重新扫描
      </Button>
    </div>
    {error && <p role="alert" className="mb-2 text-sm text-destructive">{error}</p>}
    {!snapshot && pending && <p className="text-sm text-muted-foreground">正在扫描…</p>}
    <div className="divide-y divide-border">
      {snapshot?.agents.map(agent => <div key={agent.id} data-testid={`discovered-${agent.id}`} className={`min-w-0 py-3 ${agent.installed ? '' : 'text-muted-foreground'}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{agent.name}</span>
          <span className="min-w-0 break-all text-xs text-muted-foreground">{agent.version}</span>
          {agent.enabled && <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label="已接入" />}
          {isAdmin && agent.supported && <label className="ml-auto flex items-center gap-2 text-xs">
            <input type="checkbox" checked={!agent.disabled} disabled={pending} onChange={e => void toggle(agent.id, e.target.checked)} aria-label={`启用 ${agent.name}`} />启用
          </label>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          <span>{!agent.installed ? '未安装' : !agent.supported ? '已发现，暂未支持接入' : agent.disabled ? '管理员已停用' : agent.authenticated ? '已接入' : '已安装，未登录'}</span>
          {agent.installed && agent.supported && !agent.authenticated && <Button size="sm" variant="ghost" onClick={() => onLogin(agent.id as LLMProvider)}><LogIn className="mr-1 h-3.5 w-3.5" />去登录</Button>}
        </div>
        {!agent.installed && <code className="mt-2 flex items-start gap-2 break-all rounded bg-muted px-2 py-1 text-xs"><Download className="mt-0.5 h-3 w-3 shrink-0" />{agent.installCommand}</code>}
        {isAdmin && agent.executable && <p className="mt-1 break-all text-xs text-muted-foreground">{agent.executable}</p>}
        {isAdmin && agent.configDirectory && <p className="mt-1 break-all text-xs text-muted-foreground">{agent.configDirectory} · {agent.sessionCount ?? 0} 个会话</p>}
      </div>)}
    </div>
    {snapshot && <p className="mt-3 text-xs text-muted-foreground">{new Date(snapshot.scannedAt).toLocaleString()}</p>}
  </section>;
}
