import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { withUserContext } from '@/modules/auth/index.js';
import { closeConnection, getConnection, initializeDatabase, messageQueueDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { sessionBridgeService } from '@/modules/session-bridge/session-bridge.service.js';
import { executeSessionBridgeTool } from '@/modules/session-bridge/session-bridge.tools.js';

test('cross-session tools bind source identity, preserve queue semantics and reject autonomous forwarding', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'claudex-bridge-'));const old=process.env.DATABASE_PATH,oldProtected=process.env.CLOUDCLI_PROTECTED_SESSIONS_FILE;
  closeConnection();process.env.DATABASE_PATH=path.join(root,'test.db');delete process.env.CLOUDCLI_PROTECTED_SESSIONS_FILE;await initializeDatabase();
  try {
    const user=Number(userDb.createUser('bridge','hash').id);withUserContext(user, () => { for(const id of ['source','target','foreign'])sessionsDb.createAppSession(id,'claude',root,id+' title'); });
    assert.ok(sessionBridgeService.list('target', 0, user).sessions.some(row=>row.sessionId==='target'));
    assert.deepEqual((await sessionBridgeService.read('target', 0, user)).messages,[]);
    const args={sessionId:'target',content:'Read the existing state',requestId:'send-1'};
    const receipt=sessionBridgeService.send(user,'source',args);assert.equal(receipt.status,'queued');
    assert.equal(sessionBridgeService.send(user,'source',args).id,receipt.id);
    assert.throws(()=>sessionBridgeService.send(user,'source',{...args,content:'different'}),/different/);
    const options=JSON.parse(messageQueueDb.get(user,receipt.id)!.options);assert.equal(options.permissionMode,'default');assert.equal(options.cloudcliBridgeSourceSessionId,'source');
    assert.throws(()=>sessionBridgeService.status(user+1,'source',receipt.id));assert.throws(()=>sessionBridgeService.status(user,'foreign',receipt.id));
    await assert.rejects(()=>executeSessionBridgeTool({userId:user,sessionId:'source',autonomous:true,planMode:false},{...args,action:'send'}),/cannot dispatch/);
    await assert.rejects(()=>executeSessionBridgeTool({userId:user,sessionId:'source',autonomous:false,planMode:true},{...args,action:'send'}),/cannot dispatch/);
    assert.throws(()=>sessionBridgeService.send(user,'source',{...args,sessionId:'source'}),/another/);
    const protection=path.join(root,'protected.json');await writeFile(protection,JSON.stringify({sessionIds:['target']}));process.env.CLOUDCLI_PROTECTED_SESSIONS_FILE=protection;
    assert.equal(sessionBridgeService.list('target', 0, user).sessions[0].canSend,false);assert.throws(()=>sessionBridgeService.send(user,'source',{...args,requestId:'send-2'}),/owned/);
    assert.equal(messageQueueDb.list(user,'target').length,1);
  } finally {closeConnection();if(old===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=old;if(oldProtected===undefined)delete process.env.CLOUDCLI_PROTECTED_SESSIONS_FILE;else process.env.CLOUDCLI_PROTECTED_SESSIONS_FILE=oldProtected;assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(root,{recursive:true,force:true});}
});

test('session parity actions create codex, hand off, wait, compact, and manage metadata', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'claudex-parity-')); const old=process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH=path.join(root,'test.db'); delete process.env.CLOUDCLI_PROTECTED_SESSIONS_FILE; await initializeDatabase();
  try {
    const user=Number(userDb.createUser('parity','hash').id);
    withUserContext(user, () => { sessionsDb.createAppSession('source','claude',root,'Source'); });
    const created=sessionBridgeService.create(user,'source',{provider:'codex',cwd:root,title:'Codex target',prompt:'hello codex',requestId:'create-codex'});
    assert.equal(sessionBridgeService.create(user,'source',{provider:'codex',cwd:root,title:'Codex target',prompt:'hello codex',requestId:'create-codex'}).sessionId,created.sessionId);
    assert.throws(()=>sessionBridgeService.create(user,'source',{prompt:'different',requestId:'create-codex'}),/different/);
    assert.equal(withUserContext(user,()=>sessionsDb.getSessionById(created.sessionId))?.title_source,'user'); assert.equal(created.provider,'codex'); assert.equal(created.providerSessionId,null); assert.equal(created.receipt.status,'queued');
    assert.equal(JSON.parse(messageQueueDb.get(user,created.receipt.id)!.options).cloudcliBridgeSourceSessionId,'source');
    const other=Number(userDb.createUser('parity-other','hash').id);
    getConnection().prepare('UPDATE users SET allowed_folders=? WHERE id=?').run(JSON.stringify([root]),other);
    withUserContext(other,()=>sessionsDb.createAppSession('foreign-owner','claude',path.join(root,'member-project'),'Foreign'));
    assert.throws(()=>sessionBridgeService.create(user,'foreign-owner',{prompt:'forbidden',requestId:'foreign-create'}));
    await assert.rejects(()=>sessionBridgeService.fork(user,'foreign-owner',{requestId:'foreign-fork'}));
    assert.throws(()=>sessionBridgeService.rename(user,'foreign-owner','Forbidden'));
    assert.throws(()=>sessionBridgeService.archive(user,'foreign-owner',true));
    await assert.rejects(()=>sessionBridgeService.wait(user,{sessionIds:['foreign-owner'],timeoutSec:0}));
    assert.throws(()=>sessionBridgeService.send(user,'source',{sessionId:'foreign-owner',content:'forbidden',requestId:'foreign-send'}));
    assert.throws(()=>sessionBridgeService.create(user,'source',{cwd:path.dirname(root),prompt:'escape',requestId:'outside-project'}),/accessible project/);
    const renamed=sessionBridgeService.rename(user,created.sessionId,'Renamed target'); assert.equal(renamed.title,'Renamed target');
    assert.equal(sessionBridgeService.archive(user,created.sessionId,true).archived,true);
    assert.equal(sessionBridgeService.archive(user,created.sessionId,false).archived,false);
    const waited=await sessionBridgeService.wait(user,{receiptIds:[created.receipt.id],timeoutSec:0});
    assert.equal(waited.receipts[0]?.id,created.receipt.id); assert.equal(waited.timedOut,true);
    const handoff=await sessionBridgeService.fork(user,'source',{mode:'handoff',requestId:'handoff-1'});
    assert.equal(handoff.provider,'claude'); assert.ok('receipt' in handoff); if ('receipt' in handoff) assert.ok(handoff.receipt.id);
    const compact=sessionBridgeService.compact(user,'source',{requestId:'compact-1',instruction:'retain decisions'});
    assert.equal(compact.status,'queued');
    assert.equal(messageQueueDb.get(user,compact.id)!.content,'/compact retain decisions');
    await assert.rejects(() => executeSessionBridgeTool({userId:user,sessionId:'source',autonomous:true,planMode:false},{action:'create',prompt:'blocked',requestId:'blocked-1'}),/cannot.*dispatch/);
  } finally { closeConnection(); if(old===undefined)delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH=old; await rm(root,{recursive:true,force:true}); }
});

