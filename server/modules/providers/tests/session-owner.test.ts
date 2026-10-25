import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertSessionOwnerAvailable } from '@/modules/providers/services/session-owner.service.js';

test('side-by-side ownership blocks imported sessions while allowing independent new and forked sessions',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'cloudcli-owner-'));
  const filename=path.join(directory,'owners.json');
  const previous=process.env.CLOUDCLI_PROTECTED_SESSIONS_FILE;
  try {
    await writeFile(filename,JSON.stringify({sessionIds:['legacy-running']}));
    process.env.CLOUDCLI_PROTECTED_SESSIONS_FILE=filename;
    assert.throws(()=>assertSessionOwnerAvailable('legacy-running'),/original AgentHub/);
    assert.doesNotThrow(()=>assertSessionOwnerAvailable('new-independent-chat'));
    process.env.CLOUDCLI_PROTECTED_SESSIONS_FILE=path.join(directory,'missing.json');
    assert.throws(()=>assertSessionOwnerAvailable('legacy-running'));
  } finally {
    if(previous===undefined)delete process.env.CLOUDCLI_PROTECTED_SESSIONS_FILE;else process.env.CLOUDCLI_PROTECTED_SESSIONS_FILE=previous;
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));
    await rm(directory,{recursive:true,force:true});
  }
});
