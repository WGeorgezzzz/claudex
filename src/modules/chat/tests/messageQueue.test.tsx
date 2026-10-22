import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { api } from '@/shared/api';
import { useMessageQueue } from '@/modules/chat/composer/useMessageQueue';
import { MessageQueuePanel } from '@/modules/chat/composer/MessageQueuePanel';
import type { QueuedConversationMessage } from '@/shared/types';

vi.mock('@/shared/api',()=>({api:{messageQueue:{list:vi.fn(),enqueue:vi.fn(),update:vi.fn(),liveState:vi.fn(),sendLive:vi.fn()}},
  readApiErrorMessage:(body:{error?:{message?:string}})=>body.error?.message}));
const response=(data:unknown)=>new Response(JSON.stringify({data}));
const item:QueuedConversationMessage={id:'one',session_id:'s1',content:'First',revision:2,attempt_count:0,status:'queued',
  error:null,created_at:'2026-01-01T00:00:00Z',started_at:null,finished_at:null};

test('live additions retain the same delivery ticket across unknown network outcomes and refresh',async()=>{
  vi.mocked(api.messageQueue.liveState).mockResolvedValue(response({startedAt:123}));
  vi.mocked(api.messageQueue.sendLive).mockRejectedValueOnce(new Error('connection lost'))
    .mockResolvedValueOnce(response({...item,status:'running',delivery_mode:'live'}));
  const first=renderHook(()=>useMessageQueue('s1'));
  const submission={content:'extra requirement',options:{},attachments:[]};
  await act(async()=>{await assert.rejects(first.result.current.sendLive(submission,'s1'),/connection lost/);});
  const original=vi.mocked(api.messageQueue.sendLive).mock.calls[0][0];
  first.unmount();
  const reopened=renderHook(()=>useMessageQueue('s1'));
  await act(async()=>reopened.result.current.sendLive(submission,'s1'));
  assert.deepEqual(vi.mocked(api.messageQueue.sendLive).mock.calls[1][0],original);
  assert.equal(vi.mocked(api.messageQueue.liveState).mock.calls.length,1);
});
beforeEach(()=>{
  localStorage.clear();vi.clearAllMocks();vi.stubGlobal('crypto',webcrypto);
  vi.mocked(api.messageQueue.list).mockReset().mockImplementation(async()=>response([]));
  vi.mocked(api.messageQueue.enqueue).mockReset().mockImplementation(async()=>response(item));
});
afterEach(()=>{vi.unstubAllGlobals();localStorage.clear();});

test('empty idle queues take no composer space while paused queues remain actionable',()=>{
  const view=render(<MessageQueuePanel items={[]} error="" update={vi.fn()} paused={false}/>);
  assert.equal(view.container.textContent,'');
  view.rerender(<MessageQueuePanel items={[]} error="" update={vi.fn()} paused setPaused={vi.fn()}/>);
  assert.ok(screen.getByRole('button',{name:/Resume queue|继续队列/}));
});

test('queue controls pause future dispatch and only reorder adjacent pending entries',async()=>{
  const update=vi.fn().mockResolvedValue(undefined),pause=vi.fn().mockResolvedValue(undefined);
  render(<MessageQueuePanel items={[{...item,id:'running',status:'running'},item,{...item,id:'two',content:'Second'}]}
    error="" update={update} paused={false} setPaused={pause}/>);
  const earlier=screen.getAllByRole('button',{name:/Move earlier|提前一位/});
  assert.equal((earlier[0] as HTMLButtonElement).disabled,true);
  assert.equal((earlier[1] as HTMLButtonElement).disabled,false);
  fireEvent.click(earlier[1]);await waitFor(()=>assert.equal(update.mock.calls[0][1].action,'move-up'));
  await waitFor(()=>assert.equal((screen.getByRole('button',{name:/Pause queue|暂停队列/}) as HTMLButtonElement).disabled,false));
  fireEvent.click(screen.getByRole('button',{name:/Pause queue|暂停队列/}));
  await waitFor(()=>assert.deepEqual(pause.mock.calls,[[true]]));
});

test('unknown enqueue outcomes retain their request ID across a reload',async()=>{
  vi.mocked(api.messageQueue.enqueue).mockRejectedValueOnce(new Error('connection lost'));
  const first=renderHook(()=>useMessageQueue('s1'));
  const submission={content:'First',options:{permissionMode:'default'},attachments:[]};
  await act(async()=>{await assert.rejects(first.result.current.enqueue(submission,'s1'),/connection lost/);});
  const requestId=vi.mocked(api.messageQueue.enqueue).mock.calls[0][0].requestId;
  first.unmount();
  const second=renderHook(()=>useMessageQueue('s1'));
  await act(async()=>{await second.result.current.enqueue(submission,'s1');});
  assert.equal(vi.mocked(api.messageQueue.enqueue).mock.calls[1][0].requestId,requestId);
  await act(async()=>{await second.result.current.enqueue(submission,'s1');});
  assert.notEqual(vi.mocked(api.messageQueue.enqueue).mock.calls[2][0].requestId,requestId,'a separately acknowledged submission is a new intent');
});

test('a failed refresh after acceptance does not report the POST as failed',async()=>{
  const view=renderHook(()=>useMessageQueue('s1'));
  await waitFor(()=>assert.equal(vi.mocked(api.messageQueue.list).mock.calls.length,1));
  vi.mocked(api.messageQueue.list).mockRejectedValue(new Error('refresh offline'));
  await act(async()=>{await view.result.current.enqueue({content:'First',options:{},attachments:[]},'s1');});
  assert.equal(vi.mocked(api.messageQueue.enqueue).mock.calls.length,1);
});

test('queue edits retain the original revision and do not hide a conflicted edit',async()=>{
  const update=vi.fn(async()=>{throw new Error('conflict');});
  const view=render(<MessageQueuePanel items={[item]} error="conflict" update={update}/>);
  fireEvent.click(view.getByRole('button',{name:/Edit queued message|编辑排队消息/}));
  fireEvent.change(view.getByRole('textbox'),{target:{value:'My edit'}});
  fireEvent.click(view.getByRole('button',{name:/Save|保存/}));
  await waitFor(()=>assert.equal(update.mock.calls.length,1));
  assert.equal((update.mock.calls[0] as unknown[])[0],item);
  assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).value,'My edit');
  assert.match(view.getByRole('alert').textContent||'',/conflict/);
});
