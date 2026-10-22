import { useContext, useEffect, useRef, useState } from 'react';
import type { AnchorHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Copy, ExternalLink, FileText } from 'lucide-react';

import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { parseLocalFileLink } from '@/modules/chat/utils/localFileLink';
import { copyTextToClipboard } from '@/shared/utils';
import { api } from '@/shared/api';

type LocalFileLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  fileReference: string;
  directories?: string[];
  onPreview?: (path: string, line: number | null) => void;
};

/** Markdown uses this for explicit links and inline file references, preserving left-click preview. */
export function LocalFileLink({ fileReference, directories = [], onPreview, children, onClick, ...props }: LocalFileLinkProps) {
  const { t } = useTranslation('chat');
  const { projectPath, projectId } = useContext(MarkdownWorkspaceContext);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The pointer position anchors the one open menu independently of transcript scrolling.
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  // Surface OS launch failures beside the link instead of reporting success prematurely.
  const [error, setError] = useState<string | null>(null);
  // Prevent duplicate OS launches while the desktop bridge is handling a request.
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!position) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const dismiss = () => setPosition(null);
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
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
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
      if (!open) throw new Error(t('fileLink.desktopOnly', 'Open this link in the CloudCLI desktop app to use a local program.'));
      await open(await resolvedPath());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setOpening(false); }
  };
  const copyPath = async () => {
    setPosition(null);
    setError(null);
    try {
      if (!await copyTextToClipboard(await resolvedPath())) throw new Error(t('fileLink.copyFailed', 'Unable to copy the file path.'));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const menuClass = 'flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none disabled:opacity-50';
  return <>
    <a {...props} ref={linkRef} onClick={event => {
      if (!onPreview) { onClick?.(event); return; }
      event.preventDefault(); setError(null);
      const reference = parseLocalFileLink(fileReference);
      // Preserve immediate preview for exact paths and callers outside a workspace.
      if (/^(?:[a-z]:\/|\/)/i.test(reference.path) || (!projectPath && !directories.length)) {
        onPreview(reference.path, reference.line); return;
      }
      void resolvedPath().then(path => onPreview(path, parseLocalFileLink(fileReference).line))
        .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
    }}
      onContextMenu={event => {
        event.preventDefault(); event.stopPropagation(); setError(null);
        setPosition({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 248)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 150)) });
      }}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          setPosition({ x: Math.max(8, Math.min(bounds.left, window.innerWidth - 248)), y: Math.max(8, Math.min(bounds.bottom, window.innerHeight - 150)) });
        }
      }}>{children}</a>
    {error && <span role="alert" className="ml-2 text-xs text-red-600 dark:text-red-400">{error}</span>}
    {position && createPortal(<div ref={menuRef} role="menu" aria-label={t('fileLink.menu', 'File actions')}
      className="fixed z-[10000] w-60 max-w-[calc(100vw-16px)] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{ left: position.x, top: position.y }}
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
      <button type="button" role="menuitem" className={menuClass} disabled={opening} onClick={() => void openLocally()}><ExternalLink size={15}/>{t('fileLink.openLocally', 'Open locally')}</button>
      <button type="button" role="menuitem" className={menuClass} onClick={() => { setPosition(null); linkRef.current?.click(); }}><FileText size={15}/>{t('fileLink.preview', 'Preview in CloudCLI')}</button>
      <button type="button" role="menuitem" className={menuClass} onClick={() => void copyPath()}><Copy size={15}/>{t('fileLink.copyPath', 'Copy file path')}</button>
    </div>, document.body)}
  </>;
}
