import assert from 'node:assert/strict';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';

const preview = vi.hoisted(() => vi.fn());
const readFileBlob = vi.hoisted(() => vi.fn());
vi.mock('@/shared/api', () => ({ api: { readFileBlob } }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOps: () => ({ openFileInEditor: preview, openDirectory: vi.fn() }) }));
const desktop = window as unknown as { cloudcliDesktop?: { openLocalPath: ReturnType<typeof vi.fn> } };
afterEach(() => { cleanup(); preview.mockReset(); readFileBlob.mockReset(); delete desktop.cloudcliDesktop; });

test('right-click opens the exact decoded Windows path without line suffix; left-click still previews', async () => {
  desktop.cloudcliDesktop = { openLocalPath: vi.fn().mockResolvedValue({}) };
  render(<Markdown>{'[报告](file:///D:/work/%E4%B8%AD%E6%96%87%20file.md#L12)'}</Markdown>);
  const link = screen.getByRole('link', { name: '报告' });
  fireEvent.contextMenu(link, { clientX: 30, clientY: 40 });
  assert.equal(preview.mock.calls.length, 0);
  fireEvent.click(screen.getByRole('menuitem', { name: /Open locally|本地打开/ }));
  await waitFor(() => assert.deepEqual(desktop.cloudcliDesktop?.openLocalPath.mock.calls, [['D:/work/中文 file.md']]));
  assert.equal(screen.queryByRole('menu'), null);
  fireEvent.click(link);
  assert.deepEqual(preview.mock.calls[0], ['D:/work/中文 file.md', 12]);
});

test('inline relative references use their conversation project for native opening', async () => {
  desktop.cloudcliDesktop = { openLocalPath: vi.fn().mockResolvedValue({}) };
  render(<MarkdownWorkspaceContext.Provider value={{ projectId: 'one', projectPath: 'D:\\项目' }}>
    <Markdown>{'`docs/报告.md:23`'}</Markdown>
  </MarkdownWorkspaceContext.Provider>);
  fireEvent.contextMenu(screen.getByRole('link'));
  fireEvent.click(screen.getByRole('menuitem', { name: /Open locally|本地打开/ }));
  await waitFor(() => assert.deepEqual(desktop.cloudcliDesktop?.openLocalPath.mock.calls, [['D:/项目/docs/报告.md']]));
});

test('keyboard menu navigation and Escape restore the link without launching', () => {
  render(<Markdown>{'[报告](D:/report.md)'}</Markdown>);
  const link = screen.getByRole('link');
  fireEvent.keyDown(link, { key: 'F10', shiftKey: true });
  const menu = screen.getByRole('menu');
  assert.equal(document.activeElement, screen.getByRole('menuitem', { name: /Open locally|本地打开/ }));
  fireEvent.keyDown(menu, { key: 'ArrowDown' });
  assert.equal(document.activeElement, screen.getByRole('menuitem', { name: /Preview in Nexagent|在 Nexagent 中预览/ }));
  fireEvent.keyDown(menu, { key: 'Escape' });
  assert.equal(screen.queryByRole('menu'), null);
  assert.equal(document.activeElement, link);
});

test('OS launch failures are visible and do not trigger preview or browser navigation', async () => {
  desktop.cloudcliDesktop = { openLocalPath: vi.fn().mockRejectedValue(new Error('File no longer exists')) };
  render(<Markdown>{'[报告](D:/missing.md)'}</Markdown>);
  fireEvent.contextMenu(screen.getByRole('link'));
  fireEvent.click(screen.getByRole('menuitem', { name: /Open locally|本地打开/ }));
  await waitFor(() => assert.match(screen.getByRole('alert').textContent || '', /no longer exists/));
  assert.equal(preview.mock.calls.length, 0);
});

test('web links keep the browser context menu', () => {
  render(<Markdown>{'[网站](https://example.com/file.pdf)'}</Markdown>);
  fireEvent.contextMenu(screen.getByRole('link'));
  assert.equal(screen.queryByRole('menu'), null);
});

const sampleRoot = 'D:/workspace/demo-video/sample_videos/';

test('a short report beside an absolute report uses that report directory, not the broad project root', async () => {
  const expected='D:/workspace/demo-analysis/simeval/REPORT_zh.md';
  readFileBlob.mockImplementation(async (_project,path)=>({ok:path===expected,status:path===expected?200:404}));
  desktop.cloudcliDesktop={openLocalPath:vi.fn().mockResolvedValue({})};
  const message='## 报告位置\n\n- 真机：`D:\\workspace\\demo-analysis\\real\\REPORT_zh.md`（E组）\n'
    +'- 补采和训练：`D:\\workspace\\piper-act-left-centerbell-20261023\\REPORT_zh.md`\n'
    +'- 训练和仿真评测：`D:\\workspace\\demo-analysis\\REPORT_zh.md`、`simeval\\REPORT_zh.md`';
  render(<MarkdownWorkspaceContext.Provider value={{projectId:'one',projectPath:'D:/workspace'}}><Markdown>{message}</Markdown></MarkdownWorkspaceContext.Provider>);
  const link=screen.getByRole('link',{name:'simeval\\REPORT_zh.md'});
  fireEvent.contextMenu(link);fireEvent.click(screen.getByRole('menuitem',{name:/Open locally|本地打开/}));
  await waitFor(()=>assert.deepEqual(desktop.cloudcliDesktop?.openLocalPath.mock.calls,[[expected]]));
  fireEvent.click(link);await waitFor(()=>assert.deepEqual(preview.mock.calls,[[expected,null]]));
  assert.ok(readFileBlob.mock.calls.every(call=>call[1]===expected&&call[2].method==='HEAD'));
});

