import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Repeat, X } from 'lucide-react';

import { api } from '@/shared/api';
import { MonitorScheduleFields } from '@/shared/ui';
import { useMonitorCapabilities } from '@/shared/hooks/useMonitorCapabilities';
import type { MonitorCalendarSchedule, MonitorListSummary as Monitor, MonitorProbeSpec, MonitorRunReceipt as Run } from '@/shared/types';


async function readResult(response: Response) {
  const payload=await response.json();
  if(!response.ok) throw new Error(typeof payload?.error==='string'?payload.error:payload?.error?.message||payload?.message||`HTTP ${response.status}`);
  return payload.data;
}

/** Used by ChatComposer to create and manage durable checks for the selected Claude session. */
export function MonitorPanel({sessionId,draft,options}:{sessionId:string|null;draft:string;options:Record<string,unknown>}) {
  // The dialog is local to the composer and leaves the current message draft untouched.
  const [open,setOpen]=useState(false);
  // Server snapshots are refreshed while the panel is open; they are never reused across sessions.
  const [rows,setRows]=useState<Monitor[]>([]);
  // Creation fields remain editable when validation or network requests fail.
  const [name,setName]=useState('定期检查');
  const [content,setContent]=useState('');
  const [minutes,setMinutes]=useState(30);
  const [monitorModel,setMonitorModel]=useState(typeof options.model==='string'&&/^(gpt-|o\d|codex)/.test(options.model)?options.model:'claude-sonnet-5-5');
  // Optional JSON is sent only when the user explicitly supplies a zero-token probe.
  const [probeJson,setProbeJson]=useState('');
  // The chosen recurrence is submitted with explicit wall-clock time and timezone.
  const [schedule,setSchedule]=useState<MonitorCalendarSchedule|null>(null);
  const calendarEnabled=useMonitorCapabilities(open);
  // One request at a time prevents double creation from repeated clicks.
  const [pending,setPending]=useState(false);
  // Errors are surfaced instead of silently dismissing a failed action.
  const [error,setError]=useState('');
  // Expand only one task's bounded execution history at a time.
  const [history,setHistory]=useState<{id:string;runs:Run[]}|null>(null);
  // Each row keeps an editable JSON copy so callers can inspect and change probes without opening another screen.
  const [probeDrafts,setProbeDrafts]=useState<Record<string,string>>({});
  // Older async responses cannot paint over a newly selected session.
  const currentSession=useRef(sessionId);
  currentSession.current=sessionId;
  useEffect(()=>{setOpen(false);},[sessionId]);
  const reload=async()=>{
    if(!sessionId)return;
    const data:Monitor[]=[];let offset=0;
    while(true){const response=await api.monitors.list(sessionId,offset);data.push(...await readResult(response));const next=response.headers?.get('X-Next-Offset');if(!next)break;offset=Number(next);}
    if(currentSession.current===sessionId){setRows(data);setProbeDrafts(previous=>{const next={...previous};for(const row of data)if(next[row.id]===undefined)next[row.id]=row.probe?JSON.stringify(row.probe,null,2):'';return next;});}
  };
  useEffect(()=>{
    setRows([]);setHistory(null);setProbeDrafts({});setProbeJson('');setError('');
    if(!open||!sessionId)return;
    let live=true;
    const load=()=>void reload().catch(e=>{if(live)setError(String(e.message));});
    load();const timer=setInterval(load,5000);
    return ()=>{live=false;clearInterval(timer);};
  // options and draft do not affect the persisted monitor list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[open,sessionId]);
  useEffect(()=>{if(!open)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape')setOpen(false);};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[open]);
  const perform=async(action:()=>Promise<void>)=>{
    setPending(true);setError('');
    try{await action();await reload();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setPending(false);}
  };
  const parseProbe=(raw:string):MonitorProbeSpec|null=>{
    if(!raw.trim())return null;
    const parsed=JSON.parse(raw);if(!parsed||!Array.isArray(parsed.items)||parsed.items.length===0)throw new Error('探针 JSON 必须包含 items 数组。');return parsed as MonitorProbeSpec;
  };
  const saveProbe=async(row:Monitor)=>{
    const raw=probeDrafts[row.id]?.trim()||'';
    await readResult(await api.monitors.update(row.id,{name:row.name,content:row.content,intervalMinutes:row.intervalMinutes||30,schedule:row.schedule,probe:parseProbe(raw)}));
  };
  const statusLabel=(row:Monitor)=>row.status==='active'?'已启用':row.status==='paused'?'已暂停':'已停止';
  const scheduleLabel=(row:Monitor)=>row.schedule?`${row.schedule.frequency==='daily'?'每天':'每周'} ${row.schedule.time}（${row.schedule.timeZone}）`:'按间隔运行';
  const button='rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50';
  return <>
    <button type="button" title="定期监测" aria-label="定期监测" onClick={()=>{setContent(draft);setOpen(true);}} className="flex h-8 items-center gap-1 rounded-lg border border-border/60 px-2 text-xs text-muted-foreground hover:bg-muted"><Repeat size={15}/><span className="hidden sm:inline">监测</span></button>
    {open && createPortal(<div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4" onClick={event=>{if(event.target===event.currentTarget)setOpen(false);}}>
      <section role="dialog" aria-modal="true" aria-label="定期监测" className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-xl border bg-background p-5 text-foreground shadow-xl">
        <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">定期监测</h2><button type="button" aria-label="关闭监测面板" onClick={()=>setOpen(false)}><X size={20}/></button></div>
        <p className="my-2 text-xs text-muted-foreground">由本机服务定时执行，关闭聊天页面仍有效。电脑需保持开机且服务运行。会话忙时等待，不打断当前任务；失败保留记录并自动退避重试，最长间隔 30 分钟。手动暂停和停止不会自动恢复。</p>
        <p className="text-xs text-muted-foreground">间隔从每轮结束后计算；日历按指定时间执行。停机错过后最多补一次，不集中补跑。暂停或停止不取消正在执行的一轮。</p>
        {!sessionId?<p className="mt-4">请先在 Claude 中发送一条消息建立会话，再添加监测。</p>:<>
          <form className="my-4 space-y-2 rounded-lg border p-3" onSubmit={event=>{event.preventDefault();if(schedule&&!calendarEnabled){setError('当前服务尚未确认支持日历调度。');return;}void perform(async()=>{await readResult(await api.monitors.create({sessionId,name,content,intervalMinutes:minutes,...(schedule?{schedule}:{}),...(probeJson.trim()?{probe:parseProbe(probeJson)}:{}),options:{...options,model:monitorModel,effort:'medium'}}));setContent('');});}}>
            <label className="block text-sm">监测模型<input aria-label="监测模型" value={monitorModel} onChange={event=>setMonitorModel(event.target.value)} required className="mt-1 block w-full rounded border bg-background p-2"/></label>
            <label className="block text-sm">名称<input aria-label="监测名称" maxLength={120} required value={name} onChange={event=>setName(event.target.value)} className="mt-1 block w-full rounded border bg-background p-2"/></label>
            <label className="block text-sm">检查内容<textarea aria-label="检查内容" maxLength={20000} required rows={3} value={content} onChange={event=>setContent(event.target.value)} placeholder="例如：检查任务进度，只读日志；有变化、完成或失败时说明。" className="mt-1 block w-full rounded border bg-background p-2"/></label>
            <label className="block text-sm">探针 JSON（可选，零 token）<textarea aria-label="探针 JSON" rows={3} value={probeJson} onChange={event=>setProbeJson(event.target.value)} placeholder={'{"intervalMinutes":3,"items":[{"type":"file","path":"STATUS.md","read":"tail"}]}' } className="mt-1 block w-full rounded border bg-background p-2 font-mono text-xs"/></label>
            <MonitorScheduleFields value={schedule} onChange={setSchedule} minutes={minutes} onMinutesChange={setMinutes} intervalLabel="监测间隔（分钟）" disabled={pending} calendarEnabled={calendarEnabled}/>
            <button disabled={pending} type="submit" className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">添加监测</button>
            <p className="text-xs text-muted-foreground">{schedule?'首次时间将在保存后按日历规则显示。':`首次将在 ${Number.isFinite(minutes)?minutes:30} 分钟后执行。`}默认 Sonnet 5.5，沿用当前权限；无变化时跳过模型，最长每 60 分钟真实检查一次。</p>
          </form>
          {rows.length===0&&<p className="text-sm text-muted-foreground">本会话还没有监测任务。</p>}
          <div className="space-y-3">{rows.map(row=><article key={row.id} className="rounded-lg border p-3">
            <div className="flex justify-between"><strong>{row.name}{row.createdByUserDelegation&&<small title={row.createdByUserDelegation.sourceUserMessageId}>{'由会话'} {row.createdByUserDelegation.sourceSessionId} {'代用户创建'}</small>}</strong><span className="text-xs">{statusLabel(row)} · 已执行 {row.lastRun?.count??row.run_count??0} 次</span></div>
            <p className="my-1 whitespace-pre-wrap text-sm">{row.content}</p>
            <p className="text-xs text-muted-foreground">{scheduleLabel(row)}{row.status==='active'&&row.nextRunAt?` · 下次 ${new Date(row.nextRunAt).toLocaleString('zh-CN')}`:''}</p>
             <p className="text-xs text-muted-foreground">模式：{row.mode==='event'?'事件唤醒':'定时'} · 探针：{row.probe?.items?.length??0} 项 · 心跳 {row.heartbeatCount??0} · 模型回合 {row.modelRoundCount??row.lastRun?.count??0}</p>
             {row.lastEvent&&<p className="mt-1 break-words text-xs text-amber-600">最近事件：{String(row.lastEvent.type||'unknown')} · {String(row.lastEvent.evidence||'')}</p>}
              {row.probeError&&<p className="mt-1 break-words text-xs text-red-600">探针错误：{row.probeError}</p>}
              {!!row.probe?.suppress?.length&&<ul aria-label={`抑制列表 ${row.name}`} className="mt-1 text-xs">{row.probe.suppress.map(value=><li key={value} className="break-words">{value} <button disabled={pending||row.status==='stopped'} onClick={()=>void perform(async()=>{const detail=await readResult(await api.monitors.get(row.id));await readResult(await api.monitors.update(row.id,{name:detail.name,content:detail.content,intervalMinutes:detail.interval_minutes,suppress:row.probe!.suppress!.filter(item=>item!==value)}));})}>删除抑制</button></li>)}</ul>}
             <label className="mt-2 block text-xs">探针 JSON（file / process / command / patterns）<textarea aria-label={`探针 JSON ${row.name}`} rows={3} value={probeDrafts[row.id]??''} onChange={event=>setProbeDrafts(previous=>({...previous,[row.id]:event.target.value}))} placeholder={'{"intervalMinutes":3,"items":[{"type":"file","path":"STATUS.md","read":"tail"}]}' } className="mt-1 block w-full rounded border bg-background p-2 font-mono text-xs"/></label>
            {row.lastRun?.error&&<p role="status" className="mt-1 text-xs text-amber-600">{row.lastRun.error}</p>}
            {row.last_error&&<p role="status" className="mt-1 text-xs text-amber-600">{row.last_error}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              {row.status==='active'&&<><button className={button} disabled={pending} onClick={()=>void perform(async()=>{await readResult(await api.monitors.action(row.id,'pause'));})}>暂停</button><button className={button} disabled={pending} onClick={()=>void perform(async()=>{await readResult(await api.monitors.action(row.id,'run-now'));})}>立即检查</button></>}
              {row.status==='paused'&&<button className={button} disabled={pending} onClick={()=>void perform(async()=>{await readResult(await api.monitors.action(row.id,'resume'));})}>恢复</button>}
              {row.status!=='stopped'&&<button className={button} disabled={pending} onClick={()=>void perform(async()=>{await readResult(await api.monitors.action(row.id,'stop'));})}>停止</button>}
               {row.status!=='stopped'&&<button className={button} disabled={pending} onClick={()=>void perform(()=>saveProbe(row))}>保存探针</button>}
              <button className={button} disabled={pending} onClick={()=>void perform(async()=>{const runs=await readResult(await api.monitors.runs(row.id));if(currentSession.current===sessionId)setHistory({id:row.id,runs});})}>运行记录</button>
            </div>
            {history?.id===row.id&&<ul className="mt-2 space-y-1 text-xs">{history.runs.length===0?<li>尚未执行</li>:history.runs.map(run=><li key={run.id}>{new Date(run.started_at).toLocaleString('zh-CN')} · {({running:'运行中',succeeded:'完成',failed:'失败',interrupted:'中断',skipped:'已跳过'} as Record<string,string>)[run.status]??run.status}{run.error&&`：${run.error}`}{run.total_tokens!=null&&` · ${run.total_tokens.toLocaleString()} tokens`}{run.output_tokens!=null&&`（输入 ${run.input_tokens??0} / 缓存读 ${run.cache_read_tokens??0} / 输出 ${run.output_tokens}）`}</li>)}</ul>}
          </article>)}</div>
        </>}
        {error&&<p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
      </section>
    </div>,document.body)}
  </>;
}
