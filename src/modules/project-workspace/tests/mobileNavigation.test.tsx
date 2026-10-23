import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { useProjectsState } from '@/modules/project-workspace/hooks/useProjectsState';
import { useVisualViewportKeyboardOffset } from '@/modules/project-workspace/hooks/useVisualViewportKeyboardOffset';

const project={projectId:'p',path:'/repo',fullPath:'/repo',displayName:'Repo',sessions:[{id:'s',summary:'Chat',__provider:'claude'}],sessionMeta:{hasMore:false,total:1}};
vi.mock('@/shared/api',()=>({api:{
  projects:async()=>({ok:true,json:async()=>[project]}),
  projectTaskmaster:async()=>({ok:false}),
  sessionDetails:async()=>({ok:false}),
  projectSessions:async()=>({ok:false}),
}}));

test('Back to the list clears the old chat, and selecting in the same project closes the drawer',async()=>{
  const navigate=vi.fn();
  const subscribe=()=>()=>{};
  const isSessionProcessing=()=>false;
  const {result,rerender}=renderHook(({sessionId}:{sessionId:string|undefined})=>useProjectsState({sessionId,navigate,subscribe,isMobile:true,isSessionProcessing}),{initialProps:{sessionId:'s' as string|undefined}});
  await waitFor(()=>expect(result.current.selectedSession?.id).toBe('s'));
  act(()=>result.current.setSidebarOpen(true));
  act(()=>result.current.handleSessionSelect({id:'s',__provider:'claude',__projectId:'p'}));
  expect(result.current.sidebarOpen).toBe(false);
  expect(navigate.mock.calls).toEqual([['/session/s']]);
  rerender({sessionId:undefined});
  await waitFor(()=>expect(result.current.selectedSession).toBeNull());
  await act(async()=>{await result.current.refreshProjectsSilently();});
  expect(result.current.selectedSession).toBeNull();
});

test('keyboard sizing follows visible viewport panning and cleans up on unmount',()=>{
  const viewport=Object.assign(new EventTarget(),{height:350,offsetTop:80});
  vi.stubGlobal('visualViewport',viewport);
  vi.stubGlobal('innerHeight',844);
  try{
    const {unmount}=renderHook(()=>useVisualViewportKeyboardOffset());
    const style=document.documentElement.style;
    expect(style.getPropertyValue('--keyboard-height')).toBe('414px');
    viewport.offsetTop=120;
    act(()=>viewport.dispatchEvent(new Event('scroll')));
    expect(style.getPropertyValue('--keyboard-height')).toBe('374px');
    expect(style.getPropertyValue('--visual-viewport-top')).toBe('120px');
    unmount();
    expect(style.getPropertyValue('--keyboard-height')).toBe('');
  }finally{vi.unstubAllGlobals();}
});
