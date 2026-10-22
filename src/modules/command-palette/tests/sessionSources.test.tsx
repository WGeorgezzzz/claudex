import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useSessionsSource } from '@/modules/command-palette/hooks/useSessionsSource';
import { useSessionMessageSearch } from '@/modules/command-palette/hooks/useSessionMessageSearch';

const apiMocks = vi.hoisted(() => ({recentConversations: vi.fn(), projectSessions: vi.fn(), searchConversationsUrl: vi.fn(q => '/search?q=' + q)}));
vi.mock('@/shared/api', () => ({api: apiMocks}));

class SearchStream {
  static instances: SearchStream[] = [];
  handlers = new Map<string, (event: MessageEvent) => void>();
  closed = false;
  constructor(readonly url: string) { SearchStream.instances.push(this); }
  addEventListener(name: string, callback: (event: MessageEvent) => void) { this.handlers.set(name, callback); }
  close() { this.closed = true; }
  emit(name: string, data: unknown = {}) { this.handlers.get(name)?.(new MessageEvent(name, {data: JSON.stringify(data)})); }
}
const response = (data: unknown) => ({ok: true, json: async () => data});
const recent = (id: string) => ({sessionId: id, sessionTitle: id, provider: 'claude', projectId: 'p', projectDisplayName: 'Project'});
beforeEach(() => { vi.clearAllMocks(); SearchStream.instances = []; vi.stubGlobal('EventSource', SearchStream); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test('global pages deduplicate IDs but advance by server rows; failed pagination can retry', async () => {
  apiMocks.recentConversations.mockResolvedValueOnce(response({data: {conversations: [recent('a'), recent('b')], hasMore: true}}))
    .mockResolvedValueOnce({ok: false, status: 503})
    .mockResolvedValueOnce(response({data: {conversations: [recent('b'), recent('c')], hasMore: false}}));
  const {result} = renderHook(() => useSessionsSource(undefined, true));
  await waitFor(() => assert.equal(result.current.items.length, 2));
  await act(async () => { await result.current.loadMore(); });
  assert.equal(result.current.error, true);
  assert.equal(result.current.items.length, 2);
  await act(async () => { await result.current.retry(); });
  assert.deepEqual(result.current.items.map(row => row.id), ['a', 'b', 'c']);
  assert.equal(result.current.hasMore, false);
  assert.equal(apiMocks.recentConversations.mock.calls[2][0].offset, 2);
});

test('scope changes and closing ignore late HTTP results and abort the previous request', async () => {
  let resolveOld: (value: unknown) => void = () => {};
  apiMocks.recentConversations.mockReturnValue(new Promise(resolve => { resolveOld = resolve; }));
  apiMocks.projectSessions.mockResolvedValue(response({sessions: [{id: 'p-session', title: 'P'}], sessionMeta: {hasMore: true, total: 70}}));
  const {result, rerender} = renderHook(({projectId, enabled}) => useSessionsSource(projectId, enabled), {initialProps: {projectId: undefined as string | undefined, enabled: true}});
  rerender({projectId: 'p', enabled: true});
  await waitFor(() => assert.equal(result.current.items[0]?.id, 'p-session'));
  assert.equal(result.current.hasMore, true);
  assert.equal(apiMocks.recentConversations.mock.calls[0][1].signal.aborted, true);
  await act(async () => resolveOld(response({data: {conversations: [recent('wrong')]}})));
  assert.equal(result.current.items[0]?.id, 'p-session');
  rerender({projectId: 'p', enabled: false});
  assert.equal(result.current.items.length, 0);
});

test('global search includes title-only old sessions, merges text hits and retains jump metadata', async () => {
  vi.useFakeTimers();
  const {result} = renderHook(() => useSessionMessageSearch(undefined, 'needle', true));
  await act(async () => vi.advanceTimersByTime(251));
  const stream = SearchStream.instances[0];
  act(() => stream.emit('title-results', {titleResults: [{sessionId: 'old', sessionTitle: 'Old needle', projectId: 'other', projectDisplayName: 'Other', provider: 'claude'}]}));
  assert.equal(result.current.items[0]?.projectId, 'other');
  act(() => stream.emit('result', {projectResult: {projectId: 'other', projectName: 'Other', sessions: [{sessionId: 'old', sessionSummary: 'Old needle', provider: 'claude', matches: [{snippet: 'the needle text', timestamp: '2026-10-22T00:00:00Z'}]}]}}));
  assert.equal(result.current.items.length, 1);
  assert.equal(result.current.items[0]?.snippet, 'the needle text');
  assert.equal(result.current.items[0]?.timestamp, '2026-10-22T00:00:00Z');
  act(() => stream.emit('done'));
  act(() => stream.emit('error'));
  assert.equal(result.current.searching, false);
  assert.equal(result.current.error, false);
  assert.equal(stream.closed, true);
});

test('shorter query closes search, clears results and rejects queued stale events', async () => {
  vi.useFakeTimers();
  const {result, rerender} = renderHook(({query}) => useSessionMessageSearch('p', query, true), {initialProps: {query: 'needle'}});
  await act(async () => vi.advanceTimersByTime(251));
  const stream = SearchStream.instances[0];
  rerender({query: 'n'});
  assert.equal(stream.closed, true);
  act(() => stream.emit('title-results', {titleResults: [{sessionId: 'late', projectId: 'p'}]}));
  assert.equal(result.current.items.length, 0);
  assert.equal(result.current.searching, false);
});

test('project scope excludes other projects; a stream error remains visible until retry', async () => {
  vi.useFakeTimers();
  const {result, unmount} = renderHook(() => useSessionMessageSearch('p', 'needle', true));
  await act(async () => vi.advanceTimersByTime(251));
  const stream = SearchStream.instances[0];
  act(() => stream.emit('title-results', {titleResults: [{sessionId: 'yes', projectId: 'p'}, {sessionId: 'no', projectId: 'q'}]}));
  assert.deepEqual(result.current.items.map(row => row.id), ['yes']);
  act(() => stream.emit('error'));
  assert.equal(result.current.error, true);
  act(() => result.current.retry());
  await act(async () => vi.advanceTimersByTime(251));
  assert.equal(SearchStream.instances.length, 2);
  unmount();
  assert.equal(SearchStream.instances[1].closed, true);
});
