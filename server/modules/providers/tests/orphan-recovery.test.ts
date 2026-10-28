import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findClaudeCliProcessIds, findResumedProviderProcesses } from '@/modules/providers/services/claude-cli-liveness.service.js';
import { killProcessTree } from '@/shared/process-tree.js';

test('force stop discovers an unregistered resumed process and removes its descendant tree',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'claude-orphan-'));
 const script=path.join(root,'claude-fixture.cjs');
 await writeFile(script,"require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});setInterval(()=>{},1000)");
 const child=spawn(process.execPath,[script,'--resume=orphan-regression-native'],{stdio:'ignore',windowsHide:true});
 try{
  await new Promise(resolve=>setTimeout(resolve,500));
  const found=await findClaudeCliProcessIds('orphan-regression-native');assert.ok(found.includes(child.pid!));
  assert.deepEqual(await findResumedProviderProcesses('different-native','claude'),[]);
  assert.equal(await killProcessTree(child.pid!),true);
  assert.throws(()=>process.kill(child.pid!,0));
 }finally{child.kill();await rm(root,{recursive:true,force:true});}
});
