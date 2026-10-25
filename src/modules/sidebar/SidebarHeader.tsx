import { FolderPlus, SquarePen, RefreshCw, Search, X, PanelLeftClose, ListFilter } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Input } from '@/shared/ui';
import type { SidebarSearchMode } from '@/shared/types';
import { usePaletteOps } from '@/modules/command-palette';
import SidebarModeTabs from '@/modules/sidebar/SidebarModeTabs';
import { MonitorDashboard } from '@/modules/sidebar/MonitorDashboard';
import { DotDashboard } from '@/modules/dot';

type SidebarHeaderProps = {
  isPWA: boolean; isMobile: boolean; isLoading: boolean; projectsCount: number;
  runningSessionsCount: number; archivedSessionsCount: number; isArchivedSessionsLoading: boolean;
  searchFilter: string; onSearchFilterChange: (value: string) => void; onClearSearchFilter: () => void;
  searchMode: SidebarSearchMode; onSearchModeChange: (mode: SidebarSearchMode) => void;
  onRefresh: () => void; isRefreshing: boolean; onCreateProject: () => void;
  onNewClaudeSession?: () => void; onCollapseSidebar: () => void; t: TFunction;
};

/** SidebarContent uses one compact navigation header on desktop and mobile. */
export default function SidebarHeader({isPWA,isMobile,isLoading,projectsCount,runningSessionsCount,
  archivedSessionsCount,isArchivedSessionsLoading,searchFilter,onSearchFilterChange,onClearSearchFilter,
  searchMode,onSearchModeChange,onRefresh,isRefreshing,onCreateProject,onNewClaudeSession,onCollapseSidebar,t}:SidebarHeaderProps) {
  const {openSessionSwitcher}=usePaletteOps();
  const showFilters=!isLoading&&(projectsCount>0||runningSessionsCount>0||archivedSessionsCount>0||isArchivedSessionsLoading);
  const placeholder=searchMode==='conversations'?t('search.conversationsPlaceholder'):searchMode==='archived'
    ?t('search.archivedPlaceholder'):searchMode==='running'?t('search.runningPlaceholder'):t('projects.searchPlaceholder');
  return <div className="sidebar-navigation shrink-0 px-3 pb-2 pt-3" style={isPWA&&isMobile?{paddingTop:16}:undefined}>
    <div className="mb-3 flex h-8 items-center gap-1.5">
      <button type="button" className="workspace-icon-button" onClick={onCollapseSidebar} title={t('tooltips.hideSidebar')} aria-label={t('tooltips.hideSidebar')}><PanelLeftClose size={16}/></button>
      <img src="/nexcode-mark.svg" alt="" className="h-6 w-6 shrink-0 rounded-md" />
      <span className="flex-1 truncate text-[14px] font-semibold tracking-tight text-foreground/85">AgentHub</span>
    <div className="flex items-center gap-0.5">
      <button type="button" className="workspace-icon-button" onClick={onCreateProject} title={t('tooltips.createProject')} aria-label={t('tooltips.createProject')}><FolderPlus size={16}/></button>
      {showFilters&&<details className="sidebar-filter-menu relative">
        <summary className="workspace-icon-button cursor-pointer list-none" title={t('ui.filterChats')} aria-label={t('ui.filterChats')}><ListFilter size={16}/></summary>
        <div className="fixed left-3 top-14 z-50 w-64 rounded-xl border border-border bg-popover p-3 shadow-lg">
          <SidebarModeTabs searchMode={searchMode} onSearchModeChange={onSearchModeChange} runningSessionsCount={runningSessionsCount} t={t}/>
          <div className="relative mt-2"><Input aria-label={placeholder} placeholder={placeholder} value={searchFilter} onChange={event=>onSearchFilterChange(event.target.value)} className="h-8 pr-8 text-xs"/>
            {searchFilter&&<button type="button" onClick={onClearSearchFilter} className="absolute right-2 top-2" aria-label={t('tooltips.clearSearch')}><X size={14}/></button>}
          </div>
        </div>
      </details>}
      <button type="button" className="workspace-icon-button" onClick={onRefresh} disabled={isRefreshing} title={t('tooltips.refresh')} aria-label={t('tooltips.refresh')}><RefreshCw size={16} className={isRefreshing?'animate-spin':''}/></button>
    </div>
    </div>
    <nav aria-label={t('ui.navigation')} className="space-y-0.5">
      {onNewClaudeSession&&<button type="button" className="sidebar-nav-action" onClick={onNewClaudeSession}><SquarePen size={16}/><span>{t('ui.newChat')}</span></button>}
      <button type="button" className="sidebar-nav-action" onClick={openSessionSwitcher}><Search size={16}/><span>{t('ui.searchChats')}</span><kbd className="ml-auto font-sans text-[10px] tracking-wide text-muted-foreground/70">Ctrl ⇧ K</kbd></button>
      <MonitorDashboard/>
      <DotDashboard/>
    </nav>
    {(searchFilter||searchMode!=='projects')&&<div className="mt-1 flex items-center gap-2 rounded-md bg-muted px-2 py-1.5 text-xs"><span className="min-w-0 flex-1 truncate">{searchFilter||t(`ui.view.${searchMode}`)}</span><button type="button" aria-label={t('tooltips.clearSearch')} onClick={()=>{onClearSearchFilter();onSearchModeChange('projects');}}><X size={12}/></button></div>}
  </div>;
}
