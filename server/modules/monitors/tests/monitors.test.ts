import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { closeConnection, getConnection, initializeDatabase, monitorsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { monitorsService } from '@/modules/monitors/monitors.service.js';
import { dispatchMonitors } from '@/modules/monitors/monitors.dispatcher.js';
import { executeMonitorTool } from '@/modules/monitors/monitors.tools.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { createCompleteMessage } from '@/shared/utils.js';

async function fixture(check:(userId:number)=>Promise<void>|void) {
  const previous=process.env.DATABASE_PATH;
  const dir=await mkdtemp(path.join(tmpdir(),'cloudcli-monitors-'));
  closeConnection();process.env.DATABASE_PATH=path.join(dir,'test.db');await initializeDatabase();
  try {const user=userDb.createUser('monitor-test','hash');sessionsDb.createAppSession('monitor-session','claude',dir,'Monitor test');await check(Number(user.id));}
  finally {chatRunRegistry.clearAll();closeConnection();if(previous===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previous;await rm(dir,{recursive:true,force:true});}
}
const create=(userId:number)=>monitorsService.create(userId,{sessionId:'monitor-session',name:'test',content:'Read status only',intervalMinutes:1,options:{permissionMode:'default'}});

test('forwarded and planning turns cannot create or change schedules',()=>fixture(user=>{
  const context={userId:user,sessionId:'monitor-session',readOnly:true};
  const row=create(user);
  assert.ok(executeMonitorTool(context,{action:'list'}));
  assert.throws(()=>executeMonitorTool(context,{action:'create',name:'Unsolicited',content:'check',intervalMinutes:5}),/只能查看/);
  for(const action of ['update','pause','resume','stop','run_now'])assert.throws(()=>executeMonitorTool(context,{action,id:row.id}),/只能查看/);
  assert.equal(monitorsDb.get(user,row.id)?.status,'active');
}));

test('chat tool creates an idempotent persistent task and lists its real status',()=>fixture(user=>{
  const context={userId:user,sessionId:'monitor-session'};
  const args={action:'create',name:'进度检查',content:'只读查看任务进度，有变化才汇报。',intervalMinutes:30};
  executeMonitorTool(context,args);executeMonitorTool(context,args);
  const rows=monitorsDb.list(user,'monitor-session');assert.equal(rows.length,1);assert.equal(rows[0].interval_minutes,30);
  assert.equal(JSON.parse(rows[0].options).permissionMode,'default');
  assert.ok(JSON.stringify(executeMonitorTool(context,{action:'list'})).includes(rows[0].id));
}));
test('chat tool updates frequency and manages pause/resume/stop with retained history',()=>fixture(user=>{
  const context={userId:user,sessionId:'monitor-session'};const row=create(user);
  executeMonitorTool(context,{action:'update',id:row.id,name:'新名称',intervalMinutes:60});
  assert.equal(monitorsDb.get(user,row.id)?.interval_minutes,60);
  executeMonitorTool(context,{action:'pause',id:row.id});assert.equal(monitorsDb.get(user,row.id)?.status,'paused');
  executeMonitorTool(context,{action:'resume',id:row.id});assert.equal(monitorsDb.get(user,row.id)?.status,'active');
  executeMonitorTool(context,{action:'stop',id:row.id});assert.equal(monitorsDb.get(user,row.id)?.status,'stopped');
  assert.ok(JSON.stringify(executeMonitorTool(context,{action:'history',id:row.id})).includes('runs'));
}));
test('monitor creation preserves explicit permissions without silently elevating them',()=>fixture(user=>{
  const context={userId:user,sessionId:'monitor-session',permissionMode:'bypassPermissions'};
  executeMonitorTool(context,{action:'create',name:'Authorized job',content:'Check status',intervalMinutes:30});
  assert.equal(JSON.parse(monitorsDb.list(user)[0].options).permissionMode,'bypassPermissions');
  const row=monitorsService.create(user,{sessionId:'monitor-session',name:'Invalid mode',content:'Check',intervalMinutes:1,options:{permissionMode:'invalid',cwd:'/override',sessionId:'override'}});
  assert.deepEqual(JSON.parse(row.options),{permissionMode:'default'});
}));
test('chat tools cannot cross user/session scope or accept scope overrides',()=>fixture(user=>{
  sessionsDb.createAppSession('other-claude','claude',tmpdir(),'Other');const row=create(user);
  assert.throws(()=>executeMonitorTool({userId:user,sessionId:'other-claude'},{action:'stop',id:row.id}),/当前会话/);
  assert.throws(()=>executeMonitorTool({userId:user+1,sessionId:'monitor-session'},{action:'stop',id:row.id}));
  assert.throws(()=>executeMonitorTool({userId:user,sessionId:'monitor-session'},{action:'list',sessionId:'other-claude'}));
  assert.equal(monitorsDb.get(user,row.id)?.status,'active');
}));
test('scheduled tool context can stop itself but cannot create or broaden jobs',()=>fixture(user=>{
  const row=create(user);const other=create(user);const context={userId:user,sessionId:'monitor-session',monitorId:row.id};
  for(const action of ['create','update','resume','run_now'])assert.throws(()=>executeMonitorTool(context,{action,id:row.id,name:'copy',content:'check',intervalMinutes:1}));
  assert.throws(()=>executeMonitorTool(context,{action:'stop',id:other.id}));
  executeMonitorTool(context,{action:'stop'});assert.equal(monitorsDb.get(user,row.id)?.status,'stopped');assert.equal(monitorsDb.get(user,other.id)?.status,'active');
}));
function runtime(run?:ProviderRuntimeGateway['run'],busy=false):ProviderRuntimeGateway {
  return {hasRuntime:()=>true,hasBackgroundWork:()=>busy,
    run:run??(async(_provider,_command,options,writer)=>{writer.send(createCompleteMessage({provider:'claude',sessionId:String(options.sessionId),exitCode:0}));}),
    abort:async()=>{throw Error('Must not abort current work');},forceStop:async()=>{throw Error('Must not force-stop current work');},stopBackgroundTask:async()=>false,
    resolveToolApproval:()=>{},getPendingApprovalsForSession:()=>[]};
}
test('recurs after completion with one receipt per execution and catches up once',()=>fixture(async user=>{
  const row=create(user);const rt=runtime();
  assert.equal(await dispatchMonitors(rt,new Date(Date.now()+86400000)),1);
  assert.equal(monitorsDb.get(user,row.id)?.run_count,1);
  assert.equal(await dispatchMonitors(rt),0);
  assert.equal(await dispatchMonitors(rt,new Date(Date.now()+120000)),1);
  assert.deepEqual(monitorsDb.history(user,row.id).map(r=>r.status),['succeeded','succeeded']);
}));
test('busy/background session is deferred without aborting or recording a false run',()=>fixture(async user=>{
  const row=create(user);
  assert.equal(await dispatchMonitors(runtime(undefined,true),new Date(Date.now()+120000)),0);
  assert.equal(monitorsDb.history(user,row.id).length,0);
  assert.match(monitorsDb.get(user,row.id)!.last_error!,/等待/);
}));
test('overlapping polls cannot launch duplicate runs; pause during execution stays paused',()=>fixture(async user=>{
  const row=create(user);let finish!:()=>void;let calls=0;
  const rt=runtime(async(_p,_c,options,writer)=>{calls++;await new Promise<void>(r=>{finish=r;});writer.send(createCompleteMessage({provider:'claude',sessionId:String(options.sessionId),exitCode:0}));});
  const first=dispatchMonitors(rt,new Date(Date.now()+120000));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(await dispatchMonitors(rt,new Date(Date.now()+120000)),0);
  monitorsService.action(user,row.id,'pause');finish();await first;
  assert.equal(calls,1);assert.equal(monitorsDb.get(user,row.id)?.status,'paused');
  monitorsService.action(user,row.id,'resume');assert.equal(monitorsDb.get(user,row.id)?.status,'active');
  monitorsService.action(user,row.id,'stop');assert.equal(await dispatchMonitors(runtime(),new Date(Date.now()+120000)),0);
}));
test('event-only failure schedules automatic recovery and preserves an error receipt',()=>fixture(async user=>{
  const row=create(user);
  await dispatchMonitors(runtime(async(_p,_c,_o,writer)=>{writer.send({kind:'error',content:'provider offline'});writer.send(createCompleteMessage({provider:'claude',exitCode:1}));}),new Date(Date.now()+120000));
  assert.equal(monitorsDb.get(user,row.id)?.status,'active');
  assert.equal(monitorsDb.get(user,row.id)?.consecutive_failures,1);
  assert.ok(Date.parse(monitorsDb.get(user,row.id)!.next_run_at)>Date.now());
  assert.equal(monitorsDb.history(user,row.id)[0].status,'failed');
  assert.match(monitorsDb.history(user,row.id)[0].error!,/offline/);
}));
test('restart persists idle schedules and schedules recovery of unconfirmed active runs',()=>fixture(async user=>{
  const row=create(user);const idle=create(user);
  assert.ok(monitorsDb.claim(row.id,new Date(Date.now()+120000)));
  closeConnection();await initializeDatabase();monitorsDb.recover();
  assert.equal(sessionsDb.getSessionById('monitor-session')?.provider_session_id,null);
  assert.equal(monitorsDb.get(user,row.id)?.status,'active');assert.equal(monitorsDb.history(user,row.id)[0].status,'interrupted');
  assert.equal(monitorsDb.get(user,row.id)?.consecutive_failures,1);
  assert.equal(monitorsDb.get(user,idle.id)?.status,'active');
}));

test('retry delay grows to 30 minutes and success resets it without losing failed attempts',()=>fixture(user=>{
  const row=create(user);let now=new Date(Date.now()+120000);
  for(const delay of [1,2,4,8,16,30,30]) {
    const run=monitorsDb.claim(row.id,now)!;assert.ok(run);monitorsDb.finish(row.id,run,'temporary offline',now);
    const after=monitorsDb.get(user,row.id)!;assert.equal(after.status,'active');assert.equal(Date.parse(after.next_run_at)-now.getTime(),delay*60000);now=new Date(after.next_run_at);
  }
  const run=monitorsDb.claim(row.id,now)!;monitorsDb.finish(row.id,run,null,now);
  assert.equal(monitorsDb.get(user,row.id)?.consecutive_failures,0);
  assert.equal(monitorsDb.history(user,row.id).filter(run=>run.status==='failed').length,7);
}));

test('restart recovery never resumes a monitor manually paused or stopped while its run was active',()=>fixture(user=>{
  const paused=create(user);const now=new Date(Date.now()+120000);assert.ok(monitorsDb.claim(paused.id,now));
  monitorsService.action(user,paused.id,'pause');monitorsDb.recover(now);
  assert.equal(monitorsDb.get(user,paused.id)?.status,'paused');assert.equal(monitorsDb.get(user,paused.id)?.pause_reason,'user');
  const stopped=create(user);assert.ok(monitorsDb.claim(stopped.id,now));monitorsService.action(user,stopped.id,'stop');monitorsDb.recover(now);
  assert.equal(monitorsDb.get(user,stopped.id)?.status,'stopped');
}));
test('invalid intervals, archived/non-Claude sessions and foreign ownership are rejected',()=>fixture(user=>{
  for(const intervalMinutes of [0,-1,1.5,10081,'30'])assert.throws(()=>monitorsService.create(user,{sessionId:'monitor-session',name:'test',content:'status',intervalMinutes}));
  const row=create(user);assert.throws(()=>monitorsService.action(user+1,row.id,'stop'));assert.throws(()=>monitorsService.history(user+1,row.id));
  sessionsDb.createAppSession('other','codex',tmpdir(),'Other');assert.throws(()=>monitorsService.create(user,{sessionId:'other',name:'test',content:'status',intervalMinutes:1}));
}));

test('calendar monitor survives restart and completion moves to the next future slot without catch-up',()=>fixture(async user=>{
  const schedule={frequency:'daily',time:'09:00',timeZone:'Asia/Shanghai'};
  const row=monitorsService.create(user,{sessionId:'monitor-session',name:'Daily',content:'Read only',schedule});
  assert.equal(row.schedule_json,JSON.stringify(schedule));
  assert.ok(Date.parse(row.next_run_at)>Date.now());
  closeConnection();await initializeDatabase();monitorsDb.recover();
  assert.equal(monitorsDb.get(user,row.id)?.next_run_at,row.next_run_at);
  const future=new Date(Date.parse(row.next_run_at)+3*86400000+3600000);
  const runId=monitorsDb.claim(row.id,future)!;assert.ok(runId);
  assert.equal(monitorsDb.claim(row.id,future),null);
  monitorsDb.finish(row.id,runId,null,future);
  const after=monitorsDb.get(user,row.id)!;
  assert.equal(after.run_count,1);assert.ok(Date.parse(after.next_run_at)>future.getTime());
  assert.equal(new Date(after.next_run_at).getUTCHours(),1);
  assert.equal(monitorsDb.due(future).some(task=>task.id===row.id),false);
}));

test('calendar pause/resume skips missed times; update preserves cadence unless explicitly changed',()=>fixture(user=>{
  const row=monitorsService.create(user,{sessionId:'monitor-session',name:'Daily',content:'Read',schedule:{frequency:'daily',time:'09:00',timeZone:'Asia/Shanghai'}});
  const same=monitorsService.update(user,row.id,{name:'Renamed'});assert.equal(same.next_run_at,row.next_run_at);assert.equal(same.schedule_json,row.schedule_json);
  monitorsService.action(user,row.id,'pause');monitorsService.action(user,row.id,'resume');
  assert.ok(Date.parse(monitorsDb.get(user,row.id)!.next_run_at)>Date.now());
  const interval=monitorsService.update(user,row.id,{schedule:null,intervalMinutes:10});
  assert.equal(interval.schedule_json,null);assert.equal(interval.interval_minutes,10);
  assert.ok(Math.abs(Date.parse(interval.next_run_at)-Date.now()-600000)<1000);
}));

test('adding calendar column does not rewrite legacy interval tasks or their next execution',()=>fixture(async user=>{
  const row=create(user);getConnection().exec('ALTER TABLE monitors DROP COLUMN schedule_json');
  closeConnection();await initializeDatabase();
  const after=monitorsDb.get(user,row.id)!;
  assert.equal(after.next_run_at,row.next_run_at);assert.equal(after.interval_minutes,row.interval_minutes);assert.equal(after.status,row.status);assert.equal(after.schedule_json,null);
}));

test('calendar MCP creation is idempotent and reports the actual permission mode',()=>fixture(user=>{
  const context={userId:user,sessionId:'monitor-session'};
  const args={action:'create',name:'Calendar',content:'Read',schedule:{frequency:'weekly',time:'09:00',timeZone:'Asia/Shanghai',weekdays:[5,1]}};
  const first=executeMonitorTool(context,args) as {permissionMode:string};
  executeMonitorTool(context,{...args,schedule:{...args.schedule,weekdays:[1,5]}});
  assert.equal(monitorsDb.list(user).length,1);assert.equal(first.permissionMode,'default');
}));

test('simultaneous monitors cannot claim the same session before provider startup',()=>fixture(user=>{
  const first=create(user),second=create(user),now=new Date(Date.now()+120000);
  const run=monitorsDb.claim(first.id,now);assert.ok(run);
  assert.equal(monitorsDb.claim(second.id,now),null);
  assert.equal(monitorsDb.history(user,second.id).length,0);
  sessionsDb.createAppSession('parallel-monitor','claude',tmpdir(),'Parallel');
  const parallel=monitorsService.create(user,{sessionId:'parallel-monitor',name:'Parallel',content:'Read',intervalMinutes:1});
  assert.ok(monitorsDb.claim(parallel.id,now));
  monitorsDb.finish(first.id,run!,null,now);
  assert.ok(monitorsDb.claim(second.id,now));
}));
