import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { api } from '@/shared/api';
import { CrossSessionDialog } from '@/modules/chat/modals/CrossSessionDialog';

vi.mock('@/shared/api',()=>({api:{sessionBridge:{list:vi.fn(),read:vi.fn(),send:vi.fn(),status:vi.fn()}},readApiErrorMessage:()=> 'Request failed'}));
const response=(data:unknown)=>new Response(JSON.stringify({data}));
beforeEach(()=>{
  vi.clearAllMocks();
  vi.mocked(api.sessionBridge.list).mockResolvedValue(response({sessions:[{sessionId:'source',title:'Source',provider:'claude'},{sessionId:'target',title:'Target chat',provider:'claude',projectId:'p',projectPath:'/other',canSend:true}],offset:0,hasMore:false,total:2}));
  vi.mocked(api.sessionBridge.read).mockResolvedValue(response({sessionId:'target',title:'Target chat',messages:[{role:'assistant',content:'Known result',timestamp:'2026-10-22'}],hasMore:false,offset:0,total:1}));
});
async function choose(insert=vi.fn()){
  render(<CrossSessionDialog sourceSessionId="source" draft="Existing draft" onInsert={insert}/>);
  fireEvent.click(screen.getByRole('button',{name:/Cross-session tools|跨会话调用/}));
  fireEvent.click(await screen.findByRole('button',{name:/Target chat/}));await screen.findByText('Known result');
}
test('reading and quoting context only appends to the source draft; it does not send',async()=>{
  const insert=vi.fn();await choose(insert);
  fireEvent.click(screen.getByRole('button',{name:/Insert context|将上下文放入/}));assert.match(insert.mock.calls[0][0],/session_id=target/);assert.match(insert.mock.calls[0][0],/Known result/);
  assert.equal(vi.mocked(api.sessionBridge.send).mock.calls.length,0);
});
test('an uncertain send retry preserves request identity and reports queued rather than completed',async()=>{
  vi.mocked(api.sessionBridge.send).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(response({id:'receipt',sessionId:'target',sourceSessionId:'source',status:'queued',error:null}));
  await choose();const send=screen.getByRole('button',{name:/Queue in selected|加入目标会话队列/});
  fireEvent.click(send);await screen.findByRole('alert');await waitFor(()=>assert.equal(send.hasAttribute('disabled'),false));
  fireEvent.click(send);await waitFor(()=>assert.match(screen.getByRole('status').textContent!,/Queued|已排队/));
  const calls=vi.mocked(api.sessionBridge.send).mock.calls;assert.equal(calls.length,2);assert.equal(calls[0][0].requestId,calls[1][0].requestId);assert.equal(calls[0][0].sourceSessionId,'source');assert.equal(calls[0][0].content,'Existing draft');
});
