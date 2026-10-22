import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openLocalPath } from '../localPath.js';

test('native file opening passes a Unicode path as one argument and propagates OS errors',async()=>{
  const target=path.resolve('中文 文件.md');let observed;
  await openLocalPath(target,async value=>{observed=value;return '';});
  assert.equal(observed,target);
  await assert.rejects(openLocalPath(target,async()=> 'File not found'),/File not found/);
  for (const invalid of ['', 'relative.txt', 'bad\0path']) await assert.rejects(openLocalPath(invalid,async()=>{throw Error('must not launch');}),/absolute local path/);
});
