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
  fireEvent.click(screen.getByRole('button',{name:/Expand pending|展开待发送/}));
  assert.ok(screen.getByRole('button',{name:/Resume queue|继续队列/}));
});

test('queue controls pause future dispatch and only reorder adjacent pending entries',async()=>{
  const update=vi.fn().mockResolvedValue(undefined),pause=vi.fn().mockResolvedValue(undefined);
  render(<MessageQueuePanel items={[{...item,id:'running',status:'running'},item,{...item,id:'two',content:'Second'}]}
    error="" update={update} paused={false} setPaused={pause}/>);
  fireEvent.click(screen.getByRole('button',{name:/Expand pending|展开待发送/}));
  fireEvent.click(screen.getAllByRole('button',{name:/Message actions|消息操作/})[0]);
  assert.equal((screen.getByRole('button',{name:/Move earlier|提前一位/}) as HTMLButtonElement).disabled,true);
  fireEvent.click(screen.getAllByRole('button',{name:/Message actions|消息操作/})[1]);
  fireEvent.click(screen.getByRole('button',{name:/Move earlier|提前一位/}));
  await waitFor(()=>assert.equal(update.mock.calls[0][1].action,'move-up'));
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
  fireEvent.click(view.getByRole('button',{name:/Message actions|消息操作/}));
  fireEvent.click(view.getByRole('button',{name:/Edit queued message|编辑排队消息/}));
  fireEvent.change(view.getByRole('textbox'),{target:{value:'My edit'}});
  fireEvent.click(view.getByRole('button',{name:/Save|保存/}));
  await waitFor(()=>assert.equal(update.mock.calls.length,1));
  assert.equal((update.mock.calls[0] as unknown[])[0],item);
  assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).value,'My edit');
  assert.ok(view.getAllByRole('alert').some(alert=>/conflict/.test(alert.textContent||'')));
});


test('delivered messages no longer occupy the pending queue',()=>{
  const view=render(<MessageQueuePanel items={[{...item,status:'running',delivery_mode:'live'}]} error="" update={vi.fn()}/>);
  assert.equal(view.container.textContent,'');
  view.rerender(<MessageQueuePanel items={[{...item,status:'running'}]} error="" update={vi.fn()}/>);
  assert.equal(view.container.textContent,'');
  view.rerender(<MessageQueuePanel items={[{...item,status:'failed'}]} error="" update={vi.fn()}/>);
  assert.ok(view.getAllByText('First').length);
});

test('tray starts collapsed, exposes one action per row, and keeps a dispatched edit',()=>{
  const view=render(<MessageQueuePanel items={[item]} error="" update={vi.fn()}/>);
  assert.equal(screen.queryByRole('button',{name:'Message actions'}),null);
  fireEvent.click(screen.getByRole('button',{name:'Expand pending messages'}));
  assert.equal(screen.getAllByRole('button',{name:'Message actions'}).length,1);
  fireEvent.click(screen.getByRole('button',{name:'Message actions'}));
  fireEvent.click(screen.getByRole('button',{name:'Edit queued message'}));
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'Unsent edit'}});
  view.rerender(<MessageQueuePanel items={[{...item,status:'running'}]} error="" update={vi.fn()}/>);
  assert.equal((screen.getByRole('textbox') as HTMLTextAreaElement).value,'Unsent edit');
  assert.match(screen.getByRole('alert').textContent||'',/Sending has started/);
  assert.equal((screen.getByRole('button',{name:'Save'}) as HTMLButtonElement).disabled,true);
});

test('failed live messages automatically expose separate insertion and queue recovery',async()=>{
  const retryLive=vi.fn().mockResolvedValue('live'),convertLive=vi.fn().mockResolvedValue(undefined),update=vi.fn();
  render(<MessageQueuePanel items={[{...item,status:'failed',delivery_mode:'live',error:'offline'}]} error="" update={update} retryLive={retryLive} convertLive={convertLive}/>);
  assert.ok(screen.getAllByText('Delivery unconfirmed').length);
  fireEvent.click(screen.getByRole('button',{name:'Retry insertion'}));
  await waitFor(()=>assert.equal(retryLive.mock.calls.length,1));
  await waitFor(()=>assert.equal((screen.getByRole('button',{name:'Send next turn'}) as HTMLButtonElement).disabled,false));
  fireEvent.click(screen.getByRole('button',{name:'Send next turn'}));
  await waitFor(()=>assert.equal(convertLive.mock.calls.length,1));
  assert.equal(update.mock.calls.length,0);
});

test('old queue responses and errors cannot leak into a different session',async()=>{
  let reject!: (reason:Error)=>void;
  vi.mocked(api.messageQueue.list).mockImplementationOnce(()=>new Promise((_,fail)=>{reject=fail;}));
  const hook=renderHook(({id})=>useMessageQueue(id),{initialProps:{id:'s1'}});
  hook.rerender({id:'s2'});
  await act(async()=>reject(new Error('old session offline')));
  assert.deepEqual(hook.result.current.items,[]);assert.equal(hook.result.current.error,'');
});

test('live conversion retains its ticket until uncertain cancellation is acknowledged',async()=>{
  vi.mocked(api.messageQueue.update).mockRejectedValueOnce(new Error('cancel offline')).mockResolvedValueOnce(response({...item,status:'cancelled'}));
  const hook=renderHook(()=>useMessageQueue('s1'));
  const failed={...item,status:'failed' as const,delivery_mode:'live' as const};
  await act(async()=>{await assert.rejects(hook.result.current.convertLive(failed),/cancel offline/);});
  await act(async()=>hook.result.current.convertLive(failed));
  assert.equal(vi.mocked(api.messageQueue.enqueue).mock.calls[0][0].requestId,vi.mocked(api.messageQueue.enqueue).mock.calls[1][0].requestId);
  assert.ok(vi.mocked(api.messageQueue.update).mock.calls.every(call=>call[1].action==='cancel'));
});

test('legacy local drafts use the same collapsed pending tray',()=>{
  const edit=vi.fn(),remove=vi.fn();
  render(<MessageQueuePanel items={[]} error="" update={vi.fn()} queuedDraft={{content:'Local draft',attachments:[],options:{}} as never} onEditQueuedDraft={edit} onDeleteQueuedDraft={remove}/>);
  assert.ok(screen.getByText('Pending 1'));
  fireEvent.click(screen.getByRole('button',{name:'Expand pending messages'}));
  fireEvent.click(screen.getByRole('button',{name:'Message actions'}));
  fireEvent.click(screen.getByRole('button',{name:'Edit queued message'}));
  assert.equal(edit.mock.calls.length,1);
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));assert.equal(remove.mock.calls.length,1);
});
