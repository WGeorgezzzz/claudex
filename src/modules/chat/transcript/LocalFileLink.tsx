import { useContext, useEffect, useRef, useState } from 'react';
import type { AnchorHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Copy, ExternalLink, FileText } from 'lucide-react';

import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { isAbbreviatedFileReference, parseLocalFileLink } from '@/modules/chat/utils/localFileLink';
import { copyTextToClipboard } from '@/shared/utils';
import { api } from '@/shared/api';

type LocalFileLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  fileReference: string;
  directories?: string[];
  onPreview?: (path: string, line: number | null) => void;
};

/** Markdown uses this for explicit links and inline file references, preserving left-click preview. */
export function LocalFileLink({ fileReference, directories = [], onPreview, children, onClick, title, ...props }: LocalFileLinkProps) {
  const { t } = useTranslation('chat');
  const { projectPath, projectId } = useContext(MarkdownWorkspaceContext);
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

  const resolvedPath = async () => {
    const { path } = parseLocalFileLink(fileReference);
    if (/^(?:[a-z]:\/|\/)/i.test(path)) return path;
    if (projectId && directories.length) {
      if (directories.length > 32) throw new Error('目录过多，无法确定文件位置，请使用绝对路径。');
      // Only probe paths explicitly named in this message. HEAD transfers no file payload.
      const candidates = [...new Set(directories.map(directory => directory.replace(/\/$/, '') + '/' + path))];
      const results = await Promise.all(candidates.map(async candidate => {
        const response = await api.readFileBlob(projectId, candidate, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
        if (!response.ok && response.status !== 404) throw new Error(`无法确认文件路径 (${response.status}): ${candidate}`);
        return response.ok ? candidate : null;
      }));
      const matches = results.filter((candidate): candidate is string => candidate !== null);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) throw new Error('找到多个同名文件，请使用完整路径：' + matches.join('；'));
      throw new Error('正文所列目录中未找到文件：' + path);
    }
    if (!projectPath) throw new Error(t('fileLink.noProject', 'The project path is unavailable. Open this conversation in its project first.'));
    // Resolve against this message's project, never the desktop process working directory.
    return `${projectPath.replace(/\\/g, '/').replace(/\/$/, '')}/${path}`;
  };
  const resolveAbbreviated = async (): Promise<string[]> => {
    const { path } = parseLocalFileLink(fileReference);
    if (!projectId) throw new Error(t('fileLink.noProject', 'The project path is unavailable. Open this conversation in its project first.'));
    const absolute = /^(?:[a-z]:\/|\/)/i.test(path);
    const bases = absolute ? [''] : directories.length ? directories : projectPath ? [projectPath] : [];
    if (!bases.length) throw new Error(t('fileLink.noProject', 'The project path is unavailable. Open this conversation in its project first.'));
    if (bases.length > 32) throw new Error('目录过多，无法确定文件位置，请使用绝对路径。');
    const candidates = [...new Set(bases.map(base => absolute ? path : base.replace(/\\/g, '/').replace(/\/$/, '') + '/' + path))];
    const failures: string[] = [];
    const results = await Promise.all(candidates.map(async candidate => {
      const response = await api.resolveFilePattern(projectId, candidate, { signal: AbortSignal.timeout(8000) });
      if (response.ok) return ((await response.json()) as { matches?: string[] }).matches ?? [];
      if (response.status !== 404) failures.push(`无法解析省略的文件名 (${response.status}): ${candidate}`);
      return [];
    }));
    const matches = [...new Set(results.flat().map(match => match.replace(/\\/g, '/')))];
    if (!matches.length) throw new Error(failures[0] ?? '未找到与省略文件名匹配的文件：' + path);
    setResolvedTitle(matches.length === 1 ? matches[0] : `找到 ${matches.length} 个匹配文件：\n${matches.join('\n')}`);
    return matches;
  };
  /** Runs an action on the referenced file, asking the user to choose when an abbreviation matches several files. */
  const withResolvedPath = async (action: (path: string) => unknown) => {
    const paths = abbreviated ? await resolveAbbreviated() : [await resolvedPath()];
    if (paths.length === 1) { await action(paths[0]); return; }
    setChoices({ paths, action });
  };
  const openLocally = async () => {
    if (opening) return;
    setPosition(null);
    setError(null);
    setOpening(true);
    try {
      const bridge = window as unknown as {
        cloudcliDesktopNotifications?: { openLocalPath?: (path: string) => Promise<unknown> };
        cloudcliDesktop?: { openLocalPath?: (path: string) => Promise<unknown> };
      };
      const open = bridge.cloudcliDesktopNotifications?.openLocalPath ?? bridge.cloudcliDesktop?.openLocalPath;
      if (!open) throw new Error(t('fileLink.desktopOnly', 'Open this link in the Claudex desktop app to use a local program.'));
      await withResolvedPath(path => open(path));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setOpening(false); }
  };
  const copyPath = async () => {
    setPosition(null);
    setError(null);
    try {
      await withResolvedPath(async path => {
        if (!await copyTextToClipboard(path)) throw new Error(t('fileLink.copyFailed', 'Unable to copy the file path.'));
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const menuClass = 'flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none disabled:opacity-50';
  return <>
    <a {...props} title={resolvedTitle ?? title} ref={linkRef} onMouseEnter={() => {
      if (!abbreviated || resolvedTitle || hoverResolving.current || !projectId) return;
      hoverResolving.current = true;
      void resolveAbbreviated().catch(() => { hoverResolving.current = false; });
    }} onClick={event => {
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
      void resolvedPath().then(path => onPreview(path, parseLocalFileLink(fileReference).line))
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
      <span className="text-muted-foreground">找到 {choices.paths.length} 个匹配文件：</span>
      {choices.paths.map(path => <button key={path} type="button" title={path}
        className="rounded border border-border px-1.5 py-0.5 font-mono hover:bg-accent"
        onClick={() => {
          const { action } = choices; setChoices(null);
          void Promise.resolve().then(() => action(path)).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
        }}>{path.split('/').pop()}</button>)}
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
      <button type="button" role="menuitem" className={menuClass} onClick={() => { setPosition(null); linkRef.current?.click(); }}><FileText size={15}/>{t('fileLink.preview', 'Preview in Claudex')}</button>
      <button type="button" role="menuitem" className={menuClass} onClick={() => void copyPath()}><Copy size={15}/>{t('fileLink.copyPath', 'Copy file path')}</button>
    </div>, document.body)}
  </>;
}
