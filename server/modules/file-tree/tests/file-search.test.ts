import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {searchFilePaths} from '../file-search.js';
test('native search finds deep paths, nested ignores, hard exclusions and literal queries',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'drover-search-'));
 try {
  for(const dir of ['deep/a/b','node_modules/pkg','.venv/lib','deep/ignored'])await mkdir(path.join(root,dir),{recursive:true});
  for(const file of ['deep/a/b/needle.ts','node_modules/pkg/needle.ts','.venv/lib/needle.ts','deep/ignored/needle.ts'])await writeFile(path.join(root,file),'ok');
  await writeFile(path.join(root,'deep/.gitignore'),'ignored/');
  const result=await searchFilePaths(root,'needle');assert.deepEqual(result.files.map(n=>path.relative(root,n.path)),[path.join('deep/a/b/needle.ts')]);assert.equal(result.truncated,false);
  assert.equal((await searchFilePaths(root,'needle',false)).files.length,2);
  assert.equal((await searchFilePaths(root,'a/b/needle')).files.length,1);
  assert.equal((await searchFilePaths(root,'[needle]*')).files.length,0);
 } finally {await rm(root,{recursive:true,force:true});}
});
