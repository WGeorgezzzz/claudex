import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeConnection, getConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { withUserContext } from '@/modules/auth/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { createTaskIntelligenceService } from '../taskmaster-intelligence.service.js';
import { taskmasterInboxService } from '../taskmaster-inbox.service.js';

test('cached task snapshots reset daily spend at midnight without changing the budget',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'idle-day-cache-')),oldDb=process.env.DATABASE_PATH,oldHome=process.env.CLOUDCLI_HOME;
 closeConnection();process.env.DATABASE_PATH=path.join(root,'test.db');process.env.CLOUDCLI_HOME=path.join(root,'home');await initializeDatabase();
 const user=Number(userDb.createUser('cache-day','hash').id);
 t.mock.timers.enable({apis:['Date'],now:new Date(2026,9,30,23,59).getTime()});
 t.mock.method(taskmasterInboxService,'global',async()=>({projects:[],infohub:{}}));
 try{
  const dir=path.join(process.env.CLOUDCLI_HOME!,'task-intelligence');await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'user-'+user+'.json'),JSON.stringify({day:new Date().toLocaleDateString('en-CA'),spent:3,budget:100,enabled:false}));
  const service=createTaskIntelligenceService(async()=>{throw Error('No model call expected');});
  await withUserContext(user,async()=>{assert.equal((await service.snapshot()).spent,3);t.mock.timers.tick(120000);const next=await service.snapshot();assert.equal(next.spent,0);assert.equal(next.budget,100);});
 }finally{t.mock.restoreAll();t.mock.timers.reset();closeConnection();if(oldDb===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=oldDb;if(oldHome===undefined)delete process.env.CLOUDCLI_HOME;else process.env.CLOUDCLI_HOME=oldHome;}
});

test('a fresh action discovers a resumed CLI despite an earlier cached empty status read',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'idle-action-cache-')),oldDb=process.env.DATABASE_PATH,oldHome=process.env.CLOUDCLI_HOME;
 closeConnection();process.env.DATABASE_PATH=path.join(root,'test.db');process.env.CLOUDCLI_HOME=root;await initializeDatabase();const user=Number(userDb.createUser('cache-action','hash').id);
 t.mock.timers.enable({apis:['Date'],now:Date.now()});let resumed=false;
 t.mock.method(childProcess,'execFile',(...args:unknown[])=>{const done=args.at(-1) as (error:Error|null,out:string,err:string)=>void;queueMicrotask(()=>done(null,process.platform==='win32'?JSON.stringify(resumed?[{pid:2000000000,ppid:0,name:'codex.exe',command:'codex.exe resume cache-native-1',startedAt:Date.now()}]:[]):resumed?'2000000000 0 codex codex resume cache-native-1':'',''));return {} as ReturnType<typeof childProcess.execFile>;});syncBuiltinESMExports();
 try{await withUserContext(user,async()=>{sessionsDb.createAppSession('cache-action-app','codex',root,'cache');getConnection().prepare('UPDATE sessions SET provider_session_id=? WHERE session_id=?').run('cache-native-1','cache-action-app');assert.equal((await sessionsService.listRunningSessions(false)).length,0);resumed=true;t.mock.timers.tick(3500);assert((await sessionsService.listRunningSessions()).some(row=>row.sessionId==='cache-action-app'));});}
 finally{t.mock.restoreAll();syncBuiltinESMExports();t.mock.timers.reset();closeConnection();if(oldDb===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=oldDb;if(oldHome===undefined)delete process.env.CLOUDCLI_HOME;else process.env.CLOUDCLI_HOME=oldHome;}
});
