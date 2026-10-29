import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertUserPath, withUserContext } from '@/modules/auth/index.js';
import { closeConnection, getConnection, initializeDatabase, userDb } from '@/modules/database/index.js';

test('path checks reuse only the authenticated identity and resolve changed permissions on the next request',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'path-context-perf-'));
  const changes={DATABASE_PATH:path.join(root,'test.db'),CLAUDEX_USER_CONFIG_ROOT:path.join(root,'users'),CLAUDE_CONFIG_DIR:path.join(root,'admin-claude'),CODEX_HOME:path.join(root,'admin-codex')};
  const previous=Object.fromEntries(Object.keys(changes).map(k=>[k,process.env[k]]));
  closeConnection();Object.assign(process.env,changes);
  try{
    await initializeDatabase();
    const admin=Number(userDb.createUser('admin','hash').id),member=Number(userDb.createUser('member','hash').id);
    const first=path.join(root,'first'),second=path.join(root,'second');await mkdir(first);await mkdir(second);
    getConnection().prepare("UPDATE users SET role='member',work_root=? WHERE id=?").run(first,member);
    withUserContext(member,()=>{assert.equal(assertUserPath(member,first),first);assert.throws(()=>assertUserPath(member,second),/outside/);});
    withUserContext(admin,()=>{assert.throws(()=>assertUserPath(member,second),/outside/);});
    getConnection().prepare('UPDATE users SET work_root=? WHERE id=?').run(second,member);
    withUserContext(member,()=>{assert.equal(assertUserPath(member,second),second);assert.throws(()=>assertUserPath(member,first),/outside/);});
  }finally{
    closeConnection();for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
    await rm(root,{recursive:true,force:true});
  }
});
