import { useQuota } from '@/modules/usage/hooks/useQuota';

/** Sidebar uses relay quota first and local subscriptions only when that source has no values. */
export function QuotaIndicator({ onOpen }: { onOpen: () => void }) {
  const { data, error, now } = useQuota();
  const age = (at?: string | null) => at && Number.isFinite(Date.parse(at)) ? `${Math.max(0, Math.floor((now - Date.parse(at)) / 60000))} 分钟前` : '尚无记录';
  const rows = (['claude', 'codex'] as const).map(provider => {
    const cache = provider === 'claude' ? data?.claude : data?.pool;
    const accounts = data?.pool?.data?.accounts || [];
    const primary = provider === 'claude' ? data?.claude.data?.windows || [] : accounts.flatMap(account => account.windows);
    const values = primary.filter(window => window.percent !== null && Number.isFinite(window.percent));
    const local = data?.local?.find(source => source.provider === provider);
    const localWindows = local?.windows.length ? local.windows : local?.lastSuccess?.windows;
    const localAt = local?.windows.length ? local.checkedAt : local?.lastSuccess?.checkedAt;
    const label = (value: string) => /7|week|周|天/i.test(value) ? '7天' : '5h';
    const windows=['5h','7天'].map(kind=>{
      const primaryValues=values.filter(window=>label(window.label)===kind);
      const fallback=localWindows?.find(window=>label(window.label)===kind&&(window.usedPercent!=null||window.remainingPercent!=null));
      const percent=primaryValues.length?Math.max(...primaryValues.map(window=>window.percent!))
        :fallback?fallback.usedPercent??100-fallback.remainingPercent!:null;
      return kind+' '+(percent===null?'—':percent+'%');
    }).join(' / ');
    const first=values[0];
    const percent=values.length?values[0].percent:localWindows?.some(w=>w.usedPercent!=null||w.remainingPercent!=null)?0:null;
    const at = first ? cache?.updatedAt : localAt;
    const failed = Boolean(error || (first ? cache?.error : local && local.status !== 'ok'));
    const stale = failed || !at || !Number.isFinite(Date.parse(at)) || now - Date.parse(at) > 900000
      || Boolean(first && (cache?.stale || (provider === 'codex' && accounts.some(account => account.usageStale))));
    return { provider, percent, windows, stale,
      detail: failed ? `读取失败（上次 ${age(at)}）` : age(at) };
  });
  const warnings = data?.pool?.data?.warnings || [];
  return <button type="button" data-testid="quota-indicator" onClick={onOpen} className={`mb-1 w-full rounded-lg px-2 py-1.5 text-left text-[11px] ${warnings.length ? 'bg-red-500/10 text-red-700 dark:text-red-300' : 'bg-muted/40 text-muted-foreground'}`}>
    <span className="flex flex-wrap gap-x-1">{rows.every(row => row.percent === null) ? '用量未连接 · 点击设置' : rows.map((row, index) => <span key={row.provider}>{index > 0 && <span aria-hidden="true"> · </span>}<span title={row.detail} className={row.stale ? 'opacity-60' : undefined}>{row.provider === 'claude' ? 'Claude' : 'Codex'} {row.windows}</span></span>)}</span>
    {warnings.map((warning, index) => <span key={index} className="mt-0.5 block break-words text-red-600 dark:text-red-300">{warning}</span>)}
  </button>;
}
