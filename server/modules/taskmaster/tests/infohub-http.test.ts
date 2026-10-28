import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { installAuthorizationFixture,testUserId } from '@/test-support/authorization-fixture.js';
import { withUserContext } from '@/modules/auth/index.js';
import { syncInfohubTasks } from '../taskmaster-infohub.service.js';
import { taskmasterWorkspace } from '../taskmaster-auto.service.js';
installAuthorizationFixture();
test('HTTP polling deduplicates source IDs, survives upstream shutdown and keeps existing tasks',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'infohub-http-'));process.env.TASKMASTER_INBOX_ROOT=root;
 const unit={id:941,kind:'todo',status:'open',title:'HTTP integration fixture',for_me:1,updated_at:Math.floor(Date.now()/1000),tags:['project:fixture'],parents:[],messages:[]};
 const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url?.startsWith('/api/units')?[unit]:req.url?.startsWith('/api/tags')?[]:unit));});server.listen(0,'127.0.0.1');await once(server,'listening');process.env.INFOHUB_BASE_URL='http://127.0.0.1:'+(server.address() as AddressInfo).port;
 try{const online=await syncInfohubTasks(testUserId());assert.equal(online.online,true);await syncInfohubTasks(testUserId());await withUserContext(testUserId(),async()=>assert.equal((await taskmasterWorkspace.list(root,testUserId())).tasks.length,1));await new Promise<void>(resolve=>server.close(()=>resolve()));const offline=await syncInfohubTasks(testUserId());assert.equal(offline.online,false);assert.equal(offline.lastSyncedAt!==null,true);await withUserContext(testUserId(),async()=>assert.equal((await taskmasterWorkspace.list(root,testUserId())).tasks.length,1));}finally{server.close();delete process.env.INFOHUB_BASE_URL;delete process.env.TASKMASTER_INBOX_ROOT;}
});
