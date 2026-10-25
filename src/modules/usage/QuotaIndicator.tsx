import { useQuota } from '@/modules/usage/hooks/useQuota';

/** Sidebar footer links directly to the quota section and repeats critical administrator warnings. */
export function QuotaIndicator({ onOpen }: { onOpen: () => void }) {
  const { data, error, now } = useQuota();
  const claude = data?.claude.data?.windows[0]?.percent;
  const accounts = data?.pool?.data?.accounts;
  const percents = accounts?.flatMap(a => a.windows[0]?.percent === null ? [] : [a.windows[0]?.percent]).filter((v): v is number => typeof v === 'number');
  const codex = data?.key.data?.mode === 'unconfigured' ? '未配置中转' : percents?.length ? `${Math.max(...percents)}%` : data?.key.data?.mode === 'relay' ? 'Key 用量' : '未走中转';
  const warnings = data?.pool?.data?.warnings || [];
  const danger = warnings.length > 0 || (claude ?? 0) >= 95 || accounts?.some(a => !a.schedulable || a.windows.some(w => (w.percent ?? 0) >= 95));
  const old = error || accounts?.some(a => a.creditStale || a.usageStale) || [data?.claude, data?.pool, data?.key.data?.mode === 'relay' ? data.key : undefined].some(c => c && (c.stale || c.error || (c.updatedAt && now - Date.parse(c.updatedAt) > 900000)));
  return <button type="button" data-testid="quota-indicator" onClick={onOpen} className={`mb-1 w-full rounded-lg px-2 py-1.5 text-left text-[11px] ${danger ? 'bg-red-500/10 text-red-700 dark:text-red-300' : 'bg-muted/40 text-muted-foreground'}`}>
    <span className="block truncate">Claude 5h {claude === null || claude === undefined ? '—' : `${claude}%`} · Codex 5h {data ? codex : '—'}</span>
    {warnings.map((warning, i) => <span key={i} className="mt-0.5 block break-words">{warning}</span>)}{old && <span className="block">数据过期或刷新失败</span>}
  </button>;
}
