import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, monitorsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { monitorsService } from '@/modules/monitors/monitors.service.js';
import { normalizeProbe, parseProbeFields, runProbe } from '@/modules/monitors/monitor-probe.service.js';

async function fixture(check:(user:number,root:string)=>Promise<void>|void) {
  const root=await mkdtemp(path.join(os.tmpdir(),'monitor-probe-')); const previous=process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH=path.join(root,'test.db'); await initializeDatabase();
  try { const user=Number(userDb.createUser('probe-test','hash').id); sessionsDb.createAppSession('probe-session','claude',root,'Probe'); await check(user,root); }
  finally { closeConnection(); if(previous===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previous; await rm(root,{recursive:true,force:true}); }
}

test('normalizes all probe item settings and parses progress/status fields',()=>{
  assert.deepEqual(parseProbeFields('4418/16000 status: running',{ }),{progress:{current:4418,total:16000},status:'running'});
  assert.equal(normalizeProbe({items:[{type:'file',path:'STATUS.md'}],intervalMinutes:0})?.intervalMinutes,3);
  assert.deepEqual(normalizeProbe({items:[{file:'STATUS.md'}]})?.items[0],{file:'STATUS.md',type:'file',path:'STATUS.md'});
  assert.equal(normalizeProbe({items:[]}),null);
});

test('file probes read only appended bytes and emit error then done events',async()=>fixture(async(user,root)=>{
  const log=path.join(root,'codex-run.log'); const done=path.join(root,'DONE.json'); await writeFile(log,'1/4\n'); await writeFile(done,JSON.stringify({done:false}));
  const row=monitorsService.create(user,{sessionId:'probe-session',name:'Probe',content:'read logs',intervalMinutes:1,probe:{intervalMinutes:1,items:[{type:'file',path:log,read:'tail'},{type:'patterns',patterns:['ERROR']}]}});
  const t0=new Date('2026-10-29T10:00:00.000Z'); assert.equal(await runProbe(row,t0),null);
  await writeFile(log,'1/4\nERROR failed\n'); const error=await runProbe(monitorsDb.get(user,row.id)!,new Date(t0.getTime()+60_000)); assert.equal(error?.type,'error'); assert.match(error?.delta||'',/ERROR failed/);
  const doneRow=monitorsService.create(user,{sessionId:'probe-session',name:'Done',content:'read done',intervalMinutes:1,probe:{intervalMinutes:1,items:[{type:'file',path:done,read:'json',field:'done',doneField:'done'}]}});
  await writeFile(done,JSON.stringify({done:true})); assert.equal((await runProbe(doneRow,new Date(t0.getTime()+60_000)))?.type,'done'); assert.equal(await runProbe(monitorsDb.get(user,doneRow.id)!,new Date(t0.getTime()+120_000)),null);
}));

test('command, process, threshold, stall, dead and heartbeat rules produce one event each',async()=>fixture(async(user,root)=>{
  const commandRow=monitorsService.create(user,{sessionId:'probe-session',name:'Command',content:'command',intervalMinutes:1,probe:{intervalMinutes:1,items:[{type:'command',command:'echo 3/4 status=running'},{type:'threshold',field:'progress.current',above:2}]}});
  const t0=new Date('2026-10-29T10:00:00.000Z'); assert.equal((await runProbe(commandRow,t0))?.type,'threshold');
  const processRow=monitorsService.create(user,{sessionId:'probe-session',name:'Process',content:'process',intervalMinutes:1,probe:{intervalMinutes:1,items:[{type:'process',pid:2147483647}]}});
  assert.equal((await runProbe(processRow,t0))?.type,'dead');
  const stallRow=monitorsService.create(user,{sessionId:'probe-session',name:'Stall',content:'stall',intervalMinutes:1,probe:{intervalMinutes:1,stallMinutes:1,items:[{type:'command',command:'echo 1/4'}]}});
  assert.equal(await runProbe(stallRow,t0),null); assert.equal((await runProbe(monitorsDb.get(user,stallRow.id)!,new Date(t0.getTime()+61_000)))?.type,'stall');
  const heartbeatRow=monitorsService.create(user,{sessionId:'probe-session',name:'Heartbeat',content:'heartbeat',intervalMinutes:1,probe:{intervalMinutes:1,heartbeatMinutes:1,items:[{type:'patterns',patterns:['NEVER']}]}});
  assert.equal(await runProbe(heartbeatRow,t0),null); assert.equal((await runProbe(monitorsDb.get(user,heartbeatRow.id)!,new Date(t0.getTime()+61_000)))?.type,'heartbeat');
}));
