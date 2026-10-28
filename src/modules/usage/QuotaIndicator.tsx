import { useQuota } from '@/modules/usage/hooks/useQuota';

/** Retain each source independently, including disconnected and failed collectors. */
export function QuotaIndicator({ onOpen }: { onOpen: () => void }) {
  const { data, error, now } = useQuota();
  const age = (at?: string|null) => at && Number.isFinite(Date.parse(at)) ? Math.max(0, Math.floor((now-Date.parse(at))/60000))+' 分钟前' : '尚无记录';
  const rows = ['claude','codex'].map(provider => {
    const local = data?.local?.find(p => p.provider===provider);
    const windows = local?.windows.length ? local.windows : local?.lastSuccess?.windows;
    const at = local?.windows.length ? local.checkedAt : local?.lastSuccess?.checkedAt;
    if(local) return {provider, value: windows?.length ? windows.map(w=>w.label.replace(/^codex · /,'')+' '+(w.usedPercent!==null?'已用 '+w.usedPercent+'%':'剩余 '+w.remainingPercent+'%')).join(' · ') : '未连接', stale:!!error||local.status!=='ok'||!at||now-Date.parse(at)>900000,
      detail: (local.status!=='ok' ? (windows?.length?'读取失败（上次 '+age(at)+'）':'未连接') : age(at))+(local.note?' · '+local.note:'')};
    const cache = provider==='claude'?data?.claude:data?.pool;
    const values = provider==='claude'?data?.claude.data?.windows:data?.pool?.data?.accounts[0]?.windows;
    return {provider,value:values?.length?values.map(w=>w.label+' '+(w.percent===null?'未知':'已用 '+w.percent+'%')).join(' · '):'未连接',stale:!!error||!cache||cache.stale||!!cache.error,detail:cache?.error?'读取失败（上次 '+age(cache.updatedAt)+'）':age(cache?.updatedAt)};
  });
  return <button type="button" data-testid="quota-indicator" onClick={onOpen} className={'mb-1 w-full rounded-lg bg-muted/40 px-2 py-2 text-left text-[11px] '+(data?.pool?.data?.warnings.length?'text-red-700 dark:text-red-300':'text-muted-foreground')}>
    {rows.map(row=><span key={row.provider} className={'block py-0.5 '+(row.stale?'opacity-60':'')} title={row.detail}><strong className="font-medium">{row.provider==='claude'?'Claude':'Codex'}</strong> <span>{row.value}</span><span className="block text-[10px]">{row.value==='未连接'?'点击查看用量设置':row.detail.split(' · ')[0]}</span></span>)}
    {error&&<span className="block">读取失败，保留上次结果</span>}
    {data?.pool?.data?.warnings.map((warning,i)=><span key={i} className="mt-0.5 block break-words text-red-600">{warning}</span>)}
  </button>;
}
