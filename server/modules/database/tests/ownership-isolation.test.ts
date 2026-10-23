import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

// Set every filesystem root before importing the application: no real account artifacts are touched.
const fixture = await mkdtemp(path.join(os.tmpdir(), 'claudex-ownership-'));
process.env.DATABASE_PATH = path.join(fixture, 'auth.db');
await writeFile(process.env.DATABASE_PATH, '');
process.env.CLAUDE_CONFIG_DIR = path.join(fixture, 'admin-claude');
process.env.CODEX_HOME = path.join(fixture, 'admin-codex');
process.env.CLAUDEX_USER_CONFIG_ROOT = path.join(fixture, 'users');
process.env.HOME = fixture;
process.env.USERPROFILE = fixture;
const { initializeDatabase, getConnection, closeConnection, projectsDb, sessionsDb, sessionBridgeDb, scanStateDb, getSessionOwnerId } = await import('@/modules/database/index.js');
const { withUserContext, getUserContext } = await import('@/modules/auth/index.js');
const { initializeOwnership } = await import('../ownership.js');
const { connectedClients, clientUserIds, broadcastSessionUpsertedBatch } = await import('@/modules/websocket/index.js');
const { sessionSynchronizerService } = await import('@/modules/providers/index.js');
const { createSessionHistoryCache } = await import('@/modules/providers/services/session-history-cache.service.js');
const { getProjectsWithSessions } = await import('@/modules/projects/index.js');
const { handleChatConnection } = await import('@/modules/websocket/services/chat-websocket.service.js');
const { EventEmitter } = await import('node:events');

class Connection extends EventEmitter {
  readyState = 1;
  frames: Array<Record<string, any>> = [];
  send(payload: string) { this.frames.push(JSON.parse(payload)); }
  close() { this.emit('close'); }
}

