import { Settings, MoreHorizontal, ArrowUpCircle, AlertTriangle, SlidersHorizontal } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { ReleaseInfo } from '@/shared/types';
import { toggleQuickSettingsPanel } from '@/modules/quick-settings-panel';
import { AccountSecurity } from '@/modules/auth';
import { QuotaIndicator } from '@/modules/usage';

type SidebarFooterProps={updateAvailable:boolean;restartRequired:boolean;releaseInfo:ReleaseInfo|null;latestVersion:string|null;currentVersion:string;onShowVersionModal:()=>void;onShowSettings:(tab?:string)=>void;t:TFunction};

/** SidebarContent keeps settings visible while secondary project links live in its overflow. */
export default function SidebarFooter({updateAvailable,restartRequired,releaseInfo,latestVersion,currentVersion,onShowVersionModal,onShowSettings,t}:SidebarFooterProps){
  return <footer className="shrink-0 px-3 pb-3 pt-2" style={{paddingBottom:'max(12px, env(safe-area-inset-bottom, 0px))'}}>
    <QuotaIndicator onOpen={() => onShowSettings('usage')}/>
    {restartRequired&&<p className="mb-2 flex items-center gap-2 px-2 text-xs text-amber-700 dark:text-amber-300"><AlertTriangle size={14}/>{t('version.restartRequired')}</p>}
    {updateAvailable&&<button type="button" className="sidebar-nav-action" onClick={onShowVersionModal}><ArrowUpCircle size={15}/><span>{releaseInfo?.title||`v${latestVersion}`}</span></button>}
    <div className="flex items-center gap-1">
      <button type="button" className="sidebar-nav-action flex-1" onClick={() => onShowSettings()}><Settings size={16}/><span>{t('actions.settings')}</span></button>
      <button type="button" className="workspace-icon-button" onClick={toggleQuickSettingsPanel} aria-label={t('ui.quickSettings')} title={t('ui.quickSettings')}><SlidersHorizontal size={15}/></button>
      <AccountSecurity/>
      <details className="relative">
        <summary className="workspace-icon-button cursor-pointer list-none" aria-label={t('ui.about')} title={t('ui.about')}><MoreHorizontal size={16}/></summary>
        <div className="absolute bottom-full right-0 z-50 mb-2 w-56 rounded-xl border border-border bg-popover p-2 text-xs shadow-lg">
          <a className="sidebar-nav-action" href="https://github.com/WGeorgezzzz/claudex" target="_blank" rel="noopener noreferrer">AgentHub v{currentVersion}</a>
          <a className="sidebar-nav-action" href="https://github.com/WGeorgezzzz/claudex/issues/new" target="_blank" rel="noopener noreferrer">{t('actions.reportIssue')}</a>
        </div>
      </details>
    </div>
  </footer>;
}
