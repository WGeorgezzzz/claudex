import assert from 'node:assert/strict';

import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import { localFileUrlTransform, parseLocalFileLink } from '@/modules/chat/utils/localFileLink';

const open=vi.hoisted(()=>vi.fn());
const directory=vi.hoisted(()=>vi.fn());
vi.mock('@/modules/command-palette',()=>({usePaletteOps:()=>({openFileInEditor:open,openDirectory:directory})}));
afterEach(()=>{cleanup();open.mockReset();directory.mockReset();});

test('Windows drive links survive markdown sanitation even with a human label',()=>{
  render(<Markdown>{'[查看报告](<C:/work/中文 报告.md>)'}</Markdown>);
  fireEvent.click(screen.getByRole('link',{name:'查看报告'}));
  assert.deepEqual(open.mock.calls[0],['C:/work/中文 报告.md',null]);
});
test('encoded file URL and explicit line open the exact local file',()=>{
  render(<Markdown>{'[打开源码](file:///D:/work/%E4%B8%AD%E6%96%87%20file.py#L12)'}</Markdown>);
  fireEvent.click(screen.getByRole('link',{name:'打开源码'}));
  assert.deepEqual(open.mock.calls[0],['D:/work/中文 file.py',12]);
});
test('relative links preserve encoded filenames and suffix line numbers',()=>{
  render(<Markdown>{'[源码](src/my%20file.ts:23:4)'}</Markdown>);
  fireEvent.click(screen.getByRole('link',{name:'源码'}));
  assert.deepEqual(open.mock.calls[0],['src/my file.ts',23]);
  assert.deepEqual(parseLocalFileLink('/C:/work/file.md'),{path:'C:/work/file.md',line:null});
  assert.deepEqual(parseLocalFileLink('D:\\资料\\a.md'),{path:'D:/资料/a.md',line:null});
});
test('web URLs stay external and executable schemes remain rejected',()=>{
  render(<Markdown>{'[网站](https://example.com/a.pdf)'}</Markdown>);
  const link=screen.getByRole('link',{name:'网站'});assert.equal(link.getAttribute('target'),'_blank');
  assert.equal(localFileUrlTransform('javascript:alert(1)'),'');
  assert.equal(localFileUrlTransform('data:text/html,test'),'');
  assert.equal(localFileUrlTransform('file://remote/share/a.txt'),'');
});
test('directory references still reveal files instead of reading a directory',()=>{
  render(<Markdown>{'[文件夹](file:///D:/work/)'}</Markdown>);
  fireEvent.click(screen.getByRole('link',{name:'文件夹'}));assert.deepEqual(directory.mock.calls[0],['D:/work/']);
});

test('screenshot-style Windows inline code becomes a right-side preview link',()=>{
  render(<Markdown>{'报告已经写到本地：`D:\\workspace\\demo-project\\FINAL-REPORT.md`。'}</Markdown>);
  fireEvent.click(screen.getByRole('link',{name:'D:\\workspace\\demo-project\\FINAL-REPORT.md'}));
  assert.deepEqual(open.mock.calls[0],['D:/workspace/demo-project/FINAL-REPORT.md',null]);
});
test('inline relative paths and line suffixes are linked but commands and fenced code are not',()=>{
  render(<Markdown>{'`docs/中文 报告.md` `src/main.ts:8` `npm run test` `python script.py`\n\n```text\nD:\\report.md\n```'}</Markdown>);
  const links=screen.getAllByRole('link');assert.equal(links.length,2);
  fireEvent.click(links[1]);assert.deepEqual(open.mock.calls[0],['src/main.ts',8]);
});
test('inline code inside an existing link does not create nested links',()=>{
  const {container}=render(<Markdown>{'[`FINAL-REPORT.md`](D:/reports/FINAL-REPORT.md)'}</Markdown>);
  assert.equal(container.querySelectorAll('a').length,1);
  fireEvent.click(screen.getByRole('link'));assert.deepEqual(open.mock.calls[0],['D:/reports/FINAL-REPORT.md',null]);
});

test('Windows backslashes encoded by the Markdown parser remain local links',()=>{
  render(<Markdown>{'[本机报告](D:\\work\\reports/final.md)'}</Markdown>);
  fireEvent.click(screen.getByRole('link',{name:'本机报告'}));
  assert.deepEqual(open.mock.calls[0],['D:/work/reports/final.md',null]);
});
