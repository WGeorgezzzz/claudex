import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, FolderPlus, Settings2, Trash2, X } from 'lucide-react';

import { api, readApiErrorMessage } from '@/shared/api';
import { Dialog, DialogContent } from '@/shared/ui';
import type { BridgeSessionPage, SidebarProjectListProps, WorkspaceSectionsSnapshot } from '@/shared/types';
import SidebarProjectList from '@/modules/sidebar/SidebarProjectList';
import { useSessionWorkspace } from '@/modules/sidebar/context/SessionWorkspaceContext';

async function unwrap<T>(response: Response): Promise<T> {
  const body = await response.json(); if (!response.ok) throw new Error(readApiErrorMessage(body) || `HTTP ${response.status}`);
  return body.data;
}

/** SidebarContent renders persistent custom sections around its existing project rows. */
export function WorkspaceSections({ projectListProps, onSelect }: { projectListProps: SidebarProjectListProps; onSelect: (projectId: string | null, sessionId: string, provider: string) => void }) {
  const { t } = useTranslation('sidebar'); const workspace = useSessionWorkspace();
  // A server snapshot lets sections survive reloads and synchronize between clients.
  const [layout, setLayout] = useState<WorkspaceSectionsSnapshot | null>(null);
  // Organization controls do not navigate or replace a chat draft.
  const [open, setOpen] = useState(false);
  // Preserve a new section name until its request succeeds.
  const [name, setName] = useState('');
  // Show rejected writes, including revision conflicts, without silently overwriting another client.
  const [error, setError] = useState('');
  // Serialize layout mutations while waiting for their authoritative result.
  const [busy, setBusy] = useState(false);
  // Search projects locally and sessions through a bounded server query.
  const [query, setQuery] = useState('');
  // Switching assignment kind leaves the active conversation alone.
  const [kind, setKind] = useState<'project' | 'session'>('project');
  // Retain one paginated server search result for assigning conversations.
  const [page, setPage] = useState<BridgeSessionPage | null>(null);
  const writing = useRef(false); const searchSequence = useRef(0);
  useEffect(() => {
    let live = true;
    const load = async () => { try { const value = await unwrap<WorkspaceSectionsSnapshot>(await api.workspaceSections.list()); if (live) setLayout(value); } catch { /* Older/offline servers keep their ordinary project list. */ } };
    load(); const timer = setInterval(load, 15000); return () => { live = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!open || kind !== 'session') return;
    const sequence = ++searchSequence.current;
    const timer = setTimeout(() => { void api.sessionBridge.list(query).then(unwrap<BridgeSessionPage>).then(value => {
      if (sequence === searchSequence.current) setPage(value);
    }).catch(reason => { if (sequence === searchSequence.current) setError(String(reason)); }); }, 200);
    return () => { clearTimeout(timer); searchSequence.current++; };
  }, [open, kind, query]);
  const change = async (input: Record<string, unknown>) => {
    if (!layout || writing.current) return;
    writing.current = true; setBusy(true); setError('');
    try { setLayout(await unwrap<WorkspaceSectionsSnapshot>(await api.workspaceSections.update({ ...input, revision: layout.revision }))); if (input.action === 'create') setName(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); try { setLayout(await unwrap<WorkspaceSectionsSnapshot>(await api.workspaceSections.list())); } catch { /* Keep the last usable snapshot. */ } }
    finally { writing.current = false; setBusy(false); }
  };
  // Older backends still show their ordinary project list without unsupported controls.
  if (!layout) return <SidebarProjectList {...projectListProps}/>;
  const assignedSessions = new Set(layout.assignments.filter(item => item.kind === 'session').map(item => item.targetId));
  const assignedProject = (id: string) => layout.assignments.find(item => item.kind === 'project' && item.targetId === id)?.sectionId;
  const listProps = { ...projectListProps, getProjectSessions: (project: Parameters<SidebarProjectListProps['getProjectSessions']>[0]) => projectListProps.getProjectSessions(project).filter(row => !assignedSessions.has(row.id)) };
  const available = kind === 'project' ? projectListProps.projects.filter(project => `${project.displayName} ${project.fullPath}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(project => ({ id: project.projectId, title: project.displayName, path: project.fullPath }))
    : (page?.sessions ?? []).map(session => ({ id: session.sessionId, title: session.title, path: session.projectPath }));
  const unassigned = projectListProps.filteredProjects.filter(project => !assignedProject(project.projectId));
  return <>
    <div className="mx-3 mb-2 flex items-center justify-between"><span className="text-xs font-medium text-muted-foreground">{t('sections.title')}</span>
      <button type="button" aria-label={t('sections.manage')} onClick={() => setOpen(true)} className="rounded p-1.5 text-muted-foreground hover:bg-muted"><Settings2 size={14}/></button></div>
    {error && !open && <p role="alert" className="mx-3 text-xs text-destructive">{error}</p>}
    {layout.sections.map(section => {
      const projects = projectListProps.filteredProjects.filter(project => assignedProject(project.projectId) === section.id);
      const sessions = layout.sessionItems.filter(session => layout.assignments.some(item => item.kind === 'session' && item.targetId === session.sessionId && item.sectionId === section.id));
      return <section key={section.id} aria-label={section.name} className="mb-3">
        <button type="button" disabled={busy} aria-expanded={!section.collapsed} onClick={() => void change({ action: 'collapse', id: section.id, collapsed: !section.collapsed })} className="mx-2 flex w-[calc(100%-1rem)] items-center gap-1 rounded px-1 py-1.5 text-xs font-semibold hover:bg-muted">
          {section.collapsed ? <ChevronRight size={13}/> : <ChevronDown size={13}/>}<span className="min-w-0 flex-1 truncate text-left">{section.name}</span><span className="text-muted-foreground">{projects.length + sessions.length}</span>
        </button>
        {!section.collapsed && <>{projects.length > 0 && <SidebarProjectList {...listProps} projects={projects} filteredProjects={projects}/>}
          {sessions.map(session => <a key={session.sessionId} title={session.projectPath||session.provider} href={`/session/${encodeURIComponent(session.sessionId)}`} className={`mx-3 block rounded px-2 py-2 text-[13px] hover:bg-muted ${projectListProps.selectedSession?.id === session.sessionId ? 'bg-muted' : ''}`} onClick={event => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault(); onSelect(session.projectId, session.sessionId, session.provider);
          }}><span className="block truncate">{projectListProps.activeSessions.has(session.sessionId) ? '◌ ' : workspace?.byId.get(session.sessionId)?.unread ? '● ' : ''}{session.title}</span></a>)}
          {projects.length + sessions.length === 0 && <p className="mx-5 py-2 text-[11px] text-muted-foreground">{t('sections.empty')}</p>}
        </>}
      </section>;
    })}
    <h3 className="mx-3 mb-1 text-xs font-medium text-muted-foreground">{t('sections.unassigned')}</h3>
    {(unassigned.length > 0 || projectListProps.projects.length === 0 || projectListProps.isLoading) && <SidebarProjectList {...listProps} filteredProjects={unassigned}/>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent aria-label={t('sections.manage')} className="flex max-h-[85dvh] max-w-2xl flex-col overflow-hidden">
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
