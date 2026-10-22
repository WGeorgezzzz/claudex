import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, dotDb, projectsDb, messageQueueDb, userDb } from '@/modules/database/index.js';
import { dotService } from '@/modules/dot/dot.service.js';
import { executeDotTool } from '@/modules/dot/dot.tools.js';
import { reportDotTasks } from '@/modules/dot/dot.reports.js';
import { sessionsService } from '@/modules/providers/index.js';

test('Dot preserves ownership, memory revisions, durable delegation and exactly-once failure reporting',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'claudex-dot-'));const old=process.env.DATABASE_PATH,home=process.env.CLOUDCLI_HOME;
  closeConnection();process.env.DATABASE_PATH=path.join(root,'test.db');process.env.CLOUDCLI_HOME=root;await initializeDatabase();
  try{
    const uid=Number(userDb.createUser('dot-owner','hash').id),other=uid+1;
    const thread=dotService.createThread(uid,'Personal assistant');
    assert.equal(dotDb.owns(other,thread.sessionId),false);
    const [memory]=dotService.saveMemory(uid,'Prefer concise reports');
    assert.equal(dotDb.memories(other).length,0);
    assert.throws(()=>dotService.saveMemory(other,'other edit',memory.id,0),/changed/);
    dotService.saveMemory(uid,'Prefer concise Chinese reports',memory.id,0);
    assert.throws(()=>dotService.forget(uid,memory.id,0),/changed/);
    const context={userId:uid,sessionId:thread.sessionId,autonomous:true,planMode:false};
    assert.throws(()=>executeDotTool(context,{action:'remember',content:'unauthorized'}),/cannot/);
    const project=projectsDb.createProjectPath(root,'Test project').project!;
    const task=dotService.delegate(uid,thread.sessionId,project.project_id,'Compute 2+3','one');
    assert.equal(dotService.delegate(uid,thread.sessionId,project.project_id,'Compute 2+3','one').id,task.id);
    assert.throws(()=>dotService.delegate(uid,thread.sessionId,project.project_id,'different','one'),/already used/);
    assert.throws(()=>dotService.delegate(other,thread.sessionId,project.project_id,'Compute 2+3','two'),/not found/);
    const row=messageQueueDb.get(uid,task.queue_id)!;
    assert.equal(JSON.parse(row.options).permissionMode,'default');
    assert.equal(JSON.parse(row.options).cloudcliBridgeSourceSessionId,thread.sessionId);
    const claimed=messageQueueDb.claim(row.id)!;assert.ok(claimed);
    messageQueueDb.finish(claimed,'failed','Retained infrastructure failure');
    await reportDotTasks();await reportDotTasks();
    const reports=messageQueueDb.list(uid,thread.sessionId);assert.equal(reports.length,1);
    assert.match(reports[0].content,/Retained infrastructure failure/);
    assert.equal(dotDb.tasks(uid)[0].reported,1);
    assert.equal(dotDb.tasks(uid)[0].status,'failed');
    const later=dotService.delegate(uid,thread.sessionId,project.project_id,'Second task','two');
    const success=messageQueueDb.claim(later.queue_id)!;messageQueueDb.finish(success,'succeeded',null);
    const originalRead=sessionsService.fetchHistory;
    try{
      sessionsService.fetchHistory=async()=>({messages:[],total:0,hasMore:false,offset:0,limit:20});
      await reportDotTasks();assert.equal(dotDb.tasks(uid).find(t=>t.id===later.id)!.reported,0);
      sessionsService.fetchHistory=async()=>({messages:[{id:'flush-test',sessionId:later.target_session_id,timestamp:new Date().toISOString(),provider:'claude',kind:'text',role:'assistant',content:'RESULT_AFTER_FLUSH'}],total:1,hasMore:false,offset:0,limit:20});
      await reportDotTasks();assert.equal(dotDb.tasks(uid).find(t=>t.id===later.id)!.reported,1);
      assert.ok(messageQueueDb.list(uid,thread.sessionId).some(q=>q.content.includes('RESULT_AFTER_FLUSH')));
    }finally{sessionsService.fetchHistory=originalRead;}
    dotService.forget(uid,memory.id,1);assert.equal(dotDb.memories(uid).length,0);
  }finally{closeConnection();if(old===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=old;if(home===undefined)delete process.env.CLOUDCLI_HOME;else process.env.CLOUDCLI_HOME=home;assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(root,{recursive:true,force:true});}
});
