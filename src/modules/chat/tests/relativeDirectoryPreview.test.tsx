import assert from 'node:assert/strict';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,test,vi} from 'vitest';
import {Markdown} from '@/modules/chat/transcript/Markdown';
import {MarkdownWorkspaceContext} from '@/modules/chat/context/MarkdownWorkspaceContext';
import {folderPath,nativePath} from '@/shared/localPath';
const {preview,readFileBlob}=vi.hoisted(()=>({preview:vi.fn(),readFileBlob:vi.fn()}));
vi.mock('@/shared/api',()=>({api:{readFileBlob}}));
vi.mock('@/modules/command-palette',()=>({usePaletteOps:()=>({openFileInEditor:preview,openDirectory:vi.fn()})}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
test('relative directory hint and bare mp4 / jpg links resolve against conversation cwd before project',async()=>{
  readFileBlob.mockImplementation(async(_id,path)=>({ok:path.startsWith('D:/workspace/task/results-r4/'),status:path.startsWith('D:/workspace/task/results-r4/')?200:404}));
  render(<MarkdownWorkspaceContext.Provider value={{projectId:'one',projectPath:'D:/workspace',cwd:'D:/workspace/task'}}><Markdown>{'文件在 `results-r4/ep05-attempt4-wrist/`：\n\n- [video4-fast.mp4](video4-fast.mp4)\n- [video4-sheet.jpg](video4-sheet.jpg)'}</Markdown></MarkdownWorkspaceContext.Provider>);
  for(const name of ['video4-fast.mp4','video4-sheet.jpg']){fireEvent.click(screen.getByRole('link',{name}));await waitFor(()=>assert.ok(preview.mock.calls.some(call=>call[0]==='D:/workspace/task/results-r4/ep05-attempt4-wrist/'+name)));}
});
test('native Windows clipboard formatting preserves drive roots and directories',()=>{
  assert.equal(nativePath('d:/中文 file/report.md'),'d:\\中文 file\\report.md');
  assert.equal(folderPath('D:/report.md'),'D:\\');
  assert.equal(folderPath('D:/中文/',true),'D:\\中文');
});
test('missing files report every attempted path',async()=>{
  readFileBlob.mockResolvedValue({ok:false,status:404});
  render(<MarkdownWorkspaceContext.Provider value={{projectId:'one',projectPath:'D:/workspace',cwd:'D:/workspace/task'}}><Markdown>{'文件在 `results/`：\n\n[missing.mp4](missing.mp4)'}</Markdown></MarkdownWorkspaceContext.Provider>);
  fireEvent.click(screen.getByRole('link',{name:'missing.mp4'}));await waitFor(()=>assert.match(screen.getByRole('alert').textContent??'',/已尝试.*D:\/workspace\/task\/results\/missing.mp4.*D:\/workspace\/missing.mp4/));
});

test('touch hold keeps the file menu open after the following synthesized click',async()=>{
  render(<MarkdownWorkspaceContext.Provider value={{projectId:'one',projectPath:'D:/workspace'}}><Markdown>{'[movie](D:/workspace/movie.mp4)'}</Markdown></MarkdownWorkspaceContext.Provider>);
  const link=screen.getByRole('link',{name:'movie'});
  fireEvent.touchStart(link,{touches:[{clientX:100,clientY:100}]});
  await waitFor(()=>assert.ok(screen.getByRole('menuitem',{name:'复制文件夹路径'})),{timeout:1000});
  fireEvent.touchEnd(link,{touches:[]});fireEvent.mouseDown(link);fireEvent.click(link);
  assert.equal(preview.mock.calls.length,0);assert.ok(screen.getByRole('menu'));
});
