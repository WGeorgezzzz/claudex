import { useEffect, useState } from 'react';
import { api } from '@/shared/api';

type QuotaWindow = { label: string; remainingPercent?: number | null; remaining?: number; total?: number;
  unit?: string; resetsAt?: string | null; resetLabel?: string | null };
type QuotaSnapshot = { updatedAt: string | null; nextRunAt?: string; stale: boolean; intervalMinutes: number;
  reporter?: { status: string; summary: string } | null;
  providers: Array<{ provider: string; status: string; checkedAt: string; windows: QuotaWindow[]; sourceUrl?: string; note?: string;
    lastSuccess?: { checkedAt: string; windows: QuotaWindow[] } }> };
const LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', workbuddy: 'WorkBuddy', cursor: 'Cursor', opencode: 'OpenCode' };
const STATUS: Record<string, string> = { login_required: '需要登录', unavailable: '读取未成功', unsupported: '暂无统一额度来源' };
const dateLabel = (date?: string | null) => date ? new Date(date).toLocaleString() : '—';

/** ModelLibraryPanel displays independently collected account quotas, distinct from chat context/token counts. */
export function ProviderQuotaPanel() {
  // Cache reads poll without spending model quota; the background worker owns the 30-minute collection schedule.
  const [snapshot, setSnapshot] = useState<QuotaSnapshot | null>(null);
  // Authorization and transport failures never render a previous account's snapshot.
  const [error, setError] = useState<string | null>(null);
  // A login action opens a dedicated browser on the service host; the user, not the reporter model, enters credentials.
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const openLogin = async (provider: string) => {
    try {
      const response = await api.providers.openUsageLogin(provider);
      if (!response.ok) throw new Error('暂时无法打开登录窗口，可能已有检查或登录正在进行。');
      setLoginNotice('请在运行 GACI 的电脑上完成专用浏览器登录，然后关闭该窗口；定时任务会复用登录状态。');
    } catch (reason) { setLoginNotice(reason instanceof Error ? reason.message : '打开登录窗口失败。'); }
  };
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await api.providers.usageSnapshot();
        if (!response.ok) throw new Error(response.status === 403 ? '用量属于本机管理员账号。' : '暂时无法读取用量。');
        const body = await response.json();
        if (!disposed) { setSnapshot(body.data); setError(null); }
      } catch (reason) { if (!disposed) { setSnapshot(null); setError(reason instanceof Error ? reason.message : '读取失败'); } }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 60000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  return <section aria-label="账号剩余用量" className="shrink-0 rounded-xl border border-border bg-muted/20 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium">
      <span>账号剩余用量</span><span className="text-xs font-normal text-muted-foreground">WorkBuddy · DeepSeek · 每 30 分钟核对</span>
    </div>
    {loginNotice && <p role="status" className="mt-2 text-xs text-muted-foreground">{loginNotice}</p>}
    {error ? <p className="mt-2 text-xs text-muted-foreground">{error}</p> : !snapshot ? <p className="mt-2 text-xs">正在读取…</p>
      : !snapshot.providers.length ? <p className="mt-2 text-xs">等待首次用量检查。</p> : <>
        <p className="my-2 text-xs text-muted-foreground">更新于 {dateLabel(snapshot.updatedAt)}{snapshot.stale ? ' · 数据已过期' : ''}
          {snapshot.reporter?.status === 'error' ? ' · DeepSeek 核对未完成' : ''}</p>
        <div className="max-h-64 overflow-auto"><table className="w-full min-w-[420px] text-left text-xs">
          <thead><tr className="text-muted-foreground"><th className="pb-2 pr-3">软件</th><th className="pb-2 pr-3">剩余额度</th><th className="pb-2">重置时间</th></tr></thead>
          <tbody>{snapshot.providers.map(row => <tr key={row.provider} className="border-t border-border/50 align-top">
            <td className="py-2 pr-3">{row.sourceUrl ? <a className="underline underline-offset-2" target="_blank" rel="noreferrer" href={row.sourceUrl}>{LABELS[row.provider] || row.provider}</a> : LABELS[row.provider] || row.provider}</td>
            <td className="py-2 pr-3">{row.status === 'ok' ? row.windows.map((window, i) => <div key={i}>
              {window.label}：{window.remaining !== undefined ? `${window.remaining.toLocaleString()} ${window.unit || ''}`
                : window.remainingPercent != null ? `${Number(window.remainingPercent.toFixed(1))}%` : '未提供'}
            </div>) : <><span>{STATUS[row.status] || row.status}</span><p className="mt-1 max-w-72 text-muted-foreground">{row.note}</p>
              {row.status === 'login_required' && ['claude', 'cursor'].includes(row.provider) && <button type="button" className="mt-1 underline" onClick={() => void openLogin(row.provider)}>打开专用登录窗口</button>}
              {row.lastSuccess && <p className="mt-1 text-muted-foreground">上次成功：{dateLabel(row.lastSuccess.checkedAt)}（历史值）{row.lastSuccess.windows.map(w => ` ${w.label} ${w.remaining ?? w.remainingPercent ?? '—'}${w.unit || '%'}`).join('；')}</p>}</>}</td>
            <td className="py-2 text-muted-foreground">{row.status === 'ok' ? row.windows.map((window, i) => <div key={i}>{window.resetLabel || dateLabel(window.resetsAt)}</div>) : '—'}</td>
          </tr>)}</tbody>
        </table></div>
      </>}
  </section>;
}
