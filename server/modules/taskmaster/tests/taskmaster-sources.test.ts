import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp,writeFile,mkdir,readFile } from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { installAuthorizationFixture,testUserId } from '@/test-support/authorization-fixture.js';
import { withUserContext } from '@/modules/auth/index.js';
import { userDb,getConnection } from '@/modules/database/index.js';
import {getCloudCliHomeDir} from '@/shared/index.js';

import { createTaskmasterNativeRouter } from '../taskmaster-native.routes.js';
import { infohubLifecycle } from '../taskmaster-infohub.service.js';
import { taskmasterWorkspace } from '../taskmaster-auto.service.js';
import { taskIntelligenceService } from '../taskmaster-intelligence.service.js';
import {retrieveTaskEvidence} from '../taskmaster-evidence.service.js';

installAuthorizationFixture();
test('sources report actual connector errors; explicit HTTP collection imports visible intelligence rows without model calls',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'task-sources-'));const reports=path.join(root,'reports');await mkdir(reports);await mkdir(path.join(reports,'run'));await writeFile(path.join(reports,'run','DONE.json'),'{"done":true}');
  const environment={INFOHUB_BASE_URL:process.env.INFOHUB_BASE_URL,TASKMASTER_INBOX_ROOT:process.env.TASKMASTER_INBOX_ROOT,TASKMASTER_REPORTS_ROOT:process.env.TASKMASTER_REPORTS_ROOT,CLAUDEX_PASSIVE_INSTANCE:process.env.CLAUDEX_PASSIVE_INSTANCE};
  process.env.TASKMASTER_INBOX_ROOT=path.join(root,'inbox');process.env.TASKMASTER_REPORTS_ROOT=reports;process.env.CLAUDEX_PASSIVE_INSTANCE='1';
  let polls=0;const unit={id:9876,kind:'todo',status:'open',title:'来源回放测试',for_me:1,updated_at:Math.floor(Date.now()/1000),tags:[],parents:[],messages:[{id:1,source:'lark',link:'https://example.test/original',text:'测试待办'}]};
  const hub=createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/api/poll')polls++;
    res.end(JSON.stringify(req.url?.startsWith('/api/status')?{latest:[{layer:'sync',source:'lark:org1',status:'error',error:'token_missing need_user_authorization',finished_at:100},{layer:'sync',source:'wechat',status:'error',error:'WeChat is not running',finished_at:100}],totals:{sources:{'lark:org1':7}}}:req.url?.startsWith('/api/units')?[unit]:req.url==='/api/tags'?[]:req.url?.startsWith('/api/unit/')?unit:{ok:true}));});
  hub.listen(0,'127.0.0.1');await once(hub,'listening');process.env.INFOHUB_BASE_URL='http://127.0.0.1:'+(hub.address() as AddressInfo).port;
  let actor=testUserId();const member=Number(userDb.createUser('sources-member','unused').id);
  const app=express().use(express.json()).use((req,_res,next)=>{(req as typeof req&{user:{id:number}}).user={id:actor};next();}).use(createTaskmasterNativeRouter());
  const api=app.listen(0,'127.0.0.1');await once(api,'listening');const base='http://127.0.0.1:'+(api.address() as AddressInfo).port;
  const request=(url:string,method='GET',body?:unknown)=>fetch(base+url,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  try{
    actor=member;assert.equal((await request('/inbox/sources')).status,403);assert.equal((await request('/inbox/sources/infohub/start','POST')).status,403);actor=testUserId();
    assert.equal((await request('/inbox/sources/infohub/settings','PUT',{idleMinutes:0})).status,400);
    assert.equal((await request('/inbox/sources/infohub/settings','PUT',{idleMinutes:3})).status,200);
    assert.deepEqual(await (await request('/inbox/sources/infohub/settings')).json(),{idleMinutes:3});
    const snapshot=await (await request('/inbox/sources')).json() as {sources:{id:string;status:string;action?:string;count:number}[]};
    assert.equal(polls,0);assert.equal(snapshot.sources.find(s=>s.id==='reports')?.count,1);assert.equal(snapshot.sources.find(s=>s.id==='lark')?.action,'authorize');assert.equal(snapshot.sources.find(s=>s.id==='wechat')?.action,'open-wechat');
    assert.equal((await request('/inbox/sources/infohub/start','POST')).status,200);await infohubLifecycle.settled();assert.equal(polls,1);
    await (await request('/inbox/sources/infohub/start','POST')).json();await infohubLifecycle.settled();
    await withUserContext(testUserId(),async()=>{
      const tasks=(await taskmasterWorkspace.list(process.env.TASKMASTER_INBOX_ROOT!,testUserId())).tasks;assert.equal(tasks.length,1);assert.equal(tasks[0].sourceId,'9876');
      const intelligence=await taskIntelligenceService.snapshot();const row=intelligence.tasks.find(row=>row.task.sourceId==='9876');assert.ok(row?.analysis);assert.equal(row.task.evidenceLink,'/infohub?unit=9876');assert.ok(intelligence.groups.some(g=>g.memberIds.includes(row.id)));
      assert.equal(row.analysis.next_action,'查看原消息并处理');assert.equal(intelligence.groups.find(g=>g.memberIds.includes(row.id))?.name,'信息看板');
      const db=getConnection(),at=new Date().toISOString();
      db.prepare('INSERT INTO monitors(id,user_id,session_id,name,content,options,interval_minutes,next_run_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run('sources-monitor',testUserId(),'source-monitor-session','来源回放测试','测试监测','{}',60,at,at);
      db.prepare('INSERT INTO monitor_runs(id,monitor_id,started_at,finished_at,status,report) VALUES (?,?,?,?,?,?)').run('sources-monitor-run','sources-monitor',at,at,'succeeded','来源回放测试已完成，保留真实监测报告证据。');
      const evidence=await retrieveTaskEvidence([{id:'monitor-proof',title:'来源回放测试',project:'来源回放测试',root,sessionIds:[]}]);
      assert.ok(evidence.some(e=>e.type==='monitor'&&e.path==='/session/source-monitor-session'&&e.excerpt.includes('真实监测报告证据')));
    });
    const metadata='infohub-'+testUserId()+'-'+createHash('sha256').update(new URL(process.env.INFOHUB_BASE_URL!).href).digest('hex').slice(0,12)+'.json';
    const persisted=JSON.parse(await readFile(path.join(getCloudCliHomeDir(),'taskmaster',metadata),'utf8')) as {lastSyncedAt:string};assert.ok(persisted.lastSyncedAt);
    const freshScript=path.join(root,'fresh.mts'),freshResult=path.join(root,'fresh-result.json');
    await writeFile(freshScript,`import {infohubSyncStatus} from ${JSON.stringify(pathToFileURL(path.resolve('server/modules/taskmaster/taskmaster-infohub.service.ts')).href)};import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(freshResult)},JSON.stringify(infohubSyncStatus(${testUserId()})));`);
    const freshEnv={...process.env};delete freshEnv.NODE_TEST_CONTEXT;
    const fresh=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','--tsconfig','server/tsconfig.json',freshScript],{env:freshEnv,encoding:'utf8',windowsHide:true});
    assert.equal(fresh.status,0,fresh.stderr);assert.equal(JSON.parse(await readFile(freshResult,'utf8')).lastSyncedAt,persisted.lastSyncedAt,'A fresh backend process must restore the last successful synchronization');
    await new Promise<void>(resolve=>hub.close(()=>resolve()));
    const offline=await (await request('/inbox/sources')).json() as {sources:{id:string;count:number;lastSyncedAt:string|null;note?:string}[]};
    assert.equal(offline.sources.find(s=>s.id==='lark')?.count,7);assert.match(offline.sources.find(s=>s.id==='lark')?.note||'',/上次观测/);assert.ok(offline.sources.find(s=>s.id==='infohub')?.lastSyncedAt);
  }finally{await infohubLifecycle.stop();await new Promise<void>(resolve=>api.close(()=>resolve()));await new Promise<void>(resolve=>hub.close(()=>resolve()));for(const [key,value]of Object.entries(environment)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
