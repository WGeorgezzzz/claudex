import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Repeat, X, Settings2 } from 'lucide-react';

import { api } from '@/shared/api';
import { MonitorScheduleFields } from '@/shared/ui';
import { useMonitorCapabilities } from '@/shared/hooks/useMonitorCapabilities';
import { describeMonitorSchedule, formatMonitorNextRun, readMonitorSchedule } from '@/shared/utils';
import type { MonitorCalendarSchedule, MonitorTaskRecord as Task, MonitorRunReceipt as Run, MonitorListSummary } from '@/shared/types';

async function result(response:Response){const body=await response.json();if(!response.ok)throw Error(body?.error?.message||body?.message||body?.error||`HTTP ${response.status}`);return body.data;}
function summaryTasks(rows:(Task|MonitorListSummary)[]):Task[]{return rows.map(row=> 'lastRun' in row?{
  id:row.id,name:row.name,content:row.content,status:row.status,session_id:'',interval_minutes:0,
  next_run_at:row.nextRunAt||'',running_id:null,run_count:row.lastRun.count,last_error:row.lastRun.error,
  schedule_json:row.schedule?JSON.stringify(row.schedule):null,
}:row);}
async function readTaskPages(){const rows:(Task|MonitorListSummary)[]=[];let offset=0;while(true){const response=await api.monitors.list(undefined,offset);rows.push(...await result(response));const next=response.headers?.get('X-Next-Offset');if(!next)break;offset=Number(next);}return summaryTasks(rows);}
function permissionLabel(task:Task):string {
  if(!task.options)return '请打开调整查看详情';
  try {const mode=JSON.parse(task.options??'{}').permissionMode??'default';return ({default:'Default · 按需审批',acceptEdits:'Accept edits · 自动允许编辑',plan:'Plan · 只规划',bypassPermissions:'Bypass · 全部允许'} as Record<string,string>)[mode]??'未知权限（请检查配置）';}
  catch{return '未知权限（请检查配置）';}
}
function contextRunDetail(error:string):string {
  if(!error.startsWith('上下文维护：'))return error;
  try{const detail=JSON.parse(error.slice('上下文维护：'.length));return `${detail.action==='compact'?'原生压缩':detail.action==='migrated'?'已交接新会话':'交接失败'} · ${detail.beforeTokens??'未知'} → ${detail.afterTokens??'待获取'} token · ${Math.round(Number(detail.durationMs||0)/1000)} 秒${detail.previousSessionId?' · 旧会话保留':''}${detail.reason?' · '+detail.reason:''}`;}catch{return error;}
}

