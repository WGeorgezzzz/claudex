import assert from 'node:assert/strict';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,test,vi} from 'vitest';
import FileContextMenu from '@/modules/file-tree/FileContextMenu';
const {copyLocalPath,openLocalFile}=vi.hoisted(()=>({copyLocalPath:vi.fn().mockResolvedValue(undefined),openLocalFile:vi.fn().mockResolvedValue(undefined)}));
vi.mock('@/shared/localPath',()=>({copyLocalPath,openLocalFile}));
beforeEach(()=>{copyLocalPath.mockResolvedValue(undefined);openLocalFile.mockResolvedValue(undefined);});
afterEach(()=>{cleanup();vi.clearAllMocks();});
for(const type of ['file','directory'] as const)test(`file tree ${type} exposes folder operations using native path helper`,async()=>{
 const path=type==='directory'?'D:/project/dir':'D:/project/dir/file.md';
 render(<FileContextMenu item={{name:'item',path,type}}><span>row</span></FileContextMenu>);
 fireEvent.contextMenu(screen.getByText('row'));fireEvent.click(screen.getByRole('menuitem',{name:'复制文件夹路径'}));
 await waitFor(()=>assert.deepEqual(copyLocalPath.mock.calls,[[path,true,type==='directory']]));
 fireEvent.contextMenu(screen.getByText('row'));fireEvent.click(screen.getByRole('menuitem',{name:'打开所在文件夹'}));
 await waitFor(()=>assert.deepEqual(openLocalFile.mock.calls,[[path,true]]));
});
