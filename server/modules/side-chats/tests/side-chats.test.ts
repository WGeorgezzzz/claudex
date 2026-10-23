import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb, sideChatsDb, userDb } from '@/modules/database/index.js';
import { createSideChatsService as createService } from '@/modules/side-chats/side-chats.service.js';

const createSideChatsService=(fork:Parameters<typeof createService>[0])=>createService(fork,async()=> 'completed-anchor');

async function fixture(check:(userId:number,root:string)=>Promise<void>) {
  const previous=process.env.DATABASE_PATH;
  const root=await mkdtemp(path.join(os.tmpdir(),'workbench-side-'));
  closeConnection();process.env.DATABASE_PATH=path.join(root,'test.db');await initializeDatabase();
  const userId=Number(userDb.createUser('side-test','hash').id);
  sessionsDb.createAppSession('parent','claude',root,'Main');
  try {await check(userId,root);}
  finally {
    closeConnection();
    if(previous===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previous;
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
    await rm(root,{recursive:true,force:true});
  }
}
function fakeFork(root:string,onFork?:()=>Promise<void>) {
  return async(parent:string,options:{title?:string}={},reserved?:string)=>{
    await onFork?.();
    const id=reserved!;
    sessionsDb.createForkedSession({sessionId:id,provider:'claude',projectPath:root,
      customName:options.title||'Side',providerSessionId:`native-${id}`,jsonlPath:path.join(root,`${id}.jsonl`),
      forkedFromSessionId:parent,model:null,effort:null});
    return {sessionId:id,provider:'claude' as const,projectPath:root,sessionName:options.title||'Side'};
  };
}
const input={parentSessionId:'parent',requestId:'create-one',title:'First side'};

test('concurrent retries reserve one child and preserve immutable request identity after rename',()=>fixture(async(userId,root)=>{
  let calls=0,release!:()=>void,started!:()=>void;
  const ready=new Promise<void>(resolve=>{started=resolve;});
  const service=createSideChatsService(fakeFork(root,async()=>{calls++;await new Promise<void>(resolve=>{release=resolve;started();});}));
  const first=service.create(userId,input);
  const second=service.create(userId,input);
  await ready;
  release();
  const [a,b]=await Promise.all([first,second]);
  assert.equal(a.id,b.id);assert.equal(calls,1);
  assert.equal(sessionsDb.getSessionById(a.child_session_id)?.forked_from_session_id,'parent');
  assert.equal(sessionsDb.getSessionById('parent')?.custom_name,'Main');
  await service.update(userId,a.id,{title:'Renamed'});
  assert.equal((await service.create(userId,input)).title,'Renamed');
  await assert.rejects(service.create(userId,{...input,title:'Different intent'}),/different input/);
}));

test('multiple side conversations persist, stay out of the main feed, and promote explicitly',()=>fixture(async(userId,root)=>{
  const service=createSideChatsService(fakeFork(root));
  const a=await service.create(userId,input);
  const b=await service.create(userId,{...input,requestId:'create-two',title:'Second side'});
  assert.equal(service.list(userId,'parent').length,2);
  assert.equal(sessionsDb.countSessionsByProjectPath(root),1);
  await service.update(userId,a.id,{action:'archive'});
  assert.equal(sideChatsDb.get(userId,a.id)?.status,'archived');
  assert.equal(sessionsDb.getSessionById(a.child_session_id)?.isArchived,0,'organization never deletes or stops a child');
  await service.update(userId,a.id,{action:'restore'});
  await service.update(userId,b.id,{action:'promote'});
  assert.equal(sessionsDb.countSessionsByProjectPath(root),2);
  closeConnection();await initializeDatabase();
  assert.equal(sideChatsDb.list(userId,'parent').length,2);
  assert.equal(sideChatsDb.get(userId,b.id)?.status,'promoted');
  await assert.rejects(service.update(userId+1,a.id,{action:'archive'}),/not found/);
}));

test('default opening from two clients returns one managed conversation',()=>fixture(async(userId,root)=>{
  const service=createSideChatsService(fakeFork(root));
  const [a,b]=await Promise.all([
    service.create(userId,{...input,ensureDefault:true}),
    service.create(userId,{...input,requestId:'other-window',ensureDefault:true}),
  ]);
  assert.equal(a.child_session_id,b.child_session_id);
  assert.equal(sideChatsDb.list(userId,'parent').length,1);
}));

test('recovery attaches an already committed reserved child and retains failed creations',()=>fixture(async(userId,root)=>{
  const unfinished=sideChatsDb.reserve(userId,'parent','unfinished','Unfinished');
  const committed=sideChatsDb.reserve(userId,'parent','committed','Committed');
  await fakeFork(root)('parent',{title:'Committed'},committed.child_session_id);
  closeConnection();await initializeDatabase();sideChatsDb.recover();
  assert.equal(sideChatsDb.get(userId,unfinished.id)?.status,'failed');
  assert.equal(sideChatsDb.get(userId,committed.id)?.status,'active');
  const broken=createSideChatsService(async()=>{throw new Error('provider unavailable');});
  await assert.rejects(broken.create(userId,{...input,requestId:'broken'}),/unavailable/);
  assert.equal(sideChatsDb.byRequest(userId,'broken')?.status,'failed');
}));

test('legacy adoption verifies the actual parent and does not accept arbitrary session links',()=>fixture(async(userId,root)=>{
  const service=createSideChatsService(fakeFork(root));
  await fakeFork(root)('parent',{title:'Legacy'},'legacy-child');
  assert.equal(service.adopt(userId,'parent','legacy-child').child_session_id,'legacy-child');
  assert.equal(service.adopt(userId,'parent','legacy-child').status,'active');
  sessionsDb.createAppSession('wrong-parent','claude',root);
  assert.throws(()=>service.adopt(userId,'wrong-parent','legacy-child'),/verified fork/);
  assert.throws(()=>service.adopt(userId+1,'parent','legacy-child'),/another user/);
}));

test('the display boundary is frozen after copied timestamps and survives later renaming',()=>fixture(async(userId,root)=>{
  let copyFinished=0;
  const service=createSideChatsService(fakeFork(root,async()=>{
    await new Promise(resolve=>setTimeout(resolve,10));
    copyFinished=Date.now();
  }));
  const created=await service.create(userId,input);
  assert.ok(created.context_frozen_at);
  assert.ok(Date.parse(created.context_frozen_at!)>=copyFinished);
  assert.ok(Date.parse(created.context_frozen_at!)>Date.parse(created.context_cutoff));
  const renamed=await service.update(userId,created.id,{title:'Later title'});
  assert.equal(renamed.context_frozen_at,created.context_frozen_at);
}));

test('side-chat parent, adoption and stale child references require the real session owner',()=>fixture(async(user,root)=>{
  const service=createSideChatsService(fakeFork(root));
  assert.throws(()=>service.list(user+1,'parent'),error=>error instanceof Error && 'statusCode' in error && error.statusCode===403);
  await assert.rejects(service.create(user+1,input),error=>error instanceof Error && 'statusCode' in error && error.statusCode===403);
  const child=await service.create(user,input);
  assert.throws(()=>service.adopt(user+1,'parent',child.child_session_id),error=>error instanceof Error && 'statusCode' in error && error.statusCode===403);
  const legacy=sideChatsDb.reserve(user+1,'parent','legacy-foreign','foreign');
  await assert.rejects(service.update(user+1,legacy.id,{title:'stolen'}),error=>error instanceof Error && 'statusCode' in error && error.statusCode===403);
}));
