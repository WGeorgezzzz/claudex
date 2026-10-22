import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, messageQueueDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { sessionBridgeService } from '@/modules/session-bridge/session-bridge.service.js';
import { executeSessionBridgeTool } from '@/modules/session-bridge/session-bridge.tools.js';

test('cross-session tools bind source identity, preserve queue semantics and reject autonomous forwarding', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'claudex-bridge-'));const old=process.env.DATABASE_PATH,oldProtected=process.env.CLOUDCLI_PROTECTED_SESSIONS_FILE;
  closeConnection();process.env.DATABASE_PATH=path.join(root,'test.db');delete process.env.CLOUDCLI_PROTECTED_SESSIONS_FILE;await initializeDatabase();
  try {
    const user=Number(userDb.createUser('bridge','hash').id);for(const id of ['source','target','foreign'])sessionsDb.createAppSession(id,'claude',root,id+' title');
    assert.ok(sessionBridgeService.list('target').sessions.some(row=>row.sessionId==='target'));
    assert.deepEqual((await sessionBridgeService.read('target')).messages,[]);
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
    assert.equal(sessionBridgeService.list('target').sessions[0].canSend,false);assert.throws(()=>sessionBridgeService.send(user,'source',{...args,requestId:'send-2'}),/owned/);
    assert.equal(messageQueueDb.list(user,'target').length,1);
  } finally {closeConnection();if(old===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=old;if(oldProtected===undefined)delete process.env.CLOUDCLI_PROTECTED_SESSIONS_FILE;else process.env.CLOUDCLI_PROTECTED_SESSIONS_FILE=oldProtected;assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(root,{recursive:true,force:true});}
});