test('multiple nearby absolute reports never pick an arbitrary existing relative file', async () => {
  desktop.cloudcliDesktop={openLocalPath:vi.fn().mockResolvedValue({})};readFileBlob.mockResolvedValue({ok:true,status:200});
  render(<MarkdownWorkspaceContext.Provider value={{projectId:'one',projectPath:'D:/workspace'}}><Markdown>{'`D:/one/REPORT.md`、`D:/two/REPORT.md`、`simeval/REPORT.md`'}</Markdown></MarkdownWorkspaceContext.Provider>);
  fireEvent.contextMenu(screen.getByRole('link',{name:'simeval/REPORT.md'}));fireEvent.click(screen.getByRole('menuitem',{name:/Open locally|本地打开/}));
  await waitFor(()=>assert.match(screen.getByRole('group').textContent||'',/多个同名文件/));
  assert.equal(desktop.cloudcliDesktop?.openLocalPath.mock.calls.length,0);
});
const sampleMessage = '**样例视频**：`' + sampleRoot.replace(/\//g, '\\') + '`\n\n'
  + '| 目录 | 内容 |\n|---|---|\n| `clean_bell-846000000-0001\\` | `high.mp4` |\n'
  + '| `random_bell-857000000-0002\\` | 文件同上 |\n\n我抽帧看了 clean：`_head_6frames.jpg`';

test('the screenshot table resolves its video under the row directory, preserving its short label', async () => {
  desktop.cloudcliDesktop = { openLocalPath: vi.fn().mockResolvedValue({}) };
  render(<MarkdownWorkspaceContext.Provider value={{projectId: 'one', projectPath: 'D:/workspace'}}><Markdown>{sampleMessage}</Markdown></MarkdownWorkspaceContext.Provider>);
  const link = screen.getByRole('link', {name: 'high.mp4'});
  fireEvent.contextMenu(link);
  fireEvent.click(screen.getByRole('menuitem', {name: /Open locally|本地打开/}));
  const expected = sampleRoot + 'clean_bell-846000000-0001/high.mp4';
  await waitFor(() => assert.deepEqual(desktop.cloudcliDesktop?.openLocalPath.mock.calls, [[expected]]));
  fireEvent.click(link);
  await waitFor(() => assert.deepEqual(preview.mock.calls, [[expected, null]]));
  assert.equal(readFileBlob.mock.calls.length, 0);
});

test('a filename below the table resolves only the existing absolute candidate', async () => {
  const expected = sampleRoot + 'clean_bell-846000000-0001/_head_6frames.jpg';
  readFileBlob.mockImplementation(async (_project, path) => ({ok: path === expected, status: path === expected ? 200 : 404}));
  desktop.cloudcliDesktop = { openLocalPath: vi.fn().mockResolvedValue({}) };
  render(<MarkdownWorkspaceContext.Provider value={{projectId: 'one', projectPath: 'D:/workspace'}}><Markdown>{sampleMessage}</Markdown></MarkdownWorkspaceContext.Provider>);
  fireEvent.contextMenu(screen.getByRole('link', {name: '_head_6frames.jpg'}));
  fireEvent.click(screen.getByRole('menuitem', {name: /Open locally|本地打开/}));
  await waitFor(() => assert.deepEqual(desktop.cloudcliDesktop?.openLocalPath.mock.calls, [[expected]]));
  assert.ok(readFileBlob.mock.calls.length >= 3);
  assert.ok(readFileBlob.mock.calls.every(call => call[2].method === 'HEAD'));
});

test('ambiguous filenames never open an arbitrary matching file', async () => {
  readFileBlob.mockResolvedValue({ok: true, status: 200});
  desktop.cloudcliDesktop = { openLocalPath: vi.fn().mockResolvedValue({}) };
  render(<MarkdownWorkspaceContext.Provider value={{projectId: 'one', projectPath: 'D:/workspace'}}><Markdown>{sampleMessage}</Markdown></MarkdownWorkspaceContext.Provider>);
  fireEvent.contextMenu(screen.getByRole('link', {name: '_head_6frames.jpg'}));
  fireEvent.click(screen.getByRole('menuitem', {name: /Open locally|本地打开/}));
  await waitFor(() => assert.match(screen.getByRole('group').textContent || '', /多个同名文件/));
  assert.equal(desktop.cloudcliDesktop?.openLocalPath.mock.calls.length, 0);
});
