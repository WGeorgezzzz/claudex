import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronRight,
  FileText,
  GitCommit,
  GitMerge,
  MessageSquare,
  MessageSquarePlus,
  Pin,
  Circle,
  RefreshCw,
  Settings,
  SunMoon,
  X,
} from 'lucide-react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/shared/ui';
import { useTheme } from '@/shared/context/ThemeContext';
import { usePaletteOps, usePaletteOpsRegister } from '@/modules/command-palette/context/PaletteOpsContext';
import { SETTINGS_MAIN_TABS } from '@/shared/constants';
import type { AppTab, PaletteSessionEntry, Project } from '@/shared/types';
import { useBusySessionIdSet } from '@/shared/context/SessionProtectionContext';
import { usePaletteSessionStatus } from '@/modules/command-palette/hooks/usePaletteSessionStatus';
import { useSessionsSource } from '@/modules/command-palette/hooks/useSessionsSource';
import { useFilesSource } from '@/modules/command-palette/hooks/useFilesSource';
import { useCommitsSource } from '@/modules/command-palette/hooks/useCommitsSource';
import { useSessionMessageSearch } from '@/modules/command-palette/hooks/useSessionMessageSearch';
import { useBranchesSource } from '@/modules/command-palette/hooks/useBranchesSource';
import { useGitActions } from '@/modules/command-palette/hooks/useGitActions';

type Page = 'actions' | 'files' | 'sessions' | 'commits' | 'branches';

type CommandPaletteProps = {
  selectedProject: Project | null;
  onStartNewChat: (project: Project) => void;
  onOpenSettings: (tab?: string) => void;
  onShowTab?: (tab: AppTab) => void;
  onSelectSession?: (entry: PaletteSessionEntry) => void;
};

const NAV_TABS: Array<{ id: AppTab; labelKey: string; keywords: string }> = [
  { id: 'chat', labelKey: 'commandPalette.navChat', keywords: 'chat messages conversation' },
  { id: 'files', labelKey: 'commandPalette.navFiles', keywords: 'files file tree explorer' },
  { id: 'shell', labelKey: 'commandPalette.navShell', keywords: 'shell terminal console' },
  { id: 'git', labelKey: 'commandPalette.navGit', keywords: 'git diff branches' },
  { id: 'tasks', labelKey: 'commandPalette.navTasks', keywords: 'tasks taskmaster' },
];

