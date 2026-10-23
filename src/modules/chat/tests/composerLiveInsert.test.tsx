import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { api } from '@/shared/api';
import type * as ApiModule from '@/shared/api';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useMessageQueue } from '@/modules/chat/composer/useMessageQueue';
import type { ChatMessage, LLMProvider, PermissionMode, Project, ProjectSession, QueuedConversationMessage } from '@/shared/types';

/**
 * While a turn runs, Enter inserts the text into that turn (Claude streaming
 * input / Codex `turn/steer`), like the CLIs. Alt+Enter, attachments, slash
 * commands and providers without live input keep the next-turn queue.
 */

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { ...actual.api, messageQueue: { list: vi.fn(), enqueue: vi.fn(), update: vi.fn(), liveState: vi.fn(), sendLive: vi.fn() } } };
});

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };

function renderComposer(provider: LLMProvider, isLoading = true) {
  const added: ChatMessage[] = [];
  const sent: unknown[] = [];
  const sendLiveMessage = vi.fn(async () => 'live' as const);
  const enqueueMessage = vi.fn(async ():Promise<void> => undefined);
  const view = renderHook(() => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: SESSION,
    currentSessionId: SESSION.id,
    provider,
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading,
    enqueueMessage,
    sendLiveMessage,
    processingSessions: new Map(),
    canAbortSession: true,
    tokenBudget: null,
    sendMessage: (message) => { sent.push(message); },
    scrollToBottom: () => undefined,
    addMessage: (message) => { added.push(message); },
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }));
  return { view, added, sent, sendLiveMessage, enqueueMessage };
}

const type = (view: ReturnType<typeof renderComposer>['view'], text: string) => act(() => {
  view.result.current.handleInputChange({ target: { value: text, selectionStart: text.length } } as never);
});
const pressEnter = (view: ReturnType<typeof renderComposer>['view'], extra: Record<string, boolean> = {}) => act(async () => {
  view.result.current.handleKeyDown({
    key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra,
    nativeEvent: { isComposing: false }, preventDefault: () => undefined,
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })));
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

for (const provider of ['claude', 'codex', 'workbuddy'] as const) {
  test(`Enter during a running ${provider} turn inserts into it and echoes an inserted row`, async () => {
    const { view, added, sent, sendLiveMessage, enqueueMessage } = renderComposer(provider);
    await type(view, '停止计数，直接回答：插入成功');
    await pressEnter(view);
    assert.equal(sendLiveMessage.mock.calls.length, 1);
    assert.equal((sendLiveMessage.mock.calls[0] as unknown[])[0] && ((sendLiveMessage.mock.calls[0] as unknown[])[0] as { content: string }).content, '停止计数，直接回答：插入成功');
    assert.equal(enqueueMessage.mock.calls.length, 0);
    assert.equal(sent.length, 0, 'no new turn is started');
    const echo = added.find((message) => message.type === 'user');
    assert.equal(echo?.insertedMidTurn, true);
    assert.equal(echo?.content, '停止计数，直接回答：插入成功');
    assert.equal(view.result.current.input, '');
  });
}

test('Alt+Enter during a running turn queues for after the turn instead of inserting', async () => {
  const { view, added, sendLiveMessage, enqueueMessage } = renderComposer('claude');
  await type(view, 'do this next');
  await pressEnter(view, { altKey: true });
  assert.equal(sendLiveMessage.mock.calls.length, 0);
  assert.equal(enqueueMessage.mock.calls.length, 1);
  assert.ok(!added.some((message) => message.insertedMidTurn));
});

test('the chosen queue mode controls Enter and can be switched back to native insertion', async () => {
  const { view, sendLiveMessage, enqueueMessage } = renderComposer('workbuddy');
  act(() => view.result.current.setBusySendMode('queue'));
  await type(view, 'wait until this turn ends'); await pressEnter(view);
  assert.equal(enqueueMessage.mock.calls.length, 1);
  assert.equal(sendLiveMessage.mock.calls.length, 0);
  act(() => view.result.current.setBusySendMode('insert'));
  await type(view, 'change the current task'); await pressEnter(view);
  assert.equal(sendLiveMessage.mock.calls.length, 1);
});