test('real SQLite, HTTP, provider scans, private caches and websocket transport enforce owner isolation', async () => {
  await initializeDatabase();
  const db = getConnection();
  const rootA = path.join(fixture, 'work-a');
  const rootB = path.join(fixture, 'work-b');
  await mkdir(rootA, {recursive:true}); await mkdir(rootB, {recursive:true});
  db.prepare("INSERT INTO users(id,username,password_hash,role,work_root,allowed_folders) VALUES(1,'admin','test','admin',NULL,'[]'),(2,'alice','test','member',?,'[]'),(3,'bob','test','member',?,'[]')").run(rootA, rootB);
  try {
    // Simulate legacy rows and rerun the additive migration twice.
    projectsDb.createProjectPath(path.join(fixture, 'legacy'));
    sessionsDb.createAppSession('legacy-session', 'claude', path.join(fixture, 'legacy'), 'legacy');
    db.exec('UPDATE projects SET owner_id=NULL; UPDATE sessions SET owner_id=NULL');
    initializeOwnership(db); initializeOwnership(db);
    assert.equal(getSessionOwnerId('legacy-session'), 1);
    const projectA = withUserContext(2, () => projectsDb.createProjectPath(rootA).project!);
    withUserContext(2, () => sessionsDb.createAppSession('alice-session', 'claude', rootA, 'alpha-7'));
    withUserContext(3, () => sessionsDb.createAppSession('bob-session', 'codex', rootB, 'beta-3'));
    assert.equal(getSessionOwnerId('alice-session'), 2);
    assert.equal(getSessionOwnerId('bob-session'), 3);
    withUserContext(3, () => {
      assert.equal(sessionsDb.getSessionById('alice-session'), null);
      assert.equal(projectsDb.getProjectById(projectA.project_id), null);
      assert.equal(sessionsDb.getRecentSessionsPage(20,0).total, 1);
      assert.deepEqual(sessionsDb.getAllSessions().map(row => row.session_id), ['bob-session']);
      assert.equal(sessionBridgeDb.search('alpha',20,0).total, 0);
      sessionsDb.updateSessionCustomName('alice-session','stolen');
      assert.equal(sessionsDb.deleteSessionById('alice-session'), false);
      assert.throws(() => sessionsDb.createAppSession('alice-session','codex',rootB,'collision'), /belongs to another user/);
      assert.throws(() => projectsDb.createProjectPath(rootA), /outside/);
    });
    assert.equal(withUserContext(2, () => sessionsDb.getSessionById('alice-session')?.custom_name),'alpha-7');
    assert.deepEqual(withUserContext(1, () => sessionsDb.getAllSessions().map(row => row.session_id)),['legacy-session']);
    const oldScan = new Date('2020-01-01T00:00:00Z');
    withUserContext(1, () => scanStateDb.updateLastScannedAt(oldScan));
    assert.equal(db.prepare('SELECT last_scanned_at FROM scan_state WHERE id=1').get() !== undefined,true);
    assert.equal(withUserContext(2, () => scanStateDb.getLastScannedAt()),null);
    withUserContext(2, () => scanStateDb.updateLastScannedAt(oldScan));
    assert.equal(withUserContext(3, () => scanStateDb.getLastScannedAt()),null);

    // Actual provider indexers consume separate Claude/Codex roots and assign each discovered artifact.
    for (const [id,root] of [[2,rootA],[3,rootB]] as const) {
      const context = getUserContext(id);
      const claudeDir = path.join(context.claudeConfigDir,'projects','project');
      const codexDir = path.join(context.codexHome,'sessions','2026','10','23');
      await mkdir(claudeDir,{recursive:true}); await mkdir(codexDir,{recursive:true});
      await writeFile(path.join(claudeDir,'disk-claude-'+id+'.jsonl'),JSON.stringify({type:'user',sessionId:'disk-claude-'+id,cwd:root,message:{role:'user',content:'private-'+id}})+'\n');
      await writeFile(path.join(codexDir,'disk-codex-'+id+'.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'disk-codex-'+id,cwd:root,source:'cli'}})+'\n');
    }
    const scan = await sessionSynchronizerService.synchronizeSessions();
    assert.deepEqual(scan.failures,[]);
    for (const id of [2,3]) for (const provider of ['claude','codex']) assert.equal(getSessionOwnerId('disk-'+provider+'-'+id),id);

    const a=new Connection(), b=new Connection(), admin=new Connection(), unknown=new Connection();
    for (const [client,id] of [[a,2],[b,3],[admin,1]] as const) { connectedClients.add(client); clientUserIds.set(client,id); }
    connectedClients.add(unknown);
    await broadcastSessionUpsertedBatch(['alice-session','bob-session','disk-claude-2']);
    assert.deepEqual(a.frames.map(frame=>frame.sessionId),['alice-session','disk-claude-2']);
    assert.deepEqual(b.frames.map(frame=>frame.sessionId),['bob-session']);
    assert.equal(admin.frames.length,0); assert.equal(unknown.frames.length,0);
    a.frames=[]; b.frames=[];
    await withUserContext(2,()=>getProjectsWithSessions({skipSynchronization:true}));
    assert.ok(a.frames.every(frame=>frame.kind==='loading_progress'));
    assert.equal(b.frames.length,0);

    // Identical session/cache identifiers must not coalesce concurrent accounts.
    const cache = createSessionHistoryCache();
    const cachePath = path.join(fixture,'cache.jsonl'); await writeFile(cachePath,'data');
    const load = (marker: string) => async () => ({messages:[{kind:'text',text:marker}],total:1,hasMore:false} as any);
    const [ca,cb] = await Promise.all([withUserContext(2,()=>cache.getFullHistory({sessionId:'same',transcriptPath:cachePath,loadFull:load('alpha')})),withUserContext(3,()=>cache.getFullHistory({sessionId:'same',transcriptPath:cachePath,loadFull:load('beta')}))]);
    assert.equal((ca?.messages[0] as any).text,'alpha'); assert.equal((cb?.messages[0] as any).text,'beta');

    const { default: projectsRouter } = await import('@/modules/projects/projects.routes.js');
    const { default: providerRouter } = await import('@/modules/providers/provider.routes.js');
    const app = express(); app.use(express.json());
    app.use((req,_res,next)=>{ (req as any).user={id:Number(req.headers['x-test-user'])}; next(); });
    app.use('/projects',projectsRouter); app.use('/providers',providerRouter);
    app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.statusCode||500).json({error:error.message}));
    const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
    const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
    try {
      const call=(url:string,method='GET',body?:unknown)=>fetch(base+url,{method,headers:{'x-test-user':'3','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
      const listed = await call('/projects?skipSync=1'); assert.equal(listed.status,200);
      assert.equal(JSON.stringify(await listed.json()).includes(rootA.replaceAll('\\','\\\\')),false);
      for(const suffix of ['', '/messages','/provider-id','/token-usage']) assert.equal((await call('/providers/sessions/alice-session'+suffix)).status,403);
      assert.equal((await call('/providers/sessions/alice-session','PUT',{summary:'stolen'})).status,403);
      assert.equal((await call('/providers/sessions/alice-session','DELETE')).status,403);
      assert.equal((await call('/projects/create-project','POST',{path:rootA})).status,403);
      const own=await call('/providers/sessions/bob-session'); assert.equal(own.status,200);
    } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }

    // A real message event on an authenticated websocket cannot replay or abort another user's run.
    const socket=new Connection(); let aborts=0;
    const runtime:any={abort:async()=>{aborts++;return true;},hasBackgroundWork:()=>false,getPendingApprovalsForSession:()=>[],resolveToolApproval:()=>{throw new Error('unexpected approval');}};
    handleChatConnection(socket as any,{user:{userId:3}} as any,{runtime});
    socket.emit('message',Buffer.from(JSON.stringify({type:'chat.subscribe',sessions:[{sessionId:'alice-session'}]})));
    socket.emit('message',Buffer.from(JSON.stringify({type:'chat.abort',sessionId:'alice-session'})));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(aborts,0); assert.equal(socket.frames.filter(frame=>frame.kind==='protocol_error').length,2);
    socket.close();
  } finally { connectedClients.clear(); closeConnection(); await rm(fixture,{recursive:true,force:true}); }
});
