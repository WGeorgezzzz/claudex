import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { withUserContext } from '@/modules/auth/index.js';
import { closeConnection, initializeDatabase, userDb } from '@/modules/database/index.js';
import { closeTaskIntelligence } from '@/modules/taskmaster/index.js';
import { createTaskIntelligenceService } from '@/modules/taskmaster/taskmaster-intelligence.service.js';
import { taskmasterInboxService } from '@/modules/taskmaster/taskmaster-inbox.service.js';

test('a passive-copy snapshot never schedules or automatically starts task intelligence',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'passive-task-intelligence-'));
  const changes={DATABASE_PATH:path.join(root,'test.db'),CLOUDCLI_HOME:path.join(root,'home'),CLAUDEX_PASSIVE_INSTANCE:'1'};
  const previous=Object.fromEntries(Object.keys(changes).map(k=>[k,process.env[k]]));
  closeConnection();Object.assign(process.env,changes);
  let intervals=0,models=0;
  const original=setInterval;
  t.mock.method(globalThis,'setInterval',()=>{intervals++;return original(()=>{},60000);});
  t.mock.method(taskmasterInboxService,'global',async()=>({projects:[],infohub:{}}));
  try{
    await initializeDatabase();const user=Number(userDb.createUser('passive','hash').id);
    const service=createTaskIntelligenceService(async()=>{models++;return {};});
    await withUserContext(user,async()=>{const snapshot=await service.snapshot();assert.equal(snapshot.running,false);assert.equal(snapshot.enabled,true);});
    assert.equal(intervals,0);assert.equal(models,0);
  }finally{
    closeTaskIntelligence();t.mock.restoreAll();closeConnection();for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
    await rm(root,{recursive:true,force:true});
  }
});
