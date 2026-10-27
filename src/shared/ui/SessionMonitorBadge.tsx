import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, Clock3, Pause, TriangleAlert, X } from 'lucide-react';

import { api, readApiErrorMessage } from '@/shared/api';
import { describeMonitorSchedule } from '@/shared/utils';
import { useMonitorSummaries, refreshMonitorSummaries } from '@/shared/hooks/useMonitorSummaries';
import type { SessionMonitorSummary } from '@/shared/types';

const stateLabel=(row:SessionMonitorSummary)=>row.status==='paused'?'已暂停':row.consecutive_failures>0?'失败 / 退避中':row.running_id?'正在运行':'已启用';
const resultLabel=(row:SessionMonitorSummary)=>row.last_error||({succeeded:'成功',failed:'失败',interrupted:'中断',running:'运行中'}[row.last_result??'']??'尚未执行');
const nextLabel=(row:SessionMonitorSummary)=>row.status==='paused'?'暂停期间不调度':new Date(row.next_run_at).toLocaleString();

/** Sidebar, workbench and conversation header expose thread-bound automation without navigating away. */
export function SessionMonitorBadge({sessionId}:{sessionId:string}) {
  const rows=useMonitorSummaries()[sessionId]??[];
  // Details stay attached to the clicked badge and do not change the selected conversation.
  const [open,setOpen]=useState(false);
  // Prevent repeated lifecycle writes and display permission/network failures.
  const [pending,setPending]=useState(false);
  // Preserve rejected action feedback until the next intentional action.
  const [error,setError]=useState('');
  const hold=useRef<ReturnType<typeof setTimeout>>();
  if(!rows.length)return null;
  const failed=rows.some(row=>row.consecutive_failures>0&&row.status==='active');
  const active=rows.some(row=>row.status==='active');
  const label=failed?'监测：失败 / 退避中':active?'监测：已启用':'监测：已暂停';
  const Icon=failed?TriangleAlert:active?Clock3:Pause;
  const action=async(id:string,value:string)=>{
    setPending(true);setError('');
    try{const response=await api.monitors.action(id,value);if(!response.ok)throw new Error(readApiErrorMessage(await response.json())||'操作失败');await refreshMonitorSummaries();}
    catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
    finally{setPending(false);}
  };
  const details=rows.map(row=>[row.name,stateLabel(row),describeMonitorSchedule(row),'下次（本地）：'+nextLabel(row),'最近结果：'+resultLabel(row)].join(' · ')).join('\n');
  return <>
    <button type="button" aria-label={label} title={details} data-monitor-session={sessionId} data-monitor-state={failed?'backoff':active?'active':'paused'} className={'mx-1 inline-flex shrink-0 rounded p-1 align-middle '+(failed?'text-amber-600':active?'text-emerald-600':'text-muted-foreground')}
      onPointerDown={event=>{event.stopPropagation();hold.current=setTimeout(()=>setOpen(true),500);}} onPointerUp={()=>clearTimeout(hold.current)} onPointerCancel={()=>clearTimeout(hold.current)} onPointerLeave={()=>clearTimeout(hold.current)}
      onClick={event=>{event.preventDefault();event.stopPropagation();setOpen(true);}} onKeyDown={event=>event.stopPropagation()}><Icon size={13}/></button>
    {open&&createPortal(<div className="fixed inset-0 z-[11000] flex items-center justify-center bg-black/40 p-3" onClick={event=>{event.stopPropagation();if(event.target===event.currentTarget)setOpen(false);}} onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape')setOpen(false);}}>
      <section role="dialog" aria-modal="true" aria-label="会话监测" className="max-h-[85dvh] w-full max-w-lg overflow-auto rounded-xl border border-border bg-background p-4 text-foreground shadow-xl">
        <header className="mb-3 flex items-center justify-between"><h2 className="flex items-center gap-2 font-semibold"><Activity size={16}/>会话监测</h2><button autoFocus aria-label="关闭会话监测" onClick={()=>setOpen(false)}><X size={18}/></button></header>
        <p className="mb-3 text-xs text-muted-foreground">下次执行时间按本地时区显示。暂停或停止不会中断已经运行的一轮。</p>
        {rows.map(row=><article key={row.id} className="mb-2 space-y-2 rounded-lg border border-border p-3"><div className="flex justify-between gap-2"><strong className="text-sm">{row.name}</strong><span className="text-xs">{stateLabel(row)}</span></div>
          <p className="text-xs text-muted-foreground">{describeMonitorSchedule(row)}</p><p className="text-xs">下次（本地）：{nextLabel(row)}</p><p className="break-words text-xs">最近结果：{resultLabel(row)}</p>
          <div className="flex flex-wrap gap-2">{(row.status==='paused'?['resume','stop']:['pause','run-now','stop']).map(value=><button key={value} disabled={pending||(value==='run-now'&&!!row.running_id)} onClick={()=>void action(row.id,value)} className="rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40">{{resume:'恢复',pause:'暂停','run-now':'立即运行',stop:'停止'}[value]}</button>)}</div>
        </article>)}{error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
      </section>
    </div>,document.body)}
  </>;
}
