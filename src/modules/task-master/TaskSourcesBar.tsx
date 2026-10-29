import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ChevronDown, Loader2, Play } from 'lucide-react';
import { inboxTasksApi } from '@/shared/api';

type Source = { id:string; name:string; status:string; count:number; taskCount:number; lastSyncedAt:string|null; error:string|null; note?:string };
type Sources = { sources:Source[]; infohub:{phase:string; running:boolean; online:boolean; error:string|null; idleMinutes:number; idleDeadline:string|null; progress:{completed:number;total:number}} };
const phaseNames:Record<string,string>={starting:'正在启动',collecting:'增量读取消息',syncing:'同步到任务',idle:'运行中',error:'同步失败',stopped:'未运行'};
async function read<T>(response:Response):Promise<T>{const result=await response.json();if(!response.ok)throw Error(result.message||result.error?.message||'来源请求失败');return result;}

/** IntelligentTasksPanel displays observed source health and explicitly starts the optional message collector. */
export function TaskSourcesBar({onSynced,showSettings=false}:{onSynced:()=>void;showSettings?:boolean}) {
  // Source observations are independent of model organization and never imply a complete import.
  const [data,setData]=useState<Sources|null>(null);
  // Only the selected source opens an explanation, keeping the strip compact on phones.
  const [selected,setSelected]=useState<string|null>(null);
  // Local transport errors remain visible even when upstream health cannot be read.
  const [error,setError]=useState('');
  // Prevent duplicate clicks while the launch request is in transit.
  const [submitting,setSubmitting]=useState(false);
  const callback=useRef(onSynced);callback.current=onSynced;
  const previousPhase=useRef('');
  const load=useCallback(async()=>{try{const next=await read<Sources>(await inboxTasksApi.sources());setData(next);setError('');if(next.infohub.phase==='idle'&&previousPhase.current!=='idle')callback.current();previousPhase.current=next.infohub.phase;}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}},[]);
  const busy=!!data&&['starting','collecting','syncing'].includes(data.infohub.phase);
  useEffect(()=>{void load();const timer=setInterval(()=>{if(!document.hidden)void load();},busy?2000:30000);return()=>clearInterval(timer);},[load,busy]);
  const start=async()=>{setSubmitting(true);try{await read(await inboxTasksApi.startInfohub());await load();}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setSubmitting(false);}};
  const chosen=data?.sources.find(source=>source.id===(showSettings?'infohub':selected));
  return <section aria-label="来源状态" className="shrink-0 border-b bg-muted/20 px-3 py-2">
    <div className="flex items-center gap-1.5 text-[11px]">
      <span className="shrink-0 font-medium text-muted-foreground">来源</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto whitespace-nowrap py-0.5">
      {data?.sources.map(source=>{const failed=['error','disabled','unknown'].includes(source.status)||/authorization|token_missing|失败/i.test(source.error||''),offline=['offline','stopped'].includes(source.status);return <button key={source.id} aria-expanded={selected===source.id} aria-label={source.name+'来源状态'} onClick={()=>setSelected(selected===source.id?null:source.id)} className="flex min-h-7 shrink-0 items-center gap-1 rounded-md border bg-background px-2 hover:bg-muted">
        <span aria-hidden className={'h-1.5 w-1.5 rounded-full '+(failed?'bg-destructive':offline?'bg-slate-400':'bg-emerald-500')}/><span>{source.name}</span><span className="tabular-nums text-muted-foreground">{source.count}</span>{source.id==='infohub'&&<span className="text-muted-foreground">{data.infohub.online?(phaseNames[data.infohub.phase]||'运行中'):'未运行'}</span>}<ChevronDown size={10}/>
      </button>;})}
      </div>
      <button disabled={submitting||busy} onClick={()=>void start()} className="flex min-h-8 shrink-0 items-center gap-1 rounded-md border bg-background px-2 text-xs disabled:opacity-60">{busy||submitting?<Loader2 size={12} className="animate-spin"/>:<Play size={12}/>} {busy?`${phaseNames[data!.infohub.phase]} ${data!.infohub.progress.completed}/${data!.infohub.progress.total}`:'启动并同步'}</button>
    </div>
    {(error||data?.infohub.error)&&<p role="alert" className="mt-1 flex items-start gap-1 text-xs text-destructive"><AlertCircle size={12} className="mt-0.5 shrink-0"/>{error||data?.infohub.error}</p>}
    {chosen&&<div className="mt-2 space-y-1 rounded-md border bg-background p-3 text-xs" role="region" aria-label={chosen.name+'来源详情'}>
      <p className="font-medium">{chosen.name} · {chosen.count} 条来源记录 · {chosen.taskCount} 条关联任务</p>
      <p>最后同步／更新：{chosen.lastSyncedAt?new Date(chosen.lastSyncedAt).toLocaleString('zh-CN'):'尚无记录'}</p>
      {chosen.error&&<p className="break-words text-destructive">{chosen.error}</p>}{chosen.note&&<p className="text-muted-foreground">{chosen.note}</p>}
      {['infohub','lark','wechat'].includes(chosen.id)&&<><p>飞书需完成用户授权；微信需先打开客户端并登录。<a className="text-primary underline" href="/infohub" target="_blank" rel="noreferrer">打开信息看板</a></p><label className="flex items-center gap-2">空闲退出（分钟）<input aria-label="信息看板空闲退出分钟" type="number" min="1" max="1440" key={data?.infohub.idleMinutes} defaultValue={data?.infohub.idleMinutes||10} className="w-20 rounded border bg-background p-1" onBlur={async event=>{const minutes=Number(event.target.value);if(!Number.isInteger(minutes)||minutes<1||minutes>1440){setError('空闲退出时间须为 1–1440 分钟');return;}try{await read(await inboxTasksApi.saveInfohubSettings(minutes));await load();}catch(cause){setError(String(cause));}}}/></label>{data?.infohub.idleDeadline&&<p>预计退出：{new Date(data.infohub.idleDeadline).toLocaleTimeString('zh-CN')}</p>}</>}
    </div>}
  </section>;
}
