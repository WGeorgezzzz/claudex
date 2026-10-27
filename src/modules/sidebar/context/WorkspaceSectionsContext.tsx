import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { api, readApiErrorMessage } from '@/shared/api';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { WorkspaceSectionsSnapshot, WorkspaceSectionTarget } from '@/shared/types';

type SectionsState = {
  layout: WorkspaceSectionsSnapshot | null;
  busy: boolean;
  error: string;
  change: (input: Record<string, unknown>) => Promise<boolean>;
  openMove: (target: WorkspaceSectionTarget, point?: { x: number; y: number }) => void;
};
const SectionsContext = createContext<SectionsState | null>(null);
async function read(response: Response): Promise<WorkspaceSectionsSnapshot> {
  const body = await response.json();
  if (!response.ok) throw new Error(readApiErrorMessage(body) || `HTTP ${response.status}`);
  return body.data;
}

/** SidebarContent shares one revisioned section snapshot with every row and inbox menu. */
export function WorkspaceSectionsProvider({ children }: { children: ReactNode }) {
  // All sidebar entry points observe the same authoritative assignment after a write.
  const [layout, setLayout] = useState<WorkspaceSectionsSnapshot | null>(null);
  // Disable concurrent writes rather than losing a user's earlier operation.
  const [busy, setBusy] = useState(false);
  // Retain rejected writes until retry, including revision conflicts.
  const [error, setError] = useState('');
  // A single move menu serves desktop context menus, overflow menus and touch rows.
  const [target, setTarget] = useState<WorkspaceSectionTarget | null>(null);
  // Creating from a row keeps the target intact until the atomic request succeeds.
  const [creating, setCreating] = useState(false);
  // Desktop pickers stay beside their source row; touch uses the full-width sheet.
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  // Preserve the draft on validation errors so it can be corrected in place.
  const [name, setName] = useState('');
  const writing = useRef(false), sequence = useRef(0), current = useRef(layout);
  current.current = layout;
  useEffect(() => {
    let live = true;
    const load = async () => {
      const request = ++sequence.current;
      try { const next = await read(await api.workspaceSections.list()); if (live && request === sequence.current && !writing.current) setLayout(next); } catch { /* Older servers retain ordinary navigation. */ }
    };
    void load(); const timer = setInterval(() => void load(), 15000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const change = async (input: Record<string, unknown>) => {
    if (!current.current || writing.current) return false;
    writing.current = true; sequence.current++; setBusy(true); setError('');
    try {
      const next = await read(await api.workspaceSections.update({ ...input, revision: current.current.revision }));
      current.current = next; setLayout(next); return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      try { const next = await read(await api.workspaceSections.list()); current.current = next; setLayout(next); } catch { /* Keep the last usable snapshot. */ }
      return false;
    } finally { writing.current = false; setBusy(false); }
  };
  const openMove = (next: WorkspaceSectionTarget, point?: { x: number; y: number }) => {
    const bounds = document.activeElement?.getBoundingClientRect();
    setPosition(window.innerWidth >= 768 ? { x: Math.max(8, Math.min(point?.x ?? bounds?.right ?? 280, window.innerWidth - 328)), y: Math.max(8, Math.min(point?.y ?? bounds?.top ?? 160, window.innerHeight - 420)) } : null);
    setTarget(next); setCreating(false); setName(''); setError('');
  };
  const assign = async (sectionId: string | null) => {
    if (target && await change({ action: 'assign', kind: target.kind, targetId: target.targetId, sectionId })) setTarget(null);
  };
  const selected = layout?.assignments.find(row => row.kind === target?.kind && row.targetId === target?.targetId)?.sectionId;
  return <SectionsContext.Provider value={{ layout, busy, error, change, openMove }}>
    {children}
    <Dialog open={!!target} onOpenChange={open => { if (!open) setTarget(null); }}><DialogContent wrapperClassName={position ? 'z-[110] [&>div:first-child]:bg-transparent [&>div:first-child]:backdrop-blur-none' : 'z-[110]'} aria-label="移到分区"
      className={position ? 'max-h-[80dvh] w-80 max-w-sm translate-x-0 translate-y-0 overflow-y-auto p-3' : 'bottom-0 left-0 top-auto max-h-[80dvh] w-full max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-b-none p-4'}
      style={position ? { left: position.x, top: position.y } : undefined}>
      <DialogTitle className="not-sr-only font-semibold">移到分区 ▸</DialogTitle>
      <p className="truncate text-xs text-muted-foreground">{target?.title}</p>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div role="menu" aria-label="选择分区" className="space-y-1">{layout?.sections.map(section => <button type="button" role="menuitemradio" aria-checked={selected === section.id} key={section.id} disabled={busy} className="flex min-h-10 w-full items-center justify-between rounded px-3 text-left text-sm hover:bg-muted" onClick={() => void assign(section.id)}><span>{section.name}</span>{selected === section.id && <span aria-hidden>✓</span>}</button>)}
        <button type="button" role="menuitem" disabled={busy} className="min-h-10 w-full rounded px-3 text-left text-sm hover:bg-muted" onClick={() => { setCreating(true); setName(''); }}>＋ 新建分区…</button>
        <button type="button" role="menuitem" disabled={busy || !selected} className="min-h-10 w-full rounded px-3 text-left text-sm hover:bg-muted disabled:opacity-40" onClick={() => void assign(null)}>移出分区</button>
      </div>
      {creating && <form onSubmit={event => { event.preventDefault(); if (target) void change({ action: 'create-assign', name, kind: target.kind, targetId: target.targetId }).then(ok => { if (ok) setTarget(null); }); }} className="flex gap-2">
        <input autoFocus aria-label="新分区名称" maxLength={80} value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setCreating(false); } }} className="min-w-0 flex-1 rounded border border-border bg-background p-2 text-base"/>
        <button disabled={busy || !name.trim()} className="rounded bg-primary px-3 text-xs text-primary-foreground disabled:opacity-40">创建并移入</button>
      </form>}
      <button type="button" className="min-h-10 w-full text-sm text-muted-foreground" onClick={() => setTarget(null)}>取消</button>
    </DialogContent></Dialog>
  </SectionsContext.Provider>;
}

/** Sidebar section headers, project rows and session menus consume this shared owner. */
export function useWorkspaceSections() { return useContext(SectionsContext); }