/** Rendered by the project-workspace module to search projects, sessions, files, branches and commits and run their actions. */
function CommandPalette({
  selectedProject,
  onStartNewChat,
  onOpenSettings,
  onShowTab,
  onSelectSession,
}: CommandPaletteProps) {
  const { t } = useTranslation();
  // Dialog visibility, text and page stack preserve keyboard-driven navigation within one opening.
  const [open, setOpen] = React.useState(false);
  // The query is shared by local title matching and cancellable transcript search.
  const [search, setSearch] = React.useState('');
  // A page stack lets Backspace return to the previous command group.
  const [pages, setPages] = React.useState<Page[]>([]);
  // Users can constrain session discovery without changing the project's file/git actions.
  const [sessionScope, setSessionScope] = React.useState<'all' | 'project'>('all');
  const { toggleDarkMode } = useTheme();
  const navigate = useNavigate();
  const ops = usePaletteOps();
  const searchInput = React.useRef<HTMLInputElement>(null);
  const busySessionIds = useBusySessionIdSet();
  const openSessionSwitcher = React.useCallback(() => { setSearch(''); setPages(['sessions']); setSessionScope('all'); setOpen(true); }, []);
  usePaletteOpsRegister({openSessionSwitcher});

  const page = pages.at(-1);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.repeat) return;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault(); openSessionSwitcher(); return;
      }
      const isCmdK = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k';
      if (!isCmdK) return;
      e.preventDefault();
      setOpen((prev) => !prev);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [openSessionSwitcher]);

  React.useEffect(() => {
    if (!open) {
      setSearch('');
      setPages([]);
    }
  }, [open]);

  const projectId = selectedProject?.projectId;

  const showActions = !page || page === 'actions';
  const showSessions = !page || page === 'sessions';
  const showFiles = !page || page === 'files';
  const showCommits = !page || page === 'commits';
  const showBranches = !page || page === 'branches' || page === 'actions';

  const sessionProjectId = sessionScope === 'project' ? projectId : undefined;
  const sessionSearchEnabled = open && showSessions && (sessionScope === 'all' || !!projectId);
  const sessions = useSessionsSource(sessionProjectId, sessionSearchEnabled);
  const messageMatches = useSessionMessageSearch(sessionProjectId, search, sessionSearchEnabled);
  const organization = usePaletteSessionStatus(open && showSessions);
  const organizationById = React.useMemo(() => new Map(organization.map(row => [row.sessionId, row])), [organization]);
  const files = useFilesSource(projectId, open && showFiles, search);
  const commits = useCommitsSource(projectId, open && showCommits);
  const branches = useBranchesSource(projectId, open && showBranches);
  const git = useGitActions(projectId);

  const sessionRows = React.useMemo(() => {
    if (!showSessions) return [];
    const byId = new Map<string, PaletteSessionEntry>();
    for (const s of sessions.items) {
      byId.set(s.id, s);
    }
    for (const row of organization) {
      if (row.pinnedAt !== null && (!sessionProjectId || row.projectId === sessionProjectId) && !byId.has(row.sessionId))
        byId.set(row.sessionId, {id: row.sessionId, label: row.title, provider: row.provider, projectId: row.projectId, projectName: row.projectPath ?? undefined});
    }
    for (const row of messageMatches.items) byId.set(row.id, {...byId.get(row.id), ...row});
    return Array.from(byId.values()).sort((a, b) => (organizationById.get(b.id)?.pinnedAt ?? 0) - (organizationById.get(a.id)?.pinnedAt ?? 0));
  }, [sessions.items, messageMatches.items, organization, organizationById, sessionProjectId, showSessions]);

  const run = React.useCallback((fn: () => void) => {
    setOpen(false);
    fn();
  }, []);

  const pushPage = React.useCallback((next: Page) => {
    setSearch('');
    setPages((prev) => [...prev, next]);
  }, []);

  const popPage = React.useCallback(() => {
    setSearch('');
    setPages((prev) => prev.slice(0, -1));
  }, []);

  const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !search && pages.length > 0) {
      e.preventDefault();
      popPage();
    }
  }, [search, pages.length, popPage]);

  const startNewChatDisabled = !selectedProject;
  const browseLimit = 5;
  const filesShown = page === 'files' ? files : files.slice(0, browseLimit);
  const commitsShown = page === 'commits' ? commits : commits.slice(0, browseLimit);
  const sessionsShown = page === 'sessions' || search.trim() ? sessionRows : sessionRows.slice(0, browseLimit);
  const branchesShown = page === 'branches' ? branches : branches.slice(0, browseLimit);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl overflow-hidden p-0" initialFocusRef={searchInput}>
        <DialogTitle>{t('commandPalette.title')}</DialogTitle>
        <Command label={t('commandPalette.title')} onKeyDown={handleKeyDown}>
          {page && (
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <span className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
                {t(`commandPalette.pages.${page}`)}
                <button
                  type="button"
                  onClick={popPage}
                  aria-label={t('commandPalette.backToAll')}
                  className="ml-0.5 rounded-sm opacity-70 hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
              <span className="text-xs text-muted-foreground">{t('commandPalette.backspaceHint')}</span>
            </div>
          )}
          <CommandInput
            ref={searchInput}
            placeholder={page
              ? t('commandPalette.searchPage', { page: t(`commandPalette.pages.${page}`).toLowerCase() })
              : t('commandPalette.searchAnything')}
            value={search}
            onValueChange={setSearch}
          />
          {showSessions && <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
            <span className="text-muted-foreground">{t('commandPalette.sessionScope')}</span>
            <button type="button" aria-pressed={sessionScope === 'all'} onClick={() => setSessionScope('all')} className={`rounded px-2 py-1 ${sessionScope === 'all' ? 'bg-accent' : ''}`}>{t('commandPalette.allProjects')}</button>
            <button type="button" disabled={!projectId} aria-pressed={sessionScope === 'project'} onClick={() => setSessionScope('project')} className={`rounded px-2 py-1 disabled:opacity-40 ${sessionScope === 'project' ? 'bg-accent' : ''}`}>{t('commandPalette.currentProject')}</button>
          </div>}
          <CommandList>
            <CommandEmpty>{sessions.loading || messageMatches.searching ? t('commandPalette.searching') : t('commandPalette.noResults')}</CommandEmpty>
            {showSessions && (sessions.error || messageMatches.error) && <div role="alert" className="px-3 py-2 text-xs text-destructive">{t('commandPalette.sessionLoadFailed')}
              <button className="ml-2 underline" onClick={() => { if (sessions.error) void sessions.retry(); if (messageMatches.error) messageMatches.retry(); }}>{t('commandPalette.retry')}</button>
            </div>}
            {showSessions && messageMatches.searching && <div role="status" className="px-3 py-1 text-xs text-muted-foreground">{t('commandPalette.searching')}</div>}

            {showActions && (
              <CommandGroup heading={t('commandPalette.groupActions')}>
                <CommandItem value={`${t('commandPalette.switchSession')} sessions conversations`} onSelect={() => pushPage('sessions')}>
                  <MessageSquare className="h-4 w-4"/><span className="flex-1">{t('commandPalette.switchSession')}</span><kbd className="text-xs text-muted-foreground">Ctrl/⌘ ⇧ K</kbd>
                </CommandItem>
                <CommandItem
                  value={`${t('commandPalette.startNewChat')} new chat`}
                  disabled={startNewChatDisabled}
                  onSelect={() => {
                    if (!selectedProject) return;
                    run(() => onStartNewChat(selectedProject));
                  }}
                >
                  <MessageSquarePlus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.startNewChat')}</span>
                  {startNewChatDisabled && (
                    <span className="text-xs text-muted-foreground">{t('commandPalette.selectProjectFirst')}</span>
                  )}
                </CommandItem>
                <CommandItem value={`${t('commandPalette.openSettings')} settings`} onSelect={() => run(() => onOpenSettings())}>
                  <Settings className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.openSettings')}</span>
                </CommandItem>
                <CommandItem value={`${t('commandPalette.toggleTheme')} dark light mode`} onSelect={() => run(toggleDarkMode)}>
                  <SunMoon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.toggleTheme')}</span>
                </CommandItem>
              </CommandGroup>
            )}

            {showActions && (
              <CommandGroup heading={t('commandPalette.groupNavigate')}>
                {NAV_TABS.map((tab) => (
                  <CommandItem
                    key={tab.id as string}
                    value={`${t(tab.labelKey)} ${tab.keywords}`}
                    onSelect={() => run(() => onShowTab?.(tab.id))}
                  >
                    <span className="flex-1">{t(tab.labelKey)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {showActions && projectId && (
              <CommandGroup heading={t('commandPalette.groupGit')}>
                <CommandItem
                  value={`${t('commandPalette.gitFetch')} fetch remote`}
                  onSelect={() => run(() => { void git.fetch(); onShowTab?.('git'); })}
                >
                  <RefreshCw className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.gitFetch')}</span>
                </CommandItem>
                <CommandItem
                  value={`${t('commandPalette.gitPull')} pull merge upstream`}
                  onSelect={() => run(() => { void git.pull(); onShowTab?.('git'); })}
                >
                  <ArrowDownToLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.gitPull')}</span>
                </CommandItem>
                <CommandItem
                  value={`${t('commandPalette.gitPush')} push origin remote`}
                  onSelect={() => run(() => { void git.push(); onShowTab?.('git'); })}
                >
                  <ArrowUpFromLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.gitPush')}</span>
                </CommandItem>
              </CommandGroup>
            )}

            {showActions && (
              <CommandGroup heading={t('commandPalette.groupSettings')}>
                {SETTINGS_MAIN_TABS.map(({ id, label, keywords, icon: Icon }) => (
                  <CommandItem
                    key={id}
                    value={`Settings ${label} ${keywords}`}
                    onSelect={() => run(() => onOpenSettings(id))}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1">{t('commandPalette.settingsItem', { label })}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {showSessions && sessionsShown.length > 0 && (
              <CommandGroup heading={t('commandPalette.groupSessions')}>
                {sessionsShown.map((s) => (
                  <CommandItem
                    // cmdk recalculates group visibility when items register; a later transcript
                    // hit changes searchable text and must register again, not leave a hidden group.
                    key={`${s.id}:${s.snippet ?? ''}`}
                    value={`${s.label} ${s.projectName ?? ''} ${s.snippet ?? ''} ${s.id}`.trim()}
                    onSelect={() => run(() => { onShowTab?.('chat'); if (onSelectSession) onSelectSession(s); else navigate(`/session/${encodeURIComponent(s.id)}`); })}
                  >
                    <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className={`truncate ${organizationById.get(s.id)?.unread ? 'font-semibold' : ''}`}>{s.label}</span>
                      {s.projectName && <span className="truncate text-xs text-muted-foreground">{s.projectName}</span>}
                      {s.snippet && (
                        <span className="truncate text-xs text-muted-foreground">{s.snippet}</span>
                      )}
                    </div>
                    {organizationById.get(s.id)?.pinnedAt != null && <Pin className="h-3 w-3 shrink-0" aria-label={t('commandPalette.pinned')}/>}
                    {organizationById.get(s.id)?.unread && <Circle className="h-2 w-2 shrink-0 fill-current text-primary" aria-label={t('commandPalette.unread')}/>}
                    {busySessionIds.has(s.id) && <span className="text-xs text-muted-foreground">{t('commandPalette.running')}</span>}
                    {s.provider && (
                      <span className="text-xs text-muted-foreground">{s.provider}</span>
                    )}
                  </CommandItem>
                ))}
                {!page && sessionRows.length > browseLimit && (
                  <BrowseAllItem label={t('commandPalette.browseAllSessions', { count: sessionRows.length })} onSelect={() => pushPage('sessions')} />
                )}
              </CommandGroup>
            )}
            {showSessions && sessions.hasMore && page === 'sessions' && <div className="border-t px-3 py-2">
              <button type="button" className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50" disabled={sessions.loading} onClick={() => void sessions.loadMore()}>{t(sessions.loading ? 'commandPalette.loading' : 'commandPalette.loadMoreSessions')}</button>
            </div>}

            {showFiles && projectId && filesShown.length > 0 && (
              <CommandGroup heading={t('commandPalette.groupFiles')}>
                {filesShown.map((f) => (
                  <CommandItem
                    key={f.path}
                    value={f.path}
                    onSelect={() => run(() => ops.openFile(f.path))}
                  >
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1 truncate">{f.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{f.path}</span>
                  </CommandItem>
                ))}
                {!page && files.length > browseLimit && (
                  <BrowseAllItem label={t('commandPalette.browseAllFiles', { count: files.length })} onSelect={() => pushPage('files')} />
                )}
              </CommandGroup>
            )}

            {showCommits && projectId && commitsShown.length > 0 && (
              <CommandGroup heading={t('commandPalette.groupCommits')}>
                {commitsShown.map((c) => (
                  <CommandItem
                    key={c.hash}
                    value={`${c.message} ${c.author} ${c.shortHash}`}
                    onSelect={() => run(() => onShowTab?.('git'))}
                  >
                    <GitCommit className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="font-mono text-xs text-muted-foreground">{c.shortHash}</span>
                    <span className="flex-1 truncate">{c.message}</span>
                    <span className="truncate text-xs text-muted-foreground">{c.author}</span>
                  </CommandItem>
                ))}
                {!page && commits.length > browseLimit && (
                  <BrowseAllItem label={t('commandPalette.browseAllCommits', { count: commits.length })} onSelect={() => pushPage('commits')} />
                )}
              </CommandGroup>
            )}

            {showBranches && projectId && branchesShown.length > 0 && (
              <CommandGroup heading={t('commandPalette.groupBranches')}>
                {branchesShown.map((b) => (
                  <CommandItem
                    key={`branch-${b.name}`}
                    value={b.name}
                    onSelect={() => run(() => { void git.checkout(b.name); onShowTab?.('git'); })}
                  >
                    <GitMerge className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1 truncate">{t('commandPalette.switchTo', { name: b.name })}</span>
                  </CommandItem>
                ))}
                {!page && branches.length > browseLimit && (
                  <BrowseAllItem label={t('commandPalette.browseAllBranches', { count: branches.length })} onSelect={() => pushPage('branches')} />
                )}
              </CommandGroup>
            )}
          </CommandList>
          {showSessions && search.trim().length >= 2 && <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">{t('commandPalette.searchLimitHint')}</p>}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

export default React.memo(CommandPalette);

function BrowseAllItem({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <CommandItem value={label} onSelect={onSelect}>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex-1 text-muted-foreground">{label}</span>
    </CommandItem>
  );
}
