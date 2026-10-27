import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { MoreHorizontal } from 'lucide-react';
import { SessionRow } from '@/modules/sidebar/SessionRow';
import { ActionMenu } from '@/shared/ui';

vi.mock('@/modules/sidebar/SessionOrganizationBadge',()=>({SessionOrganizationBadge:()=> <span data-testid="badges">monitor / unread</span>}));
const t=((key:string)=>key) as TFunction;
function setup(){
  const select=vi.fn(),action=vi.fn();
  const view=render(<SessionRow sessionId="thread" title="长标题与 provider 图标不重叠" provider="codex" attention processing t={t} onSelect={select}
    options={<ActionMenu label="Session options" icon={MoreHorizontal} iconOnly items={[{key:'rename',label:'Rename session',onSelect:action}]}/>}/>);
  return {...view,select,action};
}
test('title is separate from fixed provider and right status slots, with one menu',()=>{
  const {container}=setup(),title=container.querySelector('[data-session-title]')!;
  expect(title.textContent).toBe('长标题与 provider 图标不重叠');
  expect(title.querySelector('[data-testid="badges"]')).toBeNull();
  expect(container.querySelector('[data-session-status] [data-testid="badges"]')).not.toBeNull();
  expect(container.querySelector('[data-provider-slot]')).not.toBeNull();
  expect(container.querySelector('[data-session-row]')?.className).toContain('pl-6');
  expect(container.querySelector('[role="status"]')?.className).toContain('bg-amber-500');
  expect(container.querySelector('[role="status"]')?.parentElement?.className).not.toContain('-translate-x');
  expect(container.querySelectorAll('[aria-haspopup="menu"]')).toHaveLength(1);
});
test('right click and overflow open the same actions without selecting a conversation',async()=>{
  const {select,action}=setup();
  fireEvent.contextMenu(screen.getByRole('link'));
  fireEvent.click(await screen.findByRole('menuitem',{name:'Rename session'}));
  expect(action).toHaveBeenCalledTimes(1);expect(select).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Session options'}));
  expect(await screen.findByRole('menuitem',{name:'Rename session'})).toBeTruthy();
});
test('touch hold uses the overflow menu and suppresses the following navigation click',async()=>{
  const {container,select,action}=setup(),link=screen.getByRole('link');
  const pointer=new Event('pointerdown',{bubbles:true});Object.assign(pointer,{pointerType:'touch',clientX:0,clientY:0});fireEvent(link,pointer);
  await waitFor(()=>expect(screen.getByRole('menuitem',{name:'Rename session'})).toBeTruthy(),{timeout:1500});
  fireEvent.click(screen.getByRole('menuitem',{name:'Rename session'}));expect(action).toHaveBeenCalledTimes(1);
  fireEvent.click(link);expect(select).not.toHaveBeenCalled();
  expect(container.querySelectorAll('[aria-haspopup="menu"]')).toHaveLength(1);
});
