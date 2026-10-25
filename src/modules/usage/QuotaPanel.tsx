import type { QuotaCache, QuotaWindow } from '@/shared/types';
import { useQuota } from '@/modules/usage/hooks/useQuota';

function Freshness({ value, now }: { value: QuotaCache<unknown>; now: number }) {
  const stale = value.stale || !value.updatedAt || now - Date.parse(value.updatedAt) > 900000;
  return <p className={`mt-2 text-xs ${stale || value.error ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
    {value.error && <span role="alert">{value.error} · </span>}{stale && '数据已过期 · '}
    {value.updatedAt ? `刷新于 ${new Date(value.updatedAt).toLocaleString()}` : '尚无成功数据'}
  </p>;
}
function WindowBar({ value, paused = false, now }: { value: QuotaWindow; paused?: boolean; now: number }) {
  const danger = paused || (value.percent !== null && value.percent >= 95);
  const color = danger ? 'bg-red-500' : value.severity === 'warning' ? 'bg-amber-500' : 'bg-emerald-500';
  const minutes = value.resetsAt ? Math.max(0, Math.ceil((Date.parse(value.resetsAt) - now) / 60000)) : null;
  return <div className="min-w-0 space-y-1.5">
    <div className="flex items-center justify-between gap-2 text-sm"><span>{value.label}</span><strong className={danger ? 'text-red-600 dark:text-red-400' : ''}>{value.percent === null ? '未知' : `${value.percent}%`}</strong></div>
    <div role="progressbar" aria-label={value.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value.percent ?? undefined} className="h-1.5 overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, Math.max(0, value.percent ?? 0))}%` }}/></div>
    <p className="break-words text-[11px] text-muted-foreground">{value.resetsAt ? `${new Date(value.resetsAt).toLocaleString()} · ${minutes ? `还有 ${minutes} 分钟` : '已到重置时间'}` : '重置时间未知'}</p>
    {value.stats && <p className="text-[11px] text-muted-foreground">{value.stats.requests ?? '—'} 请求 · {value.stats.tokens?.toLocaleString() ?? '—'} token · ${value.stats.cost ?? '—'}</p>}
  </div>;
}
/** UsageDashboard places subscription and relay quota above the existing usage charts. */
export function QuotaPanel() {
  const { data, error, busy, refresh, now } = useQuota();
  const pool = data?.pool?.data, key = data?.key.data;
  return <section id="quota" data-testid="quota-panel" className="space-y-3 rounded-xl border border-border bg-muted/10 p-3 sm:p-4">
    <header className="flex items-center justify-between gap-2"><div><h2 className="text-base font-semibold">额度</h2><p className="mt-1 text-xs text-muted-foreground">订阅窗口与中转用量 · 只读同步</p></div><button type="button" onClick={() => void refresh()} disabled={busy} className="shrink-0 rounded-lg border border-border px-2 py-1.5 text-xs">{busy ? '刷新中…' : '刷新额度'}</button></header>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {pool && pool.warnings.length > 0 && <div role="alert" className="space-y-1 rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-300">{pool.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</div>}
    <article className="rounded-lg border border-border bg-card p-3"><h3 className="mb-3 text-sm font-semibold">Claude 订阅</h3><div className="grid gap-4 sm:grid-cols-2">{data?.claude.data?.windows.map((w, i) => <WindowBar key={i} now={now} value={w}/>)}</div><p className="mt-3 text-xs text-muted-foreground">额外用量：{data?.claude.data ? data.claude.data.extraUsageEnabled ? '已开启' : '关闭' : '未知'}</p>{data && <Freshness now={now} value={data.claude}/>}</article>
    {data?.pool && <article className="rounded-lg border border-border bg-card p-3"><h3 className="text-sm font-semibold">Codex 中转 · 上游账号</h3><p className="mt-1 text-xs text-muted-foreground">自动暂停阈值：5h {pool?.thresholds.fiveHour ?? '未知'} · 7 天 {pool?.thresholds.sevenDay ?? '未知'}</p>
      <div className="divide-y divide-border">{pool?.accounts.map(a => <div key={a.id} data-testid={`quota-account-${a.id}`} className="space-y-3 py-3"><div className="flex flex-wrap items-center justify-between gap-2 text-sm"><strong>{a.name}</strong><span className={a.schedulable && a.status === 'active' ? 'text-emerald-600' : 'text-red-600'}>{!a.schedulable ? '已暂停调度（可能自动暂停）' : a.status === 'active' ? '可调度' : a.status}</span></div><div className="grid gap-4 sm:grid-cols-2">{a.windows.map((w, i) => <WindowBar key={i} now={now} value={w} paused={!a.schedulable || a.status !== 'active'}/>)}</div><p className="break-all text-xs">点数余额 {a.balance ?? '未知'} · 本次变化 {a.balanceChange ?? '未检测到变化'}</p><p className="text-[11px] text-muted-foreground">用量采样 {a.usageUpdatedAt ? new Date(a.usageUpdatedAt).toLocaleString() : '未知'}{a.usageStale && ' · 数据已过期'}</p><p className={`text-[11px] ${a.creditStale ? 'text-amber-600' : 'text-muted-foreground'}`}>点数采样 {a.creditUpdatedAt ? new Date(a.creditUpdatedAt).toLocaleString() : '未知'}{a.creditStale && ' · 数据已过期，不能据此证明点数未消耗'}</p></div>)}</div><Freshness now={now} value={data.pool}/></article>}
    <article className="rounded-lg border border-border bg-card p-3"><h3 className="text-sm font-semibold">Codex 中转 · 我的 Key</h3>{key?.mode === 'not_relay' ? <p className="mt-2 text-sm">未走中转</p> : key && <><div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">{(['today', 'last7d', 'last30d'] as const).map((range, i) => <div key={range} className="rounded-lg bg-muted/40 p-2 text-xs"><strong>{['今日', '7 天', '30 天'][i]}</strong><p className="mt-1">{key[range]?.requests ?? '—'} 请求</p><p>{key[range]?.tokens?.toLocaleString() ?? '—'} token</p><p>${key[range]?.cost ?? '—'}</p>{!key[range] && <p>上游未提供统计</p>}</div>)}</div><p className="mt-2 break-words text-xs">余额 {key.balance ?? '—'} · 剩余 {key.remaining ?? '—'} · 限额 {key.quota ?? '—'} {key.unit}</p></>}{data && key?.mode !== 'not_relay' && <Freshness now={now} value={data.key}/>}</article>
  </section>;
}
