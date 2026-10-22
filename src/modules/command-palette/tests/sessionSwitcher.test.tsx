import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import CommandPalette from '@/modules/command-palette/CommandPalette';
import { PaletteOpsProvider, usePaletteOps } from '@/modules/command-palette/context/PaletteOpsContext';
import type { PaletteSessionEntry } from '@/shared/types';

const sources = vi.hoisted(() => ({loadMore: vi.fn(), calls: vi.fn(), search: vi.fn(), matches: [] as PaletteSessionEntry[]}));
vi.mock('react-i18next', () => ({useTranslation: () => ({t: (key: string) => key})}));
vi.mock('@/shared/context/ThemeContext', () => ({useTheme: () => ({toggleDarkMode: vi.fn()})}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({useBusySessionIdSet: () => new Set(['session-0'])}));
vi.mock('@/modules/command-palette/hooks/useSessionsSource', () => ({useSessionsSource: (id: string, enabled: boolean) => {
  sources.calls(id, enabled);
  return {items: Array.from({length: 7}, (_, i) => ({id: `session-${i}`, label: i === 6 ? 'needle older chat' : `chat ${i}`, projectId: 'other', projectName: 'Other project', provider: 'claude'})), hasMore: true, loading: false, error: false, loadMore: sources.loadMore};
}}));
vi.mock('@/modules/command-palette/hooks/useSessionMessageSearch', () => ({useSessionMessageSearch: (...args: unknown[]) => {sources.search(...args);return {items: sources.matches, searching: false, error: false};}}));
vi.mock('@/modules/command-palette/hooks/usePaletteSessionStatus', () => ({usePaletteSessionStatus: () => [{sessionId: 'session-0', pinnedAt: 1, unread: true}]}));
vi.mock('@/modules/command-palette/hooks/useFilesSource', () => ({useFilesSource: () => []}));
vi.mock('@/modules/command-palette/hooks/useCommitsSource', () => ({useCommitsSource: () => []}));
vi.mock('@/modules/command-palette/hooks/useBranchesSource', () => ({useBranchesSource: () => []}));
vi.mock('@/modules/command-palette/hooks/useGitActions', () => ({useGitActions: () => ({})}));

function Trigger() { const ops = usePaletteOps(); return <button onClick={ops.openSessionSwitcher}>Open sessions</button>; }
function setup() {
  const select = vi.fn();
  render(<MemoryRouter><PaletteOpsProvider><Trigger/><CommandPalette selectedProject={{projectId: 'current', displayName: 'Current', fullPath: 'D:/current'}} onStartNewChat={vi.fn()} onOpenSettings={vi.fn()} onSelectSession={select}/></PaletteOpsProvider></MemoryRouter>);
  return select;
}
beforeEach(() => {
  vi.clearAllMocks();
  sources.matches = [];
  vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

test('Ctrl+Shift+K opens all projects, shows status and supports scope changes and pagination', async () => {
  const select = setup();
  fireEvent.keyDown(document, {key: 'k', ctrlKey: true, shiftKey: true});
  await waitFor(() => assert.ok(screen.getByRole('dialog')));
  await waitFor(() => assert.equal(document.activeElement, screen.getByRole('combobox')));
  assert.equal(screen.getByRole('button', {name: 'commandPalette.allProjects'}).getAttribute('aria-pressed'), 'true');
  assert.ok(screen.getByLabelText('commandPalette.pinned'));
  assert.ok(screen.getByLabelText('commandPalette.unread'));
  assert.ok(screen.getByText('commandPalette.running'));
  fireEvent.click(screen.getByRole('button', {name: 'commandPalette.currentProject'}));
  assert.deepEqual(sources.calls.mock.calls.at(-1), ['current', true]);
  fireEvent.click(screen.getByRole('button', {name: 'commandPalette.loadMoreSessions'}));
  assert.equal(sources.loadMore.mock.calls.length, 1);
  fireEvent.click(screen.getByRole('option', {name: /needle older chat/}));
  assert.equal(select.mock.calls[0][0].id, 'session-6');
  assert.equal(select.mock.calls[0][0].projectId, 'other');
  await waitFor(() => assert.equal(screen.queryByRole('dialog'), null));
});

test('regular Ctrl+K search includes a matching session beyond the initial five rows', async () => {
  setup();
  fireEvent.keyDown(document, {key: 'k', ctrlKey: true});
  fireEvent.change(screen.getByRole('combobox'), {target: {value: 'needle'}});
  await waitFor(() => assert.ok(screen.getByRole('option', {name: /needle older chat/})));
});

test('the visible trigger opens the same switcher and Escape closes it without selecting a chat', async () => {
  const select = setup();
  fireEvent.click(screen.getByRole('button', {name: 'Open sessions'}));
  assert.ok(screen.getByRole('button', {name: 'commandPalette.allProjects'}));
  fireEvent.keyDown(screen.getByRole('combobox'), {key: 'Escape'});
  await waitFor(() => assert.equal(screen.queryByRole('dialog'), null));
  assert.equal(select.mock.calls.length, 0);
});

test('a later transcript match makes an initially filtered-out session group visible', async () => {
  const tree = () => <MemoryRouter><PaletteOpsProvider><CommandPalette selectedProject={null} onStartNewChat={vi.fn()} onOpenSettings={vi.fn()}/></PaletteOpsProvider></MemoryRouter>;
  const view = render(tree());
  fireEvent.keyDown(document, {key: 'k', ctrlKey: true, shiftKey: true});
  fireEvent.change(screen.getByRole('combobox'), {target: {value: 'transcript needle'}});
  assert.equal(screen.queryByRole('option'), null);
  sources.matches = [{id: 'session-0', label: 'chat 0', snippet: 'found transcript needle in a reply', projectName: 'Other project'}];
  view.rerender(tree());
  await waitFor(() => assert.ok(screen.getByRole('option', {name: /found transcript needle/})));
});