/** SidebarHeader presents all persisted monitors and their controls outside any one chat. */
export function MonitorDashboard(){
  // Keep the global task count visible even when the manager is closed.
  const [tasks,setTasks]=useState<Task[]>([]);
  // The manager is independent of chat navigation and leaves drafts untouched.
  const [open,setOpen]=useState(false);
  // Editable values are isolated from refreshed server snapshots until saved.
  const [edit,setEdit]=useState<{id:string;name:string;content:string;minutes:number;schedule:MonitorCalendarSchedule|null;runMode:string}|null>(null);
  const calendarEnabled=useMonitorCapabilities(open);
  // Retain the requested task's latest receipts while its history is expanded.
  const [history,setHistory]=useState<{id:string;runs:Run[]}|null>(null);
  // Serialize user mutations and show any backend rejection in the manager.
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  // Server-owned token threshold controls automatic context maintenance for this account.
  const [contextThreshold,setContextThreshold]=useState(40);
  useEffect(()=>{if(open)void api.monitors.contextSettings().then(result).then(value=>setContextThreshold(value.percent??40)).catch(e=>setError(e.message));},[open]);
  const load=async()=>setTasks(await readTaskPages());
  useEffect(()=>{let live=true;const poll=()=>void readTaskPages().then(data=>{if(live)setTasks(data);}).catch(e=>{if(live)setError(e.message);});poll();const timer=setInterval(poll,open?5000:15000);return()=>{live=false;clearInterval(timer);};},[open]);
  useEffect(()=>{if(!open)return;const key=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[open]);
  const act=async(action:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await action();await load();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  const active=tasks.filter(t=>t.status==='active').length;
  const running=tasks.filter(t=>t.running_id).length;
  const button='rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40';
  const statuses:Record<string,string>={active:'已启用',paused:'已暂停',stopped:'已停止',succeeded:'完成',failed:'失败',interrupted:'中断',skipped:'已跳过',running:'运行中'};
  return <>
    <button type="button" onClick={()=>setOpen(true)} aria-label={`自动监测，${active} 个已启用`} className="sidebar-nav-action">
      <Repeat className="h-4 w-4"/><span>自动监测</span>{(error||active>0)&&<span className="ml-auto text-[11px] text-muted-foreground">{error?'连接异常':active}</span>}
    </button>
    {open&&createPortal(<div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4" onClick={e=>{if(e.target===e.currentTarget)setOpen(false);}}>
      <section role="dialog" aria-modal="true" aria-label="自动监测管理" className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl border bg-background text-foreground shadow-xl">
        <header className="flex items-start justify-between border-b p-5"><div><h2 className="text-xl font-semibold">自动监测</h2><p className="mt-1 text-sm text-muted-foreground">{tasks.length} 个任务 · {active} 个已启用 · {running} 个运行中</p></div><button type="button" aria-label="关闭自动监测" onClick={()=>setOpen(false)}><X size={20}/></button></header>
        <div className="space-y-3 overflow-auto p-5">
          <p className="text-sm text-muted-foreground">在聊天中创建，或从 Claude / Codex 输入框旁的「监测」添加。这里统一管理全部会话的任务。</p>
          <div className="rounded-lg bg-muted p-3 text-sm">权限沿用每个任务创建时的设置，并显示在对应任务下方。电脑和本地服务需运行；关闭聊天页面不影响监测。</div>
          <form className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm" onSubmit={e=>{e.preventDefault();void act(()=>api.monitors.saveContextSettings(undefined,contextThreshold).then(result));}}><label>原会话自动压缩阈值（模型窗口 %）<input aria-label="自动压缩阈值" type="number" min={5} max={80} value={contextThreshold} onChange={e=>setContextThreshold(Number(e.target.value))} className="ml-2 min-h-10 w-32 rounded border bg-background px-2"/></label><button type="submit" className={button} disabled={busy}>保存阈值</button><p className="text-xs text-muted-foreground">独立回合默认每轮新建短会话，只携带最多 2000 字状态。原会话方式每轮前后检查窗口比例，压缩失败时保留旧会话并交接。</p></form>
          {error&&<p role="alert" className="text-sm text-red-600">{error}</p>}
          {!tasks.length&&<p className="py-8 text-center text-muted-foreground">暂无自动监测。</p>}
          {[...tasks].sort((a,b)=>Number(a.status==='stopped')-Number(b.status==='stopped')).map(task=><article key={task.id} className="rounded-xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{task.name}</h3><span className="rounded-full bg-muted px-2 py-1 text-xs">{task.running_id?'运行中':statuses[task.status]}</span></div>
            <p className="mt-2 text-sm text-muted-foreground">{task.interval_minutes?describeMonitorSchedule(task):task.schedule_json?describeMonitorSchedule(task):'按间隔执行'} · 已执行 {task.run_count} 次{task.status==='active'&&!task.running_id?` · 下次 ${formatMonitorNextRun(task)}`:''}</p>
            <p className="mt-1 text-xs text-muted-foreground">运行方式：{task.options?(JSON.parse(task.options).runMode==='original'?'在原会话运行':'独立回合'):'查看单条详情'} · 执行权限：<strong>{permissionLabel(task)}</strong></p>
            {edit?.id===task.id?<form className="mt-3 space-y-2" onSubmit={e=>{e.preventDefault();if(edit.schedule&&!calendarEnabled){setError('当前服务尚未确认支持日历调度。');return;}void act(async()=>{await result(await api.monitors.update(task.id,{name:edit.name,content:edit.content,intervalMinutes:edit.minutes,...(edit.schedule||task.schedule_json?{schedule:edit.schedule}:{}),runMode:edit.runMode}));setEdit(null);});}}>
              <label className="block text-sm">名称<input aria-label="任务名称" required maxLength={120} value={edit.name} onChange={e=>setEdit({...edit,name:e.target.value})} className="mt-1 w-full rounded border bg-background p-2"/></label>
              <label className="block text-sm">检查内容<textarea aria-label="任务检查内容" required maxLength={20000} rows={5} value={edit.content} onChange={e=>setEdit({...edit,content:e.target.value})} className="mt-1 w-full rounded border bg-background p-2"/></label>
              <label className="block text-sm">运行方式<select aria-label="监测运行方式" value={edit.runMode} onChange={e=>setEdit({...edit,runMode:e.target.value})} className="ml-2 min-h-10 rounded border bg-background px-2"><option value="isolated">独立回合（推荐）</option><option value="original">在原会话运行</option></select></label><MonitorScheduleFields value={edit.schedule} onChange={schedule=>setEdit({...edit,schedule})} minutes={edit.minutes} onMinutesChange={minutes=>setEdit({...edit,minutes})} intervalLabel="任务间隔分钟" calendarEnabled={calendarEnabled} disabled={busy}/>
              <p className="text-xs text-muted-foreground">修改作用于后续检查，不中断当前一轮。修改调度规则会重新计算下次时间。</p>
              <button className={button} type="submit" disabled={busy}>保存调整</button> <button className={button} type="button" onClick={()=>setEdit(null)}>取消</button>
            </form>:<p className="my-3 max-h-28 overflow-auto whitespace-pre-wrap text-sm">{task.content}</p>}
            {task.last_error&&<p className="my-2 text-sm text-amber-600">{task.last_error}</p>}
            {task.status==='active'&&(task.consecutive_failures??0)>0&&<p className="my-2 text-sm text-amber-600">连续失败 {task.consecutive_failures} 次 · 自动恢复中，按下次执行时间重试（最长退避 30 分钟）。</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              {task.status!=='stopped'&&<button className={button} disabled={busy} onClick={()=>void act(async()=>{const full=task.session_id?task:await result(await api.monitors.get(task.id));setEdit({id:full.id,name:full.name,content:full.content,minutes:full.interval_minutes,schedule:readMonitorSchedule(full),runMode:JSON.parse(full.options||'{}').runMode||'isolated'});})}><Settings2 size={13} className="mr-1 inline"/>调整</button>}
              {task.status==='active'&&<><button className={button} disabled={busy} onClick={()=>void act(()=>api.monitors.action(task.id,'pause').then(result))}>暂停</button><button className={button} disabled={busy||Boolean(task.running_id)} onClick={()=>void act(()=>api.monitors.action(task.id,'run-now').then(result))}>立即检查</button></>}
              {task.status==='paused'&&<button className={button} disabled={busy} onClick={()=>void act(()=>api.monitors.action(task.id,'resume').then(result))}>恢复</button>}
              {task.status!=='stopped'&&<button className={button} disabled={busy} onClick={()=>void act(()=>api.monitors.action(task.id,'stop').then(result))}>停止</button>}
              <button className={button} disabled={busy} onClick={()=>void act(async()=>setHistory({id:task.id,runs:await result(await api.monitors.runs(task.id))}))}>运行记录</button>
              <a href={task.session_id?`/session/${encodeURIComponent(task.session_id)}`:'#'} onClick={event=>{if(!task.session_id){event.preventDefault();void act(async()=>{const full=await result(await api.monitors.get(task.id));window.location.assign('/session/'+encodeURIComponent(full.session_id));});}}} className={button}>打开会话</a>
            </div>
            {history?.id===task.id&&<ul className="mt-3 space-y-1 text-xs">{history.runs.length?history.runs.map(run=><li key={run.id}>{new Date(run.started_at).toLocaleString('zh-CN')} · {statuses[run.status]??run.status}{run.error?`：${contextRunDetail(run.error)}`:''}{run.total_tokens!=null?' · 累计 '+run.total_tokens+' tokens':''}{run.input_tokens!=null?` · 输入 ${run.input_tokens} token`:''}{run.context_tokens!=null?` · 上下文 ${run.context_tokens} token`:''}{run.session_id&&<a className="ml-2 underline" href={'/session/'+run.session_id}>查看本轮</a>}{run.report&&<details><summary>汇报</summary><p className="whitespace-pre-wrap">{run.report}</p></details>}</li>):<li>尚无运行记录</li>}</ul>}
          </article>)}
        </div>
        <footer className="border-t px-5 py-3 text-xs text-muted-foreground">暂停或停止不强制终止当前一轮。日历按指定时区执行，间隔从每轮结束后计算；停机错过后最多补一次，失败后退避重试并保留记录。</footer>
      </section>
    </div>,document.body)}
  </>;
}
