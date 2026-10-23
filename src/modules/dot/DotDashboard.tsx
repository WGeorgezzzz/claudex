import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Circle, X, Plus, ArrowUpRight, Brain, MessageCircle, Activity } from 'lucide-react';

import { api } from '@/shared/api';

type Memory={id:string;content:string;revision:number};
type Snapshot={threads:Array<{sessionId:string;title:string;createdAt:string}>;memories:Memory[];tasks:Array<{id:string;source_session_id:string;target_session_id:string;status:string;error:string|null;reported:number;title?:string;projectPath?:string}>};
async function result(response:Response){const b=await response.json();if(!response.ok)throw Error(b?.error?.message||b?.message||b?.error||`HTTP ${response.status}`);return b.data;}
const button='rounded-lg border px-3 py-2 text-sm hover:bg-muted disabled:opacity-40';
const labels:Record<string,string>={queued:'排队中',running:'执行中',succeeded:'回合完成',failed:'失败',interrupted:'已中断',cancelled:'已取消'};

/** Sidebar opens the independent Dot workspace while chat navigation reuses the full conversation UI. */
export function DotDashboard(){
  const navigate=useNavigate();
  // Keep the workspace open independently of the current conversation and draft.
  const [open,setOpen]=useState(false);
  // Persist the selected workspace section while reviewing details.
  const [section,setSection]=useState<'threads'|'memories'|'tasks'>('threads');
  // Refresh server-owned state without overwriting a memory being edited.
  const [data,setData]=useState<Snapshot>({threads:[],memories:[],tasks:[]});
  // A local draft supports explicit save and cancellation for each memory.
  const [edit,setEdit]=useState<{content:string;id?:string;revision?:number}|null>(null);
  // Mutations are serialized; errors remain visible until a successful action.
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  useEffect(()=>{if(!open)return;let live=true;const load=()=>void api.dot.snapshot().then(result).then(d=>{if(live)setData(d);}).catch(e=>{if(live)setError(e.message);});load();const timer=setInterval(load,5000);const key=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);};window.addEventListener('keydown',key);return()=>{live=false;clearInterval(timer);window.removeEventListener('keydown',key);};},[open]);
  const go=(id:string)=>{setOpen(false);navigate('/session/'+encodeURIComponent(id));};
  const act=async(fn:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await fn();setData(await result(await api.dot.snapshot()));}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  return <><button type="button" className="sidebar-nav-action" onClick={()=>setOpen(true)}><Circle size={16}/><span>Dot</span><span className="ml-auto text-[10px] text-muted-foreground">个人助手</span></button>
    {open&&createPortal(<div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-3" onClick={e=>{if(e.target===e.currentTarget)setOpen(false);}}>
      <section role="dialog" aria-modal="true" aria-label="Dot 个人助手" className="flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border bg-background text-foreground shadow-xl">
        <header className="flex items-center gap-3 p-5"><img src="/gaci-mark.svg" alt="" className="h-10 w-10 rounded-xl"/><div className="flex-1"><h2 className="text-xl font-semibold">你的 Dot</h2><p className="text-xs text-muted-foreground">跨项目对话 · 记忆 · 委派任务</p></div><button type="button" aria-label="关闭 Dot" onClick={()=>setOpen(false)}><X size={20}/></button></header>
        <nav aria-label="Dot 分区" className="flex gap-1 border-b px-4 pb-3">{([{id:'threads',name:'对话',Icon:MessageCircle},{id:'memories',name:'记忆',Icon:Brain},{id:'tasks',name:'活动',Icon:Activity}] as const).map(({id,name,Icon})=><button key={id} type="button" onClick={()=>setSection(id)} aria-pressed={section===id} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${section===id?'bg-muted font-medium':'text-muted-foreground'}`}><Icon size={15}/>{name}</button>)}</nav>
        <div className="space-y-3 overflow-auto p-5">{error&&<p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-600">{error}</p>}
          {section==='threads'&&<><p className="text-sm text-muted-foreground">从这里开始独立对话。你可以让 Dot 记住偏好、查看其他项目，或按你的要求委派工作。记忆仅保存在本机。</p><button type="button" disabled={busy} className={button+' flex items-center gap-2'} onClick={()=>void act(async()=>{const s=await result(await api.dot.createThread('Dot · 新对话'));go(s.sessionId);})}><Plus size={16}/>和 Dot 聊聊</button>{data.threads.map(t=><button type="button" key={t.sessionId} onClick={()=>go(t.sessionId)} className="flex w-full items-center justify-between rounded-xl border p-4 text-left hover:bg-muted"><span className="truncate">{t.title||'Dot · 新对话'}</span><ArrowUpRight size={16}/></button>)}</>}
          {section==='memories'&&<><p className="text-sm text-muted-foreground">明确告诉 Dot「记住…」或在这里添加。你可以随时修改或删除。不要保存密码和密钥。</p><button type="button" className={button} onClick={()=>setEdit({content:''})}>添加记忆</button>{edit&&<form className="space-y-2 rounded-xl border p-3" onSubmit={e=>{e.preventDefault();void act(async()=>{await result(await api.dot.saveMemory(edit));setEdit(null);});}}><textarea aria-label="记忆内容" className="min-h-24 w-full rounded-md border bg-background p-2 text-sm" value={edit.content} maxLength={4000} onChange={e=>setEdit({...edit,content:e.target.value})}/><div className="flex gap-2"><button disabled={busy||!edit.content.trim()} className={button}>保存记忆</button><button type="button" className={button} onClick={()=>setEdit(null)}>取消</button></div></form>}{data.memories.map(m=><article key={m.id} className="rounded-xl border p-4"><p className="whitespace-pre-wrap break-words text-sm">{m.content}</p><div className="mt-3 flex gap-3 text-xs"><button type="button" onClick={()=>setEdit(m)}>编辑</button><button type="button" disabled={busy} onClick={()=>void act(async()=>{await result(await api.dot.forget(m.id,m.revision));if(edit?.id===m.id)setEdit(null);})}>删除</button></div></article>)}</>}
          {section==='tasks'&&<><p className="text-sm text-muted-foreground">委派任务会在项目中独立执行，可能等待审批；完成后回报给原 Dot 对话。停止主对话不会停止委派。定时任务在侧栏「自动监测」管理。</p>{!data.tasks.length&&<p className="py-8 text-center text-muted-foreground">尚无委派任务</p>}{data.tasks.map(t=><article key={t.id} className="space-y-3 rounded-xl border p-4"><div className="flex justify-between text-sm"><strong>{labels[t.status]??t.status}</strong><span className="text-muted-foreground">{t.reported?'已处理回报':'等待回报'}</span></div><p className="break-words text-sm">{t.title||t.id}</p><p className="break-all text-xs text-muted-foreground">{t.projectPath}</p>{t.error&&<p className="break-words text-xs text-red-600">{t.error}</p>}<div className="flex flex-wrap gap-2"><button type="button" className={button} onClick={()=>go(t.target_session_id)}>打开任务{t.status==='running'?' / 停止':''}</button><button type="button" className={button} onClick={()=>go(t.source_session_id)}>原对话</button>{t.status==='queued'&&<button type="button" disabled={busy} className={button} onClick={()=>void act(()=>api.dot.cancelTask(t.id).then(result))}>取消排队</button>}</div></article>)}</>}
        </div>
      </section>
    </div>,document.body)}</>;
}
