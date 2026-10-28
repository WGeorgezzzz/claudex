import { useContext, useEffect, useRef, useState } from 'react';
import type { AnchorHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Copy, ExternalLink, FileText } from 'lucide-react';

import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { isAbbreviatedFileReference, parseLocalFileLink } from '@/modules/chat/utils/localFileLink';
import { copyLocalPath, openLocalFile } from '@/shared/localPath';
import { api } from '@/shared/api';

type LocalFileLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  fileReference: string;
  directories?: string[];
  onPreview?: (path: string, line: number | null) => void;
};

/** Markdown uses this for explicit links and inline file references, preserving left-click preview. */
export function LocalFileLink({ fileReference, directories = [], onPreview, children, onClick, title, ...props }: LocalFileLinkProps) {
  const { t } = useTranslation('chat');
  const { projectPath, projectId, cwd } = useContext(MarkdownWorkspaceContext);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The pointer position anchors the one open menu independently of transcript scrolling.
  const [position, setPosition] = useState<{ x: number; y: number; width: number; maxHeight: number } | null>(null);
  // Surface OS launch failures beside the link instead of reporting success prematurely.
  const [error, setError] = useState<string | null>(null);
  // Prevent duplicate OS launches while the desktop bridge is handling a request.
  const [opening, setOpening] = useState(false);
  // An ellipsis-abbreviated name resolves to real files on the server; the tooltip then shows the full path.
  const [resolvedTitle, setResolvedTitle] = useState<string | null>(null);
  // Several files can match one abbreviation; the user picks one for the pending action.
  const [choices, setChoices] = useState<{ paths: string[]; action: (path: string) => unknown } | null>(null);
  const hoverResolving = useRef(false);
  const abbreviated = isAbbreviatedFileReference(fileReference);

  const openMenuAt = (x: number, y: number) => {
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + 8;
    const top = (viewport?.offsetTop ?? 0) + 8;
    const width = Math.max(0, Math.min(240, (viewport?.width ?? window.innerWidth) - 16));
    const right = left + (viewport?.width ?? window.innerWidth) - 16;
    const bottom = top + (viewport?.height ?? window.innerHeight) - 16;
    const menuTop = Math.max(top, Math.min(y, bottom - 150));
    setPosition({ x: Math.max(left, Math.min(x, right - width)), y: menuTop, width, maxHeight: Math.max(0, bottom - menuTop) });
  };

  useEffect(() => {
    if (!position) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const dismiss = () => setPosition(null);
    const dismissOnScroll = (event: Event) => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) dismiss();
    };
    const outside = (event: MouseEvent) => {
      if(touchHeld.current) return;
      if (!menuRef.current?.contains(event.target as Node)) dismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        dismiss();
        if (event.key === 'Escape') { event.preventDefault(); linkRef.current?.focus(); }
      }
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', dismissOnScroll, true);
    window.addEventListener('resize', dismiss);
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', dismiss);
    viewport?.addEventListener('scroll', dismiss);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', dismissOnScroll, true);
      window.removeEventListener('resize', dismiss);
      viewport?.removeEventListener('resize', dismiss);
      viewport?.removeEventListener('scroll', dismiss);
    };
  }, [position]);

  const candidateGroups = () => {
    const {path} = parseLocalFileLink(fileReference);
    if (/^(?:[a-z]:\/|\/)/i.test(path)) return [[path]];
    const roots = [...new Set([cwd,projectPath].filter((p):p is string=>Boolean(p)).map(p=>p.replace(/\\/g,'/').replace(/\/$/,'')))];
    if (!roots.length) throw new Error('会话工作目录不可用，请使用绝对路径');
    if (directories.length > 32) throw new Error('目录过多，请使用绝对路径');
    const join=(base:string,relative:string)=>base.replace(/\/$/,'')+'/'+relative;
    return [directories.flatMap(dir=> /^(?:[a-z]:\/|\/)/i.test(dir) ? [join(dir,path)] : roots.map(root=>join(join(root,dir),path))),...roots.map(root=>[join(root,path)])].filter(group=>group.length);
  };
  const resolvePaths = async (): Promise<string[]> => {
    const groups = candidateGroups();
    if(!abbreviated && /^(?:[a-z]:\/|\/)/i.test(parseLocalFileLink(fileReference).path)) return groups[0];
    if (!projectId || (!directories.length && !cwd && !abbreviated)) return groups[0];
    const tried:string[]=[]; const failures:string[]=[];
    for (const group of groups) {
      const matches:string[]=[];
      for(const candidate of [...new Set(group)]) {
        tried.push(candidate);
        const response = abbreviated
          ? await api.resolveFilePattern(projectId!, candidate, {signal:AbortSignal.timeout(8000)})
          : await api.readFileBlob(projectId!, candidate, {method:'HEAD',signal:AbortSignal.timeout(8000)});
        if(response.ok) {
          if(abbreviated) matches.push(...((await response.json()) as {matches:string[]}).matches);
          else matches.push(candidate);
        } else if(response.status!==404) failures.push('读取被拒或路径不可用 ('+response.status+'): '+candidate);
      }
      const unique=[...new Set(matches.map(p=>p.replace(/\\/g,'/')))];
      if(unique.length) {setResolvedTitle(unique.join('\n'));return unique;}
    }
    throw new Error((failures.length?failures.join('；'):'未找到文件')+'；已尝试：'+tried.join('；'));
  };
  const resolveAbbreviated = resolvePaths;
  const withResolvedPath = async (action:(path:string)=>unknown) => {
    const paths=await resolvePaths();
    if(paths.length===1){await action(paths[0]);return;}
    setChoices({paths,action});
  };
  const openLocally = async () => {
    if (opening) return;
    setPosition(null);
    setError(null);
    setOpening(true);
    try {
      await withResolvedPath(path => openLocalFile(path));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setOpening(false); }
  };
  const copyPath = async (folder = false) => {
    setPosition(null);
    setError(null);
    try {
      await withResolvedPath(async path => {
        await copyLocalPath(path,folder);
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const reveal = async () => {
    setPosition(null);setError(null);
    try {await withResolvedPath(path=>openLocalFile(path,true));}
    catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
  };
  const touchHeld=useRef(false);
  const touchTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const cancelTouch=()=>{if(touchTimer.current)clearTimeout(touchTimer.current);touchTimer.current=null;};
  useEffect(()=>cancelTouch,[]);
  const menuClass = 'flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none disabled:opacity-50';
  return <>
    <a {...props} onTouchStart={event=>{const touch=event.touches[0];cancelTouch();touchHeld.current=false;touchTimer.current=setTimeout(()=>{touchHeld.current=true;openMenuAt(touch.clientX,touch.clientY);},550);}} onTouchEnd={cancelTouch} onTouchMove={cancelTouch} onTouchCancel={cancelTouch} title={resolvedTitle ?? title} ref={linkRef} onMouseEnter={() => {
      if (!abbreviated || resolvedTitle || hoverResolving.current || !projectId) return;
      hoverResolving.current = true;
      void resolveAbbreviated().catch(() => { hoverResolving.current = false; });
    }} onClick={event => {
      if(touchHeld.current){event.preventDefault();event.stopPropagation();touchHeld.current=false;return;}
      if (!onPreview) { onClick?.(event); return; }
      event.preventDefault(); setError(null); setChoices(null);
      const reference = parseLocalFileLink(fileReference);
      if (abbreviated) {
        void withResolvedPath(path => onPreview(path, reference.line)).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
        return;
      }
      // Preserve immediate preview for exact paths and callers outside a workspace.
      if (/^(?:[a-z]:\/|\/)/i.test(reference.path) || (!projectPath && !directories.length)) {
        onPreview(reference.path, reference.line); return;
      }
      void withResolvedPath(path => onPreview(path, reference.line))
        .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
    }}
      onContextMenu={event => {
        event.preventDefault(); event.stopPropagation(); setError(null);
        openMenuAt(event.clientX, event.clientY);
      }}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          openMenuAt(bounds.left, bounds.bottom);
        }
      }}>{children}</a>
    {choices && <span role="group" aria-label="匹配的文件" className="ml-2 inline-flex flex-wrap items-center gap-1 align-middle text-xs">
      <span className="text-muted-foreground">找到多个同名文件（{choices.paths.length} 个匹配文件），请选择：</span>
      {choices.paths.map(path => <button key={path} type="button" title={path}
        className="rounded border border-border px-1.5 py-0.5 font-mono hover:bg-accent"
        onClick={() => {
          const { action } = choices; setChoices(null);
          void Promise.resolve().then(() => action(path)).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
        }}>{choices.paths.filter(candidate=>candidate.split('/').pop()===path.split('/').pop()).length>1?path:path.split('/').pop()}</button>)}
    </span>}
    {error && <span role="alert" className="ml-2 text-xs text-red-600 dark:text-red-400">{error}</span>}
    {position && createPortal(<div ref={menuRef} role="menu" aria-label={t('fileLink.menu', 'File actions')}
      className="fixed z-[10000] overflow-y-auto overflow-x-hidden overscroll-contain rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{ left: position.x, top: position.y, width: position.width, maxHeight: position.maxHeight }}
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
      <button type="button" role="menuitem" className={menuClass} disabled={opening} onClick={() => void openLocally()}><ExternalLink size={15}/>{t('fileLink.openLocally', 'Open locally')}</button>
      <button type="button" role="menuitem" className={menuClass} onClick={() => { setPosition(null); linkRef.current?.click(); }}><FileText size={15}/>{t('fileLink.preview', 'Preview in Nexagent')}</button>
      <button type="button" role="menuitem" className={menuClass} onClick={() => void reveal()}>打开所在文件夹</button>
      <button type="button" role="menuitem" className={menuClass} onClick={() => void copyPath(true)}>复制文件夹路径</button>
      <button type="button" role="menuitem" className={menuClass} onClick={() => void copyPath()}><Copy size={15}/>{t('fileLink.copyPath', 'Copy file path')}</button>
    </div>, document.body)}
  </>;
}
