import { useRef } from 'react';
import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { Loader2 } from 'lucide-react';
import { SectionRow } from '@/modules/sidebar/SectionRow';
import { SessionOrganizationBadge } from '@/modules/sidebar/SessionOrganizationBadge';
import { LLMProviderLogo, Tooltip } from '@/shared/ui';
import { cn } from '@/shared/utils';

/** Sidebar project, section, pinned, inbox and recent lists share geometry and status ordering. */
export function SessionRow({sessionId,title,provider,selected,processing,background,attention,recent,t,onSelect,options,subtitle,
  selecting,checked,disabled,selectionIcon}: {
  sessionId:string;title:string;provider:string;selected?:boolean;processing?:boolean;background?:boolean;
  attention?:boolean;recent?:boolean;t:TFunction;onSelect:()=>void;options?:ReactNode;subtitle?:ReactNode;
  selecting?:boolean;checked?:boolean;disabled?:boolean;selectionIcon?:ReactNode;
}) {
  const root=useRef<HTMLDivElement>(null);
  const needsAttention=attention&&!selected;
  const dot=needsAttention||background||(!processing&&recent);
  const label=needsAttention?t('tooltips.attentionRequiredIndicator',{defaultValue:'Session needs attention'}):background?t('tooltips.backgroundWorkIndicator',{defaultValue:'Background work running'}):t('tooltips.activeSessionIndicator');
  const openMenu=()=>root.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click();
  return <SectionRow target={{kind:'session',targetId:sessionId,title}} showButton={!options&&!selecting} onOpenMenu={options?openMenu:undefined}>
    <div ref={root} data-session-row={sessionId} className={cn('group/session relative flex min-h-9 w-full min-w-0 items-center rounded-md pl-6 pr-2 hover:bg-accent/50',selected&&'bg-foreground/[0.06]',checked&&'bg-primary/10')}>
      <a href={`/session/${encodeURIComponent(sessionId)}`} role={selecting?'checkbox':undefined} aria-checked={selecting?checked:undefined} aria-disabled={disabled||undefined}
        className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left text-sm font-normal text-foreground outline-offset-2"
        onClick={event=>{if(!selecting&&(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey))return;event.preventDefault();if(!disabled)onSelect();}}
        onKeyDown={event=>{if(selecting&&(event.key===' '||event.key==='Enter')){event.preventDefault();if(!disabled)onSelect();}}}>
        {selectionIcon}
        <span data-provider-slot className="flex h-4 w-4 shrink-0 items-center justify-center">
          {provider!=='claude'&&<LLMProviderLogo provider={provider} className="h-3 w-3"/>}
        </span>
        <span className="min-w-0 flex-1"><span data-session-title className="block truncate leading-5" title={title}>{title}</span>
          {subtitle&&<span className="block truncate text-[10px] leading-4 text-muted-foreground">{subtitle}</span>}
        </span>
      </a>
      <span data-session-status className="ml-1 flex shrink-0 items-center gap-1">
        {processing&&<Tooltip content={t('tooltips.processingSessionIndicator','Processing session')}><Loader2 className="h-3 w-3 animate-spin text-muted-foreground"/></Tooltip>}
        {dot&&<Tooltip content={label}><span role="status" aria-label={label} className={cn('h-1.5 w-1.5 shrink-0 rounded-full',needsAttention?'bg-amber-500':background?'bg-purple-500 dark:bg-purple-400':'bg-green-500')}/></Tooltip>}
        <SessionOrganizationBadge sessionId={sessionId}/>
      </span>
      {options&&<span data-session-options className="ml-1 flex shrink-0 items-center">{options}</span>}
    </div>
  </SectionRow>;
}
