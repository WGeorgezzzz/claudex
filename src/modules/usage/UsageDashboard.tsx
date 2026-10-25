import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Activity } from 'lucide-react';

import { useAuth } from '@/modules/auth';
import { api } from '@/shared/api';
import { Button } from '@/shared/ui';
import type { UsageCounts, UsageOverview, UsageUser } from '@/shared/types';
import { UsageChart } from '@/modules/usage/UsageChart';
import { QuotaPanel } from '@/modules/usage/QuotaPanel';

const compact=(n:number)=>n>=1e6?`${(n/1e6).toLocaleString(undefined,{maximumFractionDigits:1})}M`:n>=1e3?`${(n/1e3).toLocaleString(undefined,{maximumFractionDigits:1})}K`:n.toLocaleString();
function NumberValue({value}:{value:number}) {return <span title={value.toLocaleString()}>{compact(value)}</span>;}
/** Settings user management uses the single overview response for every row badge. */
export function UsageBadge({user,onClick}:{user:UsageUser;onClick:()=>void}) {
  const {t}=useTranslation('settings');
  return <button type="button" onClick={onClick} className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-700 hover:bg-blue-500/20 dark:text-blue-300"
    title={['today','last7d','last30d'].map(k=>{const c=user[k as 'today'];return `${t(`usage.${k}`)}: ${c.total.toLocaleString()} tokens / ${c.requests.toLocaleString()} ${t('usage.requests')}`;}).join('\n')}>
    {t('usage.badge',{value:compact(user.last30d.total)})}
  </button>;
}
/** Settings exposes account-scoped usage with an administrator drilldown from the account list. */
export function UsageDashboard({selectedUserId,onSelectUser}:{selectedUserId?:number;onSelectUser:(id:number|undefined)=>void}) {
  const {t}=useTranslation('settings'),{user}=useAuth(),admin=(user as {role?:string}|null)?.role==='admin';
  // Filters are local to this dashboard and never modify server account preferences.
  const [range,setRange]=useState('30d');
  // User drilldown starts grouped by model for an immediate breakdown.
  const [groupBy,setGroupBy]=useState(selectedUserId?'model':admin?'user':'provider');
  // Chart metric affects presentation while preserving the same normalized API response.
  const [metric,setMetric]=useState<keyof UsageCounts>('total');
  // Rendering mode shares one accessible SVG and legend state.
  const [area,setArea]=useState(false);
  // Latest response is replaced atomically after each refresh.
  const [data,setData]=useState<UsageOverview|null>(null);
  // A pending request disables refresh; polling resumes only while scanning.
  const [busy,setBusy]=useState(false);
  // Request failures are displayed inline while retaining the last good result.
  const [error,setError]=useState('');
  // Ranking column and direction allow deterministic table ordering.
  const [sort,setSort]=useState({key:'last30d',descending:true});
  const load=useCallback(async(signal?:AbortSignal)=>{
    setBusy(true);setError('');try{const response=await api.usage.overview({range,groupBy,userId:admin?selectedUserId:undefined});const body=await response.json();if(signal?.aborted)return;if(!response.ok)throw Error(body.error||t('usage.failed'));setData(body);}
    catch(e){if(!signal?.aborted)setError(e instanceof Error?e.message:String(e));}finally{if(!signal?.aborted)setBusy(false);}
  },[range,groupBy,selectedUserId,admin,t]);
  useEffect(()=>{const c=new AbortController();queueMicrotask(()=>{if(!c.signal.aborted)void load(c.signal);});return()=>c.abort();},[load]);
  useEffect(()=>{if(!data?.scanning)return;const c=new AbortController();const timer=setTimeout(()=>void load(c.signal),1500);return()=>{c.abort();clearTimeout(timer);};},[data,load]);
  const columns=['username','role','today','last7d','last30d','topModel','lastActiveAt'];
  const rows=[...(data?.perUser||[])].sort((a,b)=>{const value=(u:UsageUser)=>['today','last7d','last30d'].includes(sort.key)?u[sort.key as 'today'].total:String(u[sort.key as 'username']||'');const av=value(a),bv=value(b);return (typeof av==='number'&&typeof bv==='number'?av-bv:String(av).localeCompare(String(bv)))*(sort.descending?-1:1);});
  const selectClass='h-9 min-w-0 max-w-full rounded-lg border border-border bg-background pl-2 pr-7 text-xs text-foreground';
  return <section className="space-y-5 text-foreground" data-testid="usage-dashboard">
    <QuotaPanel/>
    <header><div className="flex items-center gap-2"><Activity size={20} className="text-blue-500"/><h2 className="text-lg font-semibold">{t('mainTabs.usage')}</h2></div><p className="mt-1 text-xs text-muted-foreground">{t('usage.description')}</p></header>
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label={t('usage.range')} className={selectClass} value={range} onChange={e=>setRange(e.target.value)}>{['24h','7d','30d','90d'].map(r=><option key={r} value={r}>{t(`usage.range_${r}`)}</option>)}</select>
      <select aria-label={t('usage.group')} className={selectClass} value={groupBy} onChange={e=>setGroupBy(e.target.value)}>{(admin?['user','provider','model']:['provider','model']).map(g=><option key={g} value={g}>{t(`usage.group_${g}`)}</option>)}</select>
      <select aria-label={t('usage.metric')} className={selectClass} value={metric} onChange={e=>setMetric(e.target.value as keyof UsageCounts)}>{['total','input','output','cacheRead','requests'].map(m=><option key={m} value={m}>{t(`usage.${m}`)}</option>)}</select>
      <Button size="sm" variant="outline" onClick={()=>void load()} disabled={busy}><RefreshCw size={14}/>{t('usage.refresh')}</Button>
      {admin&&<Button size="sm" variant="outline" disabled={busy||data?.scanning} onClick={()=>{setBusy(true);void api.usage.rescan().then(async r=>{if(!r.ok)throw Error(t('usage.failed'));await load();}).catch(e=>{setError(String(e));setBusy(false);});}}>{t('usage.rescan')}</Button>}
      <span className="w-full text-[11px] text-muted-foreground">{data?.scanning?t('usage.scanning'):t('usage.updated',{time:data?.scannedAt?new Date(data.scannedAt).toLocaleString():'—'})}</span>
    </div>
    {selectedUserId&&admin&&<div className="flex flex-wrap items-center gap-2 text-xs"><span>{t('usage.filtered',{name:data?.perUser.find(u=>u.userId===selectedUserId)?.username||String(selectedUserId)})}</span><button className="text-blue-600 dark:text-blue-400" onClick={()=>onSelectUser(undefined)}>{t('usage.clear')}</button></div>}
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">{(['requests','total','input','output'] as const).map(k=><div key={k} className="min-w-0 rounded-xl border border-border bg-card p-3"><div className="text-xs text-muted-foreground">{t(`usage.${k}`)}</div><div className="mt-2 text-xl font-semibold tabular-nums"><NumberValue value={data?.totals[k]||0}/></div>{(k==='input'||k==='output')&&<div className="mt-1 text-[10px] text-muted-foreground">{t(`usage.${k==='input'?'cacheRead':'cacheWrite'}`)} <NumberValue value={data?.totals[k==='input'?'cacheRead':'cacheWrite']||0}/></div>}</div>)}</div>
    <div className="space-y-2"><div className="flex items-center justify-between"><h3 className="text-sm font-medium">{t('usage.chart')}</h3><button className="rounded-md border border-border px-2 py-1 text-xs" aria-pressed={area} onClick={()=>setArea(!area)}>{t(area?'usage.area':'usage.line')}</button></div><UsageChart series={data?.series||[]} buckets={data?.buckets||[]} metric={metric} area={area}/></div>
    <div><h3 className="mb-2 text-sm font-medium">{t('usage.ranking')}</h3><div className="overflow-x-auto rounded-xl border border-border"><table className="w-full min-w-[620px] text-left text-xs"><thead className="bg-muted/40"><tr>{columns.map(k=><th key={k} className="whitespace-nowrap p-2" aria-sort={sort.key===k?(sort.descending?'descending':'ascending'):'none'}><button onClick={()=>setSort({key:k,descending:sort.key===k?!sort.descending:true})}>{t(`usage.${k}`)} {sort.key===k?(sort.descending?'↓':'↑'):''}</button></th>)}</tr></thead><tbody>{rows.map(u=><tr key={u.userId} tabIndex={0} aria-label={t('usage.filtered',{name:u.username})} onClick={()=>{if(admin){onSelectUser(u.userId);setGroupBy('model');}}} onKeyDown={e=>{if(admin&&e.key==='Enter'){onSelectUser(u.userId);setGroupBy('model');}}} className="cursor-pointer border-t border-border hover:bg-muted/40"><td className="p-2 font-medium">{u.username}{!u.isActive&&<span className="ml-1 text-amber-600">{t('usage.disabled')}</span>}</td><td className="p-2">{t(u.role==='admin'?'users.admin':'users.member')}</td>{(['today','last7d','last30d'] as const).map(k=><td key={k} className="whitespace-nowrap p-2"><NumberValue value={u[k].total}/><div className="mt-0.5 text-[10px] text-muted-foreground"><NumberValue value={u[k].requests}/> {t('usage.requests')}</div></td>)}<td className="max-w-32 truncate p-2" title={u.topModel||''}>{u.topModel||'—'}</td><td className="whitespace-nowrap p-2">{u.lastActiveAt?new Date(u.lastActiveAt).toLocaleString():'—'}</td></tr>)}</tbody></table></div></div>
  </section>;
}
