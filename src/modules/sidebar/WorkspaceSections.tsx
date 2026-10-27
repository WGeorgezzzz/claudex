import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, FolderPlus, MoreHorizontal, Plus, Trash2, X } from 'lucide-react';

import { useWorkspaceSections } from '@/modules/sidebar/context/WorkspaceSectionsContext';
import { api, readApiErrorMessage } from '@/shared/api';
import { ActionMenu, Dialog, DialogContent } from '@/shared/ui';
import { WorkspaceSessionRow } from '@/modules/sidebar/WorkspaceSessionRow';
import type { BridgeSessionPage, SidebarProjectListProps } from '@/shared/types';
import { ProjectOrganization } from '@/modules/sidebar/ProjectOrganization';
import SidebarProjectList from '@/modules/sidebar/SidebarProjectList';

async function unwrap<T>(response: Response): Promise<T> {
  const body = await response.json(); if (!response.ok) throw new Error(readApiErrorMessage(body) || `HTTP ${response.status}`);
  return body.data;
}

/** SidebarContent renders persistent custom sections around its existing project rows. */
export function WorkspaceSections({ projectListProps, onSelect }: { projectListProps: SidebarProjectListProps; onSelect: (projectId: string | null, sessionId: string, provider: string) => void }) {
  const { t } = useTranslation('sidebar');
  // A server snapshot lets sections survive reloads and synchronize between clients.
  const state = useWorkspaceSections();
  const layout = state?.layout;
  // Inline creation and rename preserve the sidebar position without a modal.
  const [editing, setEditing] = useState<string | null>(null);
  // Section inputs are independent from the batch-manager draft.
  const [draft, setDraft] = useState('');
  // Drop targets advertise which section will receive a row or reordered header.
  const [hover, setHover] = useState<string | null>(null);
  // Deletion explains that only organization was removed.
  const [notice, setNotice] = useState('');
  // Organization controls do not navigate or replace a chat draft.
  const [open, setOpen] = useState(false);
  // Preserve a new section name until its request succeeds.
  const [name, setName] = useState('');
  // Show rejected writes, including revision conflicts, without silently overwriting another client.
  const [searchError, setError] = useState('');
  const error = state?.error || searchError;
  // Serialize layout mutations while waiting for their authoritative result.
  const busy = state?.busy ?? false;
  // Search projects locally and sessions through a bounded server query.
  const [query, setQuery] = useState('');
  // Switching assignment kind leaves the active conversation alone.
  const [kind, setKind] = useState<'project' | 'session'>('project');
  // Retain one paginated server search result for assigning conversations.
  const [page, setPage] = useState<BridgeSessionPage | null>(null);
  const searchSequence = useRef(0);
  const collapseTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(collapseTimer.current), []);
  useEffect(() => {
    if (!open || kind !== 'session') return;
    const sequence = ++searchSequence.current;
    const timer = setTimeout(() => { void api.sessionBridge.list(query).then(unwrap<BridgeSessionPage>).then(value => {
      if (sequence === searchSequence.current) setPage(value);
    }).catch(reason => { if (sequence === searchSequence.current) setError(String(reason)); }); }, 200);
    return () => { clearTimeout(timer); searchSequence.current++; };
  }, [open, kind, query]);
  const change = async (input: Record<string, unknown>) => {
    const ok = await state?.change(input);
    if (ok && input.action === 'create') setName('');
    return ok;
  };
  const saveInline = async () => {
    if (!draft.trim() || busy) return;
    if (await change(editing === 'new' ? { action: 'create', name: draft } : { action: 'rename', id: editing, name: draft })) setEditing(null);
  };
  const input = <input autoFocus aria-label={editing === 'new' ? '新分区名称' : '分区名称'} value={draft} maxLength={80} disabled={busy} onChange={event => setDraft(event.target.value)}
    onBlur={() => { if (!draft.trim()) setEditing(null); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void saveInline(); } if (event.key === 'Escape') { event.stopPropagation(); setEditing(null); } }} className="mx-3 mb-2 w-[calc(100%-1.5rem)] rounded border border-primary bg-background px-2 py-2 text-base"/>;
  const drop = (event: DragEvent, sectionId: string | null) => {
    event.preventDefault(); event.stopPropagation(); setHover(null);
    const id = event.dataTransfer.getData('application/x-nexagent-section');
    if (id && sectionId && id !== sectionId) { void change({ action: 'reorder', id, beforeId: sectionId }); return; }
    const raw = event.dataTransfer.getData('application/x-nexagent-section-item');
    try { const target = JSON.parse(raw); if ((target.kind === 'project' || target.kind === 'session') && typeof target.targetId === 'string') void change({ action: 'assign', kind: target.kind, targetId: target.targetId, sectionId }); } catch { /* Ignore native file/link drags. */ }
  };
  const dragOver = (event: DragEvent, id: string) => {
    if (!Array.from(event.dataTransfer.types).some(type => type.startsWith('application/x-nexagent-section'))) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setHover(id);
  };
  // Older backends still show their ordinary project list without unsupported controls.
  if (!layout) return <ProjectOrganization props={projectListProps}/>;
  const assignedProject = (id: string) => layout.assignments.find(item => item.kind === 'project' && item.targetId === id)?.sectionId;
  const listProps = projectListProps;
  const available = kind === 'project' ? projectListProps.projects.filter(project => `${project.displayName} ${project.fullPath}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(project => ({ id: project.projectId, title: project.displayName, path: project.fullPath }))
    : (page?.sessions ?? []).map(session => ({ id: session.sessionId, title: session.title, path: session.projectPath }));
  return <>
    <div className="mx-3 mb-2 flex items-center justify-between"><span className="text-xs font-medium text-muted-foreground">{t('sections.title')}</span>
      <div className="flex items-center gap-1"><button type="button" disabled={busy} aria-label="新建分区" onClick={() => { setEditing('new'); setDraft(''); }} className="flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-muted"><Plus size={17}/>{!layout.sections.length && '新建分区'}</button>
        <ActionMenu menuClassName="z-[100]" label="分区操作" ariaLabel="分区操作" icon={MoreHorizontal} iconOnly variant="ghost" size="icon" triggerClassName="h-8 w-7" items={[{ key: 'manage', label: t('sections.manage'), onSelect: () => setOpen(true) }]}/></div></div>
    {editing === 'new' && input}
    {notice && <p role="status" className="mx-3 py-1 text-xs text-muted-foreground">{notice}</p>}
    {error && !open && <p role="alert" className="mx-3 text-xs text-destructive">{error}</p>}
    {layout.sections.map(section => {
      const projects = projectListProps.filteredProjects.filter(project => assignedProject(project.projectId) === section.id);
      const sessions = layout.sessionItems.filter(session => layout.assignments.some(item => item.kind === 'session' && item.targetId === session.sessionId && item.sectionId === section.id));
      return <section key={section.id} aria-label={section.name} className="mb-3">
        <div data-section-header={section.id} className={`mx-2 flex items-center rounded ${hover === section.id ? 'bg-primary/15 ring-2 ring-primary' : ''}`} draggable={!busy} onDragStart={event => { event.stopPropagation(); event.dataTransfer.setData('application/x-nexagent-section', section.id); }} onDragOver={event => dragOver(event, section.id)} onDragLeave={() => setHover(null)} onDrop={event => drop(event, section.id)} onDragEnd={() => setHover(null)}>
        {editing === section.id ? input : <button type="button" onDoubleClick={() => { clearTimeout(collapseTimer.current); setEditing(section.id); setDraft(section.name); }} disabled={busy} aria-expanded={!section.collapsed} onClick={event => { clearTimeout(collapseTimer.current); if (event.detail < 2) collapseTimer.current = setTimeout(() => void change({ action: 'collapse', id: section.id, collapsed: !section.collapsed }), event.detail === 0 ? 0 : 250); }} className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1.5 text-xs font-semibold hover:bg-muted">
          {section.collapsed ? <ChevronRight size={13}/> : <ChevronDown size={13}/>}<span className="min-w-0 flex-1 truncate text-left">{section.name}</span><span className="text-muted-foreground">{projects.length + sessions.length}</span>
        </button>}
        <ActionMenu menuClassName="z-[100]" label="分区操作" ariaLabel={'分区操作：' + section.name} icon={MoreHorizontal} iconOnly variant="ghost" size="icon" triggerClassName="h-8 w-7" items={[
          { key: 'rename', label: '重命名', disabled: busy, onSelect: () => { setEditing(section.id); setDraft(section.name); } },
          { key: 'up', label: '上移', disabled: busy || layout.sections[0].id === section.id, onSelect: () => { void change({ action: 'move', id: section.id, direction: 'up' }); } },
          { key: 'down', label: '下移', disabled: busy || layout.sections.at(-1)?.id === section.id, onSelect: () => { void change({ action: 'move', id: section.id, direction: 'down' }); } },
          { key: 'delete', label: '删除分区', description: '只取消归类，保留项目和会话。', isDanger: true, disabled: busy, onSelect: () => { void change({ action: 'delete', id: section.id }).then(ok => { if (ok) setNotice('已删除分区，只取消归类，项目和会话均已保留。'); }); } },
        ]}/></div>
        {!section.collapsed && <>{projects.length > 0 && <SidebarProjectList {...listProps} projects={projects} filteredProjects={projects}/>}
          {sessions.map(session => <WorkspaceSessionRow key={session.sessionId} id={session.sessionId} title={session.title} provider={session.provider} projectId={session.projectId} selected={projectListProps.selectedSession?.id===session.sessionId} onSelect={()=>onSelect(session.projectId,session.sessionId,session.provider)}/>)}
          {projects.length + sessions.length === 0 && <p className="mx-5 py-2 text-[11px] text-muted-foreground">{t('sections.empty')}</p>}
        </>}
      </section>;
    })}
    <div data-section-unassign className={`rounded py-2 ${hover === 'unassigned' ? 'bg-primary/15 ring-2 ring-primary' : ''}`} onDragOver={event => dragOver(event, 'unassigned')} onDragLeave={() => setHover(null)} onDrop={event => drop(event, null)}><ProjectOrganization props={projectListProps}/></div>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent wrapperClassName="z-[80]" aria-label={t('sections.manage')} className="flex max-h-[85dvh] max-w-2xl flex-col overflow-hidden">
      <header className="flex items-center justify-between"><h2 className="font-semibold">{t('sections.manage')}</h2><button aria-label={t('sections.close')} onClick={() => setOpen(false)}><X size={18}/></button></header>
      <p className="text-xs text-muted-foreground">{t('sections.description')}</p>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2"><input aria-label={t('sections.newName')} placeholder={t('sections.newName')} value={name} onChange={event => setName(event.target.value)} maxLength={80} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm"/>
        <button disabled={busy || !name.trim()} onClick={() => void change({ action: 'create', name })} className="flex items-center gap-1 rounded border border-border px-2 text-xs disabled:opacity-40"><FolderPlus size={14}/>{t('sections.create')}</button></div>
      <div className="max-h-40 space-y-1 overflow-y-auto">{layout.sections.map((section, index) => <div key={section.id} className="flex items-center gap-1">
        <input key={section.name} aria-label={t('sections.rename', { name: section.name })} defaultValue={section.name} maxLength={80} disabled={busy} onBlur={event => { if (event.target.value.trim() !== section.name) void change({ action: 'rename', id: section.id, name: event.target.value }); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs"/>
        <button aria-label={t('sections.up', { name: section.name })} disabled={busy || index === 0} onClick={() => void change({ action: 'move', id: section.id, direction: 'up' })} className="p-1 disabled:opacity-30"><ArrowUp size={14}/></button>
        <button aria-label={t('sections.down', { name: section.name })} disabled={busy || index === layout.sections.length - 1} onClick={() => void change({ action: 'move', id: section.id, direction: 'down' })} className="p-1 disabled:opacity-30"><ArrowDown size={14}/></button>
        <button aria-label={t('sections.remove', { name: section.name })} disabled={busy} onClick={() => void change({ action: 'delete', id: section.id })} className="p-1 text-muted-foreground hover:text-destructive"><Trash2 size={14}/></button>
      </div>)}</div>
      <div className="flex items-center gap-2 border-t border-border pt-3"><select aria-label={t('sections.itemKind')} value={kind} onChange={event => { setKind(event.target.value as 'project' | 'session'); setQuery(''); }} className="rounded border border-border bg-background p-1 text-xs"><option value="project">{t('sections.projects')}</option><option value="session">{t('sections.sessions')}</option></select>
        <input aria-label={t('sections.search')} placeholder={t('sections.search')} value={query} onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm"/></div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">{available.map(item => <div key={item.id} className="flex items-center gap-3 rounded border border-border/60 p-2">
        <div className="min-w-0 flex-1"><p className="truncate text-xs">{item.title}</p><p className="truncate text-[10px] text-muted-foreground">{item.path}</p></div>
        <select aria-label={t('sections.moveItem', { name: item.title })} disabled={busy} value={layout.assignments.find(row => row.kind === kind && row.targetId === item.id)?.sectionId ?? ''} onChange={event => void change({ action: 'assign', kind, targetId: item.id, sectionId: event.target.value || null })} className="max-w-[45%] rounded border border-border bg-background p-1 text-xs"><option value="">{t('sections.unassigned')}</option>{layout.sections.map(section => <option key={section.id} value={section.id}>{section.name}</option>)}</select>
      </div>)}
        {kind === 'session' && page?.hasMore && <button className="p-2 text-xs text-muted-foreground" onClick={() => { const sequence = searchSequence.current; void api.sessionBridge.list(query, page.offset + page.sessions.length).then(unwrap<BridgeSessionPage>).then(next => { if (sequence === searchSequence.current) setPage(previous => previous ? { ...next, offset: 0, sessions: [...previous.sessions, ...next.sessions] } : next); }).catch(reason => setError(String(reason))); }}>{t('sections.more')}</button>}
      </div>
    </DialogContent></Dialog>
  </>;
}
