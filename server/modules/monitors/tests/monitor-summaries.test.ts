import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb, userDb, monitorsDb } from '@/modules/database/index.js';
import { monitorsService } from '@/modules/monitors/monitors.service.js';
import { withUserContext } from '@/modules/auth/index.js';

test('batched monitor summaries distinguish active, paused and backoff, retain latest outcome and exclude stopped/foreign/stale sessions',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'monitor-summary-')),previous=process.env.DATABASE_PATH;
  closeConnection();process.env.DATABASE_PATH=path.join(root,'test.db');await initializeDatabase();
  try{
    const user=Number(userDb.createUser('owner','hash').id);sessionsDb.createAppSession('chat','claude',root,'Chat');
    const monitor=monitorsService.create(user,{sessionId:'chat',name:'Health',content:'Read',intervalMinutes:30});
    assert.equal(monitorsService.summaries(user).chat[0].status,'active');
    monitorsService.action(user,monitor.id,'pause');assert.equal(monitorsService.summaries(user).chat[0].status,'paused');
    monitorsService.action(user,monitor.id,'resume');
    const run=monitorsDb.claim(monitor.id,new Date(Date.now()+1000))!;assert.ok(run);monitorsDb.finish(monitor.id,run,'transport failed');
    const summary=monitorsService.summaries(user).chat[0];assert.equal(summary.last_result,'failed');assert.equal(summary.consecutive_failures,1);
    assert.ok(!('content' in summary));assert.ok(!('options' in summary));
    const other=Number(userDb.createUser('other','hash').id);assert.deepEqual(monitorsService.summaries(other),{});
    // Even malformed imported monitor ownership cannot leak another account's conversation.
    getConnection().prepare('UPDATE monitors SET user_id=? WHERE id=?').run(other,monitor.id);
    assert.deepEqual(withUserContext(other,()=>monitorsService.summaries(other)),{});
    getConnection().prepare('UPDATE monitors SET user_id=? WHERE id=?').run(user,monitor.id);
    monitorsService.action(user,monitor.id,'stop');assert.deepEqual(monitorsService.summaries(user),{});
  }finally{closeConnection();if(previous===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previous;assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(root,{recursive:true,force:true});}
});
