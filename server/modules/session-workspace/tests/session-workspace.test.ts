import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeConnection, getConnection, initializeDatabase, messageQueueDb, sessionsDb, sessionWorkspaceDb, userDb } from '@/modules/database/index.js';
import { sessionWorkspaceService } from '@/modules/session-workspace/session-workspace.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { providerRuntimeService } from '@/modules/providers/index.js';

async function fixture(check:(user:number)=>Promise<void>|void) {
  const old=process.env.DATABASE_PATH;const root=await mkdtemp(path.join(os.tmpdir(),'session-workspace-'));
  closeConnection();process.env.DATABASE_PATH=path.join(root,'test.db');await initializeDatabase();
  const user=Number(userDb.createUser('workspace-user','hash').id);
  sessionsDb.createAppSession('session-one','claude',root,'First conversation');
  try{await check(user);}finally{
    chatRunRegistry.clearAll();closeConnection();if(old===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=old;
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(root,{recursive:true,force:true});
  }
}
const create=(user:number,id:string,mode:'queued'|'live'='queued')=>messageQueueDb.create(user,'session-one',id,id,id,'{}',mode);

test('pins and manual unread flags are account-scoped and survive database reopening',()=>fixture(async user=>{
  const pinned=sessionWorkspaceService.update(user,'session-one',{pinned:true,unread:true});
  assert.ok(pinned.pinnedAt);assert.equal(pinned.unread,true);
  assert.throws(()=>sessionWorkspaceService.get(user+1,'session-one'),error=>error instanceof Error && 'statusCode' in error && error.statusCode===403);
  closeConnection();await initializeDatabase();
  assert.equal(sessionWorkspaceService.get(user,'session-one').pinnedAt,pinned.pinnedAt);
  getConnection().prepare('UPDATE sessions SET isArchived=1 WHERE session_id=?').run('session-one');
  assert.equal(sessionWorkspaceService.list(user).length,0);
  getConnection().prepare('UPDATE sessions SET isArchived=0 WHERE session_id=?').run('session-one');
  assert.equal(sessionWorkspaceService.list(user)[0].unread,true);
}));

test('a stale read acknowledgement cannot clear a newer completed result',()=>fixture(user=>{
  sessionWorkspaceDb.noteActivity(user,'session-one','2026-10-22T01:00:00.000Z');
  sessionWorkspaceDb.noteActivity(user,'session-one','2026-10-22T01:01:00.000Z');
  assert.equal(sessionWorkspaceService.update(user,'session-one',{unread:false,readThrough:'2026-10-22T01:00:00.000Z'}).unread,true);
  assert.equal(sessionWorkspaceService.update(user,'session-one',{unread:false,readThrough:'2026-10-22T01:01:00.000Z'}).unread,false);
  assert.throws(()=>sessionWorkspaceService.update(user,'session-one',{queuePaused:'false'}),/boolean/);
}));

test('pausing survives restart, prevents new claims, and leaves the current run and live inputs alone',()=>fixture(async user=>{
  const current=create(user,'running'),next=create(user,'next');const running=messageQueueDb.claim(current.id)!;
  sessionWorkspaceService.update(user,'session-one',{queuePaused:true});
  assert.equal(messageQueueDb.get(user,current.id)?.status,'running');
  const live=create(user,'live','live');assert.ok(messageQueueDb.claim(live.id,'live'));
  messageQueueDb.finish(running,'succeeded',null);
  assert.equal(messageQueueDb.claim(next.id),null);assert.deepEqual(messageQueueDb.heads(),[]);
  closeConnection();await initializeDatabase();
  assert.equal(sessionWorkspaceService.get(user,'session-one').queuePaused,true);
  assert.equal(messageQueueDb.claim(next.id),null);
  sessionWorkspaceService.update(user,'session-one',{queuePaused:false});
  assert.equal(messageQueueDb.claim(next.id)?.status,'running');
}));

test('pending order changes atomically, rejects stale revisions, and cannot bypass an uncertain head',()=>fixture(user=>{
  const first=create(user,'first'),second=create(user,'second'),third=create(user,'third');
  assert.equal(messageQueueDb.move(user,second.id,second.revision,'up'),true);
  assert.equal(messageQueueDb.heads()[0].id,second.id);
  assert.equal(messageQueueDb.move(user,first.id,first.revision,'up'),false);
  const claimed=messageQueueDb.claim(second.id)!;messageQueueDb.finish(claimed,'failed','retain failure');
  const refreshed=messageQueueDb.get(user,first.id)!;
  assert.equal(messageQueueDb.move(user,first.id,refreshed.revision,'up'),false);
  assert.equal(messageQueueDb.move(user,third.id,third.revision,'up'),true);
  assert.deepEqual(messageQueueDb.heads(),[]);
  assert.equal(messageQueueDb.attempts(user,second.id)[0].status,'failed');
}));

test('attention combines persisted queue blockers with only this user’s pending approvals',t=>fixture(user=>{
  const queued=create(user,'waiting');const claimed=messageQueueDb.claim(queued.id)!;
  messageQueueDb.finish(claimed,'interrupted','unknown outcome');
  chatRunRegistry.startRun({appSessionId:'session-one',provider:'claude',providerSessionId:null,connection:null,userId:user});
  t.mock.method(providerRuntimeService,'getPendingApprovalsForSession',()=>[{requestId:'approval'}]);
  const entry=sessionWorkspaceService.list(user)[0];
  assert.equal(entry.blockedCount,1);assert.equal(entry.approvalCount,1);
  chatRunRegistry.completeRun('session-one',{exitCode:0});
  assert.equal(sessionWorkspaceService.list(user)[0].approvalCount,1);
  sessionWorkspaceService.update(user,'session-one',{unread:false});
  chatRunRegistry.getRun('session-one')!.writer.send({kind:'text',role:'assistant',provider:'claude',content:'background result'});
  assert.equal(sessionWorkspaceService.get(user,'session-one').unread,true);
  assert.equal(sessionWorkspaceService.list(user+1).length,0);
}));

test('workspace rejects another owner and hides forged legacy organization rows',()=>fixture(user=>{
  assert.throws(()=>sessionWorkspaceService.update(user+1,'session-one',{pinned:true}),error=>error instanceof Error && 'statusCode' in error && error.statusCode===403);
  sessionWorkspaceDb.update(user+1,'session-one',{pinned:true});
  assert.deepEqual(sessionWorkspaceService.list(user+1),[]);
  assert.throws(()=>sessionWorkspaceService.get(user+1,'session-one'),error=>error instanceof Error && 'statusCode' in error && error.statusCode===403);
}));
