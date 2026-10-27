import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { FolderInput, MoreHorizontal } from 'lucide-react';

import { ActionMenu } from '@/shared/ui';
import type { WorkspaceSectionTarget } from '@/shared/types';
import { useWorkspaceSections } from '@/modules/sidebar/context/WorkspaceSectionsContext';

/** All sidebar row variants share context/touch menus and a typed section drag payload. */
export function SectionRow({ target, children, showButton = true }: { target: WorkspaceSectionTarget; children: ReactNode; showButton?: boolean }) {
  const sections = useWorkspaceSections();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const origin = useRef({ x: 0, y: 0 }), held = useRef(false);
  const cancel = () => { clearTimeout(timer.current); };
  useEffect(() => cancel, []);
  if (!sections?.layout) return <>{children}</>;
  return <div data-section-kind={target.kind} data-section-target={target.targetId} className="relative flex min-w-0 items-center" draggable={!sections.busy}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); sections.openMove(target, { x: event.clientX, y: event.clientY }); }}
    onPointerDown={event => {
      const element = event.target as HTMLElement;
      const button = element.closest('button');
      // A project's primary expand button is the row itself; its tool buttons keep their own gestures.
      if (event.pointerType !== 'touch' || element.closest('input,select,textarea,[aria-haspopup]') || (button && !button.hasAttribute('aria-expanded'))) return;
      held.current = false; origin.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => { held.current = true; sections.openMove(target); }, 550);
    }} onPointerMove={event => { if (Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 10) cancel(); }}
    onPointerUp={cancel} onPointerCancel={cancel} onClickCapture={event => { if (held.current) { event.preventDefault(); event.stopPropagation(); held.current = false; } }}
    onDragStart={event => { event.stopPropagation(); cancel(); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-nexagent-section-item', JSON.stringify(target)); }}>
    <div className="min-w-0 flex-1">{children}</div>
    {showButton && <ActionMenu menuClassName="z-[100]" label="移到分区" ariaLabel={`${target.kind === 'project' ? '项目' : '会话'}分区选项：${target.title}`} icon={MoreHorizontal} iconOnly variant="ghost" size="icon" triggerClassName="h-8 w-7 shrink-0 text-muted-foreground" items={[{ key: 'section', label: '移到分区 ▸', icon: FolderInput, onSelect: () => sections.openMove(target) }]}/>}
  </div>;
}
