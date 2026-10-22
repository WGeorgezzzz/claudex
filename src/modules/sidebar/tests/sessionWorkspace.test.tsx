import assert from 'node:assert/strict';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';
import '@/modules/i18n';
import { api } from '@/shared/api';
import { SessionWorkspaceProvider, useSessionWorkspace } from '@/modules/sidebar/context/SessionWorkspaceContext';
import { SessionWorkspacePanel } from '@/modules/sidebar/SessionWorkspacePanel';
import type { SessionWorkspaceEntry } from '@/shared/types';

vi.mock('@/shared/api',()=>({api:{sessionWorkspace:{list:vi.fn(),update:vi.fn()}},readApiErrorMessage:()=>''}));
const initial:SessionWorkspaceEntry={sessionId:'s1',title:'Pinned task',provider:'claude',projectId:'p1',projectPath:'/work',pinnedAt:1,unread:false,queuePaused:false,lastActivityAt:'2026-10-22T00:00:00.000Z',queuedCount:0,runningCount:0,blockedCount:0,approvalCount:0};
const response=(data:unknown)=>new Response(JSON.stringify({data}));
let row=initial;
beforeEach(()=>{
  row={...initial};vi.clearAllMocks();vi.spyOn(document,'hasFocus').mockReturnValue(true);
  vi.mocked(api.sessionWorkspace.list).mockImplementation(async()=>response([row]));
  vi.mocked(api.sessionWorkspace.update).mockImplementation(async(_id,input)=>{row={...row,...(input.unread!==undefined?{unread:input.unread}:{})};return response(row);});
});
afterEach(()=>vi.restoreAllMocks());
function Controls(){const state=useSessionWorkspace()!;return <><button onClick={()=>void state.change('s1',{unread:true})}>manual unread</button><span data-testid="unread-value">{String(state.byId.get('s1')?.unread)}</span></>;}

test('manual unread remains marked in the current conversation, then opening it again marks it read',async()=>{
  const view=render(<SessionWorkspaceProvider activeSessionId="s1"><Controls/></SessionWorkspaceProvider>);
  await waitFor(()=>assert.equal(screen.getByTestId('unread-value').textContent,'false'));
  fireEvent.click(screen.getByText('manual unread'));
  await waitFor(()=>assert.equal(screen.getByTestId('unread-value').textContent,'true'));
  assert.equal(vi.mocked(api.sessionWorkspace.update).mock.calls.length,1);
  view.rerender(<SessionWorkspaceProvider activeSessionId={null}><Controls/></SessionWorkspaceProvider>);
  view.rerender(<SessionWorkspaceProvider activeSessionId="s1"><Controls/></SessionWorkspaceProvider>);
  await waitFor(()=>assert.equal(screen.getByTestId('unread-value').textContent,'false'));
  assert.equal(vi.mocked(api.sessionWorkspace.update).mock.calls.at(-1)?.[1].readThrough,initial.lastActivityAt);
});

test('the pinned and attention views navigate by stable session and project IDs',async()=>{
  row={...initial,blockedCount:2};const select=vi.fn();
  render(<SessionWorkspaceProvider activeSessionId={null}><SessionWorkspacePanel onSelect={select}/></SessionWorkspaceProvider>);
  await waitFor(()=>assert.ok(screen.getByRole('link',{name:/Pinned task/})));
  fireEvent.click(screen.getByRole('button',{name:/Attention|待处理/}));
  fireEvent.click(screen.getByRole('link',{name:/Pinned task/}));
  assert.deepEqual(select.mock.calls[0],['p1','s1','claude']);
});

test('an unfocused page does not acknowledge an unattended completion',async()=>{
  vi.mocked(document.hasFocus).mockReturnValue(false);row={...initial,unread:true};
  render(<SessionWorkspaceProvider activeSessionId="s1"><Controls/></SessionWorkspaceProvider>);
  await waitFor(()=>assert.equal(screen.getByTestId('unread-value').textContent,'true'));
  assert.equal(vi.mocked(api.sessionWorkspace.update).mock.calls.length,0);
  vi.mocked(document.hasFocus).mockReturnValue(true);await act(async()=>window.dispatchEvent(new Event('focus')));
  await waitFor(()=>assert.equal(screen.getByTestId('unread-value').textContent,'false'));
});
