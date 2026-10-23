import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import ProjectSidebarRegion from '@/modules/project-workspace/ProjectSidebarRegion';

const close=vi.hoisted(()=>vi.fn());
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(s:string)=>s})}));
vi.mock('@/modules/sidebar',()=>({Sidebar:()=>null}));
vi.mock('@/modules/project-workspace/context/ProjectsStateContext',()=>({useProjectSidebarState:()=>({sidebarOpen:true,setSidebarOpen:close,sidebarSharedProps:{}})}));
vi.mock('@/shared/context/UiPreferencesContext',()=>({useUiPreferences:()=>({sidebarVisible:true})}));
vi.mock('@/shared/hooks/useSidebarWidth',()=>({SIDEBAR_WIDTH_KEYBOARD_STEP:20,SIDEBAR_WIDTH_MAX:500,SIDEBAR_WIDTH_MIN:200,useSidebarWidth:()=>({width:320,setWidth:()=>{},resetWidth:()=>{}})}));

test('a trailing back-swipe click cannot dismiss the newly opened drawer; a fresh tap can',()=>{
  render(<ProjectSidebarRegion isMobile/>);
  const backdrop=screen.getByRole('button',{name:'versionUpdate.ariaLabels.closeSidebar'});
  fireEvent.click(backdrop,{detail:1,clientX:370,clientY:200});
  expect(close).not.toHaveBeenCalled();
  fireEvent(backdrop,new MouseEvent('pointerdown',{bubbles:true,clientX:370,clientY:200}));
  fireEvent.click(backdrop,{detail:1,clientX:320,clientY:200});
  expect(close).not.toHaveBeenCalled();
  fireEvent(backdrop,new MouseEvent('pointerdown',{bubbles:true,clientX:370,clientY:200}));
  fireEvent.click(backdrop,{detail:1,clientX:370,clientY:200});
  expect(close).toHaveBeenCalledWith(false);
});