test('Alt+Enter in queue mode inserts, while unavailable alternatives do not submit',async()=>{
  const live=renderComposer('claude');
  act(()=>live.view.result.current.setBusySendMode('queue'));
  await type(live.view,'alternate insertion');await pressEnter(live.view,{altKey:true});
  assert.equal(live.sendLiveMessage.mock.calls.length,1);
  assert.equal(live.enqueueMessage.mock.calls.length,0);
  await type(live.view,'/compact');await pressEnter(live.view,{altKey:true});
  assert.equal(live.enqueueMessage.mock.calls.length,0);
  const cursor=renderComposer('cursor');
  await type(cursor.view,'keep draft');await pressEnter(cursor.view,{altKey:true});
  assert.equal(cursor.enqueueMessage.mock.calls.length,0);
  assert.equal(cursor.view.result.current.input,'keep draft');
});

test('attachments visibly choose the queue and the draft waits for acknowledgment',async()=>{
  const pending=renderComposer('claude');
  let accept!:()=>void;
  pending.enqueueMessage.mockImplementationOnce(()=>new Promise<void>(resolve=>{accept=resolve;}));
  act(()=>pending.view.result.current.setAttachedFiles([new File(['data'],'note.txt',{type:'text/plain'})]));
  // Upload response follows the existing durable attachment API.
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({attachments:[{name:'note.txt',path:'/uploaded/note.txt'}]}))));
  await type(pending.view,'with file');
  await pressEnter(pending.view);
  assert.equal(pending.sendLiveMessage.mock.calls.length,0);
  assert.equal(pending.enqueueMessage.mock.calls.length,1);
  assert.equal(pending.view.result.current.input,'with file');
  await act(async()=>accept());
  assert.equal(pending.view.result.current.input,'');
});

test('slash commands and providers without live input keep the next-turn queue', async () => {
  const slash = renderComposer('claude');
  await type(slash.view, '/compact');
  await pressEnter(slash.view);
  assert.equal(slash.sendLiveMessage.mock.calls.length, 0);
  assert.equal(slash.enqueueMessage.mock.calls.length, 1);

  const cursor = renderComposer('cursor');
  await type(cursor.view, 'hello');
  await pressEnter(cursor.view);
  assert.equal(cursor.sendLiveMessage.mock.calls.length, 0);
  assert.equal(cursor.enqueueMessage.mock.calls.length, 1);
});

test('an insertion whose turn already ended falls back to the queue without an inserted echo', async () => {
  const conflict = new Response(JSON.stringify({ success: false, error: { code: 'LIVE_INPUT_UNAVAILABLE', message: 'No active turn' } }), { status: 409 });
  vi.mocked(api.messageQueue.list).mockImplementation(async () => new Response(JSON.stringify({ data: [] })));
  vi.mocked(api.messageQueue.liveState).mockResolvedValue(conflict);
  const queued: QueuedConversationMessage = { id: 'q', session_id: 's1', content: 'late', revision: 1, attempt_count: 0, status: 'queued', error: null, created_at: '', started_at: null, finished_at: null };
  vi.mocked(api.messageQueue.enqueue).mockResolvedValue(new Response(JSON.stringify({ data: queued })));
  const hook = renderHook(() => useMessageQueue('s1'));
  let outcome: string | undefined;
  await act(async () => { outcome = await hook.result.current.sendLive({ content: 'late', options: {}, attachments: [] }, 's1'); });
  assert.equal(outcome, 'queued');
  assert.equal(vi.mocked(api.messageQueue.sendLive).mock.calls.length, 0);
  assert.equal(vi.mocked(api.messageQueue.enqueue).mock.calls.length, 1);
  assert.equal(hook.result.current.error, '');
  assert.match(hook.result.current.notice,/task ended|任务已结束/);
});
