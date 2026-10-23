import assert from 'node:assert/strict';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { isAbbreviatedFilePath } from '@/modules/chat/utils/localFileLink';

const preview = vi.hoisted(() => vi.fn());
const readFileBlob = vi.hoisted(() => vi.fn());
const resolveFilePattern = vi.hoisted(() => vi.fn());
vi.mock('@/shared/api', () => ({ api: { readFileBlob, resolveFilePattern } }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOps: () => ({ openFileInEditor: preview, openDirectory: vi.fn() }) }));
afterEach(() => { cleanup(); preview.mockReset(); readFileBlob.mockReset(); resolveFilePattern.mockReset(); });

const directory = 'D:/embodied/clickbell-speed100-hot-20261023/preview-r6/';
const real = directory + '02-left-bell-52002800000-0000-clutter10.mp4';
const message = '视频已拉到本机：`D:\\embodied\\clickbell-speed100-hot-20261023\\preview-r6\\`。文件名带臂别和杂物件数，比如 `02-left-…-clutter10.mp4`';
const json = (matches: string[]) => ({ ok: true, status: 200, json: async () => ({ matches, truncated: false }) });
const renderMessage = (text = message) => render(<MarkdownWorkspaceContext.Provider value={{ projectId: 'p1', projectPath: 'D:\\embodied' }}>
  <Markdown>{text}</Markdown>
</MarkdownWorkspaceContext.Provider>);

test('ellipsis detection ignores ./ and ../ segments and bare dots', () => {
  assert.equal(isAbbreviatedFilePath('02-left-…-clutter10.mp4'), true);
  assert.equal(isAbbreviatedFilePath('D:/out/run...final.log'), true);
  assert.equal(isAbbreviatedFilePath('../docs/report.md'), false);
  assert.equal(isAbbreviatedFilePath('./a/report.md'), false);
  assert.equal(isAbbreviatedFilePath('…'), false);
});

test('an abbreviated name beside its directory opens the single real file and shows it in the tooltip', async () => {
  resolveFilePattern.mockResolvedValue(json([real.replace(/\//g, '\\')]));
  renderMessage();
  const link = screen.getByRole('link', { name: '02-left-…-clutter10.mp4' });
  fireEvent.click(link);
  await waitFor(() => assert.deepEqual(preview.mock.calls, [[real, null]]));
  assert.deepEqual(resolveFilePattern.mock.calls.map(call => call.slice(0, 2)), [['p1', directory + '02-left-…-clutter10.mp4']]);
  assert.equal(readFileBlob.mock.calls.length, 0);
  assert.equal(link.getAttribute('title'), real);
});

test('several matches show a chooser instead of opening an arbitrary file', async () => {
  const other = directory + '02-left-bell-99-clutter10.mp4';
  resolveFilePattern.mockResolvedValue(json([real, other]));
  renderMessage();
  fireEvent.click(screen.getByRole('link', { name: '02-left-…-clutter10.mp4' }));
  const chooser = await screen.findByRole('group', { name: '匹配的文件' });
  assert.equal(preview.mock.calls.length, 0);
  fireEvent.click(screen.getByRole('button', { name: '02-left-bell-99-clutter10.mp4' }));
  await waitFor(() => assert.deepEqual(preview.mock.calls, [[other, null]]));
  assert.equal(chooser.isConnected, false);
});

test('no match keeps a visible error and opens nothing', async () => {
  resolveFilePattern.mockResolvedValue(json([]));
  renderMessage();
  fireEvent.click(screen.getByRole('link', { name: '02-left-…-clutter10.mp4' }));
  assert.match((await screen.findByRole('alert')).textContent ?? '', /未找到/);
  assert.equal(preview.mock.calls.length, 0);
});

test('an absolute abbreviated path also resolves through the server', async () => {
  resolveFilePattern.mockResolvedValue(json([real]));
  renderMessage('`D:\\embodied\\clickbell-speed100-hot-20261023\\preview-r6\\02-left-...-clutter10.mp4`');
  fireEvent.click(screen.getByRole('link'));
  await waitFor(() => assert.deepEqual(preview.mock.calls, [[real, null]]));
  assert.equal(resolveFilePattern.mock.calls[0][1], directory + '02-left-...-clutter10.mp4');
});
