import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Folder, MoreHorizontal, Plus, Settings2, X } from 'lucide-react';

import { SectionRow } from '@/modules/sidebar/SectionRow';
import { api, readApiErrorMessage } from '@/shared/api';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { LLMProvider, Project, ProjectOrganizationSnapshot, SidebarProjectListProps } from '@/shared/types';
import SidebarProjectList from '@/modules/sidebar/SidebarProjectList';
import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';

async function read(response:Response):Promise<ProjectOrganizationSnapshot>{const body=await response.json();if(!response.ok)throw new Error(readApiErrorMessage(body)||'无法保存项目设置');return body.data;}

/** WorkspaceSections keeps custom sections above this independent project/flat navigation. */
export function ProjectOrganization({props}:{props:SidebarProjectListProps}) {
  // The authoritative account snapshot includes sessions that discovery has not loaded into expanded projects yet.
  const [snapshot,setSnapshot]=useState<ProjectOrganizationSnapshot|null>(null);
  // One metadata editor can inspect either a project or a conversation without navigating away.
  const [editor,setEditor]=useState<{kind:'project'|'session';id:string}|null>(null);
  // Preserve editable project fields until an explicit save.
  const [name,setName]=useState('');
  // Root paths are one-per-line to work equally well with mobile keyboards.
  const [roots,setRoots]=useState('');
  // Writes remain serialized and failures visible, including other-client revision conflicts.
  const [busy,setBusy]=useState(false);
  // Keep the last server rejection available instead of silently overwriting another client's changes.
  const [error,setError]=useState('');
  const sequence=useRef(0),writing=useRef(false),dragged=useRef<string|null>(null);
  useEffect(()=>{
    let live=true;
    const load=async()=>{const current=++sequence.current;try{const next=await read(await api.projectOrganization.list());if(live&&current===sequence.current&&!writing.current)setSnapshot(next);}catch{/* Existing sidebar remains usable with an older server. */}};
    void load();const timer=setInterval(()=>void load(),10000);return()=>{live=false;clearInterval(timer);};
  },[]);
  const change=async(input:Record<string,unknown>)=>{
    if(!snapshot||writing.current)return;
    writing.current=true;sequence.current++;setBusy(true);setError('');
    try{setSnapshot(await read(await api.projectOrganization.update({...input,revision:snapshot.revision})));}
    catch(reason){setError(reason instanceof Error?reason.message:String(reason));try{setSnapshot(await read(await api.projectOrganization.list()));}catch{/* Keep current data. */}}
    finally{writing.current=false;setBusy(false);}
  };
  if(!snapshot)return <SidebarProjectList {...props}/>;
  const projectFor=(id:string):Project=>{
    const meta=snapshot.projects.find(p=>p.id===id)!;
    const original=props.projects.find(p=>p.projectId===id);
    return {...original,projectId:id,displayName:meta.name,fullPath:meta.path};
  };
  const sorted=(projectId:string|null)=>{
    const order=snapshot.threadOrders[projectId??'projectless']??[];
    const rank=(id:string)=>order.includes(id)?order.indexOf(id):order.length;
    return snapshot.sessions.filter(s=>s.projectId===projectId).sort((a,b)=>rank(a.id)-rank(b.id)||b.updatedAt.localeCompare(a.updatedAt));
  };
  const move=(projectId:string|null,id:string,target:number)=>{
    const ids=sorted(projectId).map(s=>s.id),index=ids.indexOf(id);
    if(target<0||target>=ids.length)return;
    ids.splice(index,1);ids.splice(target,0,id);void change({action:'thread-order',projectId,ids});
  };
  const renderRows=(rows:ProjectOrganizationSnapshot['sessions'],manual:boolean)=>rows.filter(row=>props.projects.length===props.filteredProjects.length||props.filteredProjects.some(p=>p.projectId===row.sourceProjectId)).map((row,index)=>{
    const project=row.sourceProjectId&&snapshot.projects.some(p=>p.id===row.sourceProjectId)?projectFor(row.sourceProjectId):{projectId:'projectless',displayName:'无项目对话',fullPath:row.cwd};
    const rename=props.activeRename?.target==='session'&&props.activeRename.id===row.id?props.activeRename:null;
    return <div key={row.id} data-organization-session={row.id} className="group/organization flex min-w-0 items-center" draggable={manual&&!busy} onDragStartCapture={()=>{dragged.current=row.id;}} onDragOver={event=>{if(manual)event.preventDefault();}} onDrop={event=>{event.preventDefault();event.stopPropagation();if(manual&&dragged.current&&rows.some(s=>s.id===dragged.current))move(row.projectId,dragged.current,index);dragged.current=null;}}>
      <div className="min-w-0 flex-1"><SidebarSessionItem project={project} session={{id:row.id,summary:row.title,updated_at:row.updatedAt,__provider:row.provider as LLMProvider}} selectedSession={props.selectedSession}
        isProcessing={props.activeSessions.has(row.id)} hasBackgroundWork={props.backgroundSessionIds.has(row.id)} needsAttention={props.attentionSessionIds.has(row.id)} currentTime={props.currentTime}
        isEditing={!!rename} renameDraft={rename?.draft??''} onRenameDraftChange={props.onRenameDraftChange} onStartEditingSession={props.onStartEditingSession} onCancelEditingSession={props.onCancelEditingSession} onSaveEditingSession={props.onSaveEditingSession}
        onProjectSelect={props.onProjectSelect} onSessionSelect={props.onSessionSelect} onDeleteSession={props.onDeleteSession} onForkSession={props.onForkSession} isSelecting={false} isChecked={false} onToggleSessionSelected={props.onToggleSessionSelected} t={props.t}/></div>
      <button className="mr-1 shrink-0 rounded p-1 text-muted-foreground hover:bg-muted" aria-label={'会话归属与工作区：'+row.title} onClick={()=>setEditor({kind:'session',id:row.id})}><MoreHorizontal size={13}/></button>
    </div>;
  });
  const needle=props.filteredProjects.length===props.projects.length?'':null;
  const editedProject=editor?.kind==='project'?snapshot.projects.find(p=>p.id===editor.id):undefined;
  const editedSession=editor?.kind==='session'?snapshot.sessions.find(s=>s.id===editor.id):undefined;
  return <section aria-label="项目与对话" className="pb-3">
    <div className="mx-3 mb-2 flex items-center justify-between gap-2"><span className="text-xs font-medium text-muted-foreground">项目与对话</span><select aria-label="侧栏显示模式" value={snapshot.mode} disabled={busy} onChange={event=>void change({action:'mode',mode:event.target.value})} className="max-w-[60%] rounded border border-border bg-background px-1 py-1 text-xs"><option value="project">按项目分组</option><option value="flat">按对话平铺</option></select></div>
    {error&&<p role="alert" className="mx-3 py-1 text-xs text-destructive">{error}</p>}
    {snapshot.mode==='flat'?renderRows([...snapshot.sessions].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),false):<>
      {snapshot.projects.filter(project=>needle!==null||props.filteredProjects.some(p=>p.projectId===project.id)).map((project,index)=><section key={project.id} aria-label={project.name} className="mb-2">
        <SectionRow target={{kind:'project',targetId:project.id,title:project.name}}><div className="mx-2 flex items-center gap-1 rounded px-1 hover:bg-muted"><button aria-label={'展开项目：'+project.name} aria-expanded={!project.collapsed} disabled={busy} onClick={()=>{if(props.selectedProject?.projectId!==project.id)props.onProjectSelect(projectFor(project.id));void change({action:'collapse',projectId:project.id,collapsed:!project.collapsed});}} className="flex min-w-0 flex-1 items-center gap-1 py-2 text-left text-xs">{project.collapsed?<ChevronRight size={13}/>:<ChevronDown size={13}/>}<Folder size={13}/><span className="min-w-0 flex-1 truncate" title={project.rootPaths.join('\n')}>{project.name}</span><span className="text-muted-foreground">{sorted(project.id).length}</span></button>
          <button aria-label={'新建项目对话：'+project.name} className="p-1 text-muted-foreground" onClick={()=>{const selected=projectFor(project.id);props.onProjectSelect(selected);props.onNewSession(selected);}}><Plus size={13}/></button>
          <button aria-label={'项目设置：'+project.name} className="p-1 text-muted-foreground" onClick={()=>{setEditor({kind:'project',id:project.id});setName(project.name);setRoots(project.rootPaths.join('\n'));}}><Settings2 size={13}/></button>
          <button aria-label={'上移项目：'+project.name} disabled={busy||index===0} onClick={()=>void change({action:'move',projectId:project.id,direction:'up'})} className="p-1 text-muted-foreground disabled:opacity-20"><ArrowUp size={11}/></button>
          <button aria-label={'下移项目：'+project.name} disabled={busy||index===snapshot.projects.length-1} onClick={()=>void change({action:'move',projectId:project.id,direction:'down'})} className="p-1 text-muted-foreground disabled:opacity-20"><ArrowDown size={11}/></button>
        </div></SectionRow>{!project.collapsed&&renderRows(sorted(project.id),true)}
      </section>)}
      <section aria-label="无项目对话"><h3 className="mx-3 py-2 text-xs text-muted-foreground">无项目对话</h3>{renderRows(sorted(null),true)}</section>
    </>}
    <Dialog open={!!editor} onOpenChange={open=>{if(!open)setEditor(null);}}><DialogContent className="max-h-[85dvh] w-[calc(100vw-1.5rem)] max-w-lg space-y-4 overflow-auto p-4">
      <div className="flex items-center justify-between"><DialogTitle className="not-sr-only text-base font-semibold">{editedProject?'项目设置':'会话归属与工作区'}</DialogTitle><button aria-label="关闭项目设置" onClick={()=>setEditor(null)}><X size={18}/></button></div>
      {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
      {editedProject&&<form className="space-y-3" onSubmit={event=>{event.preventDefault();void change({action:'edit',projectId:editedProject.id,name,rootPaths:roots.split('\n').map(s=>s.trim()).filter(Boolean)});}}>
        <label className="block text-sm">项目名称<input aria-label="项目名称" required maxLength={120} value={name} onChange={event=>setName(event.target.value)} className="mt-1 w-full rounded border border-border bg-background p-2"/></label>
        <label className="block text-sm">根目录（每行一个绝对路径）<textarea aria-label="项目根目录" required rows={4} value={roots} onChange={event=>setRoots(event.target.value)} className="mt-1 w-full rounded border border-border bg-background p-2 text-xs"/></label>
        <p className="break-all text-xs text-muted-foreground">新对话 cwd：{editedProject.path}。项目归类不移动文件；每条会话保留自己的工作区。</p>
        <div className="flex flex-wrap gap-2"><button disabled={busy} className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground">保存项目</button><button type="button" onClick={()=>props.onToggleStarProject(editedProject.id)} className="rounded border px-3 py-2 text-xs">{props.isProjectStarred(editedProject.id)?'取消收藏项目':'收藏项目'}</button><button type="button" onClick={()=>{props.onDeleteProject(projectFor(editedProject.id));setEditor(null);}} className="rounded border px-3 py-2 text-xs text-destructive">归档项目</button></div>
      </form>}
      {editedSession&&<div className="space-y-3"><p className="break-words text-sm">{editedSession.title}</p>
        <label className="block text-sm">归属项目<select aria-label="归属项目" disabled={busy} value={editedSession.projectId??''} onChange={event=>void change({action:'assign',sessionId:editedSession.id,projectId:event.target.value||null})} className="mt-1 w-full rounded border border-border bg-background p-2"><option value="">无项目对话</option>{snapshot.projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <p className="break-all text-xs">cwd：{editedSession.cwd||'未记录'}</p><p className="whitespace-pre-wrap break-all text-xs">工作区根：{editedSession.roots.join('\n')||'未记录'}</p>
        <p className="text-xs text-muted-foreground">修改归属只改变项目分组，执行目录与会话文件保持原位。</p>
        <div className="flex gap-2"><button disabled={busy||sorted(editedSession.projectId)[0]?.id===editedSession.id} onClick={()=>move(editedSession.projectId,editedSession.id,sorted(editedSession.projectId).findIndex(s=>s.id===editedSession.id)-1)} className="rounded border border-border px-3 py-2 text-xs disabled:opacity-30">上移会话</button>
          <button disabled={busy||sorted(editedSession.projectId).at(-1)?.id===editedSession.id} onClick={()=>move(editedSession.projectId,editedSession.id,sorted(editedSession.projectId).findIndex(s=>s.id===editedSession.id)+1)} className="rounded border border-border px-3 py-2 text-xs disabled:opacity-30">下移会话</button></div>
      </div>}
    </DialogContent></Dialog>
  </section>;
}
