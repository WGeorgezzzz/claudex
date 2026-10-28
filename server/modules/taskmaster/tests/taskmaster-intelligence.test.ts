import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile} from 'node:fs/promises';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {closeConnection,initializeDatabase,userDb,userPreferencesDb} from '@/modules/database/index.js';
import {withUserContext} from '@/modules/auth/index.js';
import {createTaskIntelligenceService} from '@/modules/taskmaster/taskmaster-intelligence.service.js';
import {taskmasterInboxService} from '@/modules/taskmaster/taskmaster-inbox.service.js';
import {taskmasterWorkspace} from '@/modules/taskmaster/taskmaster-auto.service.js';
import {retrieveTaskEvidence} from '@/modules/taskmaster/taskmaster-evidence.service.js';

test('semantic grouping caches unchanged tasks, requires two members and keeps corrections across another model pass',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'nexagent-intelligence-')),previous=process.env.DATABASE_PATH,previousHome=process.env.CLOUDCLI_HOME;process.env.CLOUDCLI_HOME=path.join(root,'.cloudcli');closeConnection();process.env.DATABASE_PATH=path.join(root,'test.db');await initializeDatabase();
 const user=Number(userDb.createUser('intelligence-test','hash').id),tasks=[{id:1,title:'测试智能分类甲',status:'pending'},{id:2,title:'测试智能分类乙',status:'pending'}];
 t.mock.method(taskmasterInboxService,'global',async()=>({projects:[{projectId:'fixture',name:'测试项目',root,tasks,audits:[]}],infohub:{}}));
 let calls=0;
 const service=createTaskIntelligenceService(async(input,options)=>{calls++;options?.onUsage({input_tokens:100,output_tokens:100});const data=input as {tasks:{id:string}[];constraints:{action:string;id:string;target?:string}[]};return {tasks:data.tasks.map(task=>({id:task.id,summary:'校验智能任务分组',project:'测试项目',kind:'todo',due:null,people:[],next_action:'执行校验',urgency:2,new_group:{name:'分组验收',summary:'验证任务整理'},parent:{key:'parent',title:'完整验收',goal:'完成甲乙两项验收'},completion:{status:'unknown',confidence:0,evidence:[]},...((data.constraints||[]).some(c=>c.action==='move'&&c.id===task.id)?{group_id:(data.constraints||[]).find(c=>c.action==='move'&&c.id===task.id)!.target,new_group:undefined}:{})}))};});
 try{await withUserContext(user,async()=>{
  await service.run(user,false);let state=(await service.snapshot()) as {groups:{id:string}[];entries:Record<string,{groupId:string}>};assert.equal(state.groups.length,1);assert.equal(state.entries['fixture:1'].groupId,state.entries['fixture:2'].groupId);
  let execution:unknown[]=[];t.mock.method(taskmasterInboxService,'execute',async(...args:unknown[])=>{execution=args;return {sessionId:'parent-execution'};});await service.executeWithContext({id:'fixture:1',parent:true});assert.match(String(execution[3]),/测试智能分类甲/);assert.match(String(execution[3]),/测试智能分类乙/);assert.match(String(execution[3]),/tasks.json/);tasks[1].status='done';await service.executeWithContext({id:'fixture:2',parent:true});assert.equal(execution[1],'1','parent execution selects an unfinished child');tasks[1].status='pending';
  const firstCalls=calls;await service.run(user,false);assert.equal(calls,firstCalls,'content hashes skip unchanged tasks');const queued=service.asyncStart(false);assert.equal(queued.running,true);assert.equal('then' in queued,false,'HTTP trigger returns immediately');while((await service.snapshot()).running)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(calls,firstCalls);
  await service.correct({action:'move',id:'fixture:1',target:'unclassified'});await service.run(user,true);state=(await service.snapshot()) as typeof state;assert.equal(state.entries['fixture:1'].groupId,'unclassified');
  await service.correct({action:'rename',id:state.groups[0].id,value:'锁定分组名'});await service.run(user,true);assert.equal(((await service.snapshot()) as {groups:{name:string}[]}).groups[0].name,'锁定分组名');
 });}finally{t.mock.restoreAll();closeConnection();if(previousHome===undefined)delete process.env.CLOUDCLI_HOME;else process.env.CLOUDCLI_HOME=previousHome;if(previous===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previous;}
});

test('completion needs an exact source excerpt; rejected completions and exceeded budgets keep prior state',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'nexagent-completion-')),previous=process.env.DATABASE_PATH,previousHome=process.env.CLOUDCLI_HOME;process.env.CLOUDCLI_HOME=path.join(root,'.cloudcli');closeConnection();process.env.DATABASE_PATH=path.join(root,'test.db');await initializeDatabase();const user=Number(userDb.createUser('completion-test','hash').id);
 await writeFile(path.join(root,'DONE.json'),JSON.stringify({done:true,evidence:'测试完成证据确实成功'}));
 t.mock.method(taskmasterInboxService,'global',async()=>({projects:[{projectId:'fixture',name:'测试项目',root,tasks:[{id:1,title:'测试完成证据确实成功',status:'pending'}],audits:[]}],infohub:{}}));
 let changes=0;t.mock.method(taskmasterWorkspace,'changeInboxTask',async()=>{changes++;return {task:{},auditId:'fixture-audit'};});
 const service=createTaskIntelligenceService(async()=>({tasks:[{id:'fixture:1',summary:'完成核查',project:'测试项目',kind:'todo',due:null,people:[],next_action:'核查证据',urgency:1,completion:{status:'done',confidence:.99,evidence:[{index:0,excerpt:'模型编造且未出现在任何来源的摘录'}]}}]}));
 try{await withUserContext(user,async()=>{await service.run(user,false);assert.equal(changes,0);await service.correct({action:'deny-completion',id:'fixture:1'});await service.correct({action:'settings',budget:.01});await service.run(user,true);const state=(await service.snapshot()) as {error:string;entries:Record<string,unknown>};assert.match(state.error,/预算/);assert(state.entries['fixture:1']);assert.equal(changes,0);});}finally{t.mock.restoreAll();closeConnection();if(previousHome===undefined)delete process.env.CLOUDCLI_HOME;else process.env.CLOUDCLI_HOME=previousHome;if(previous===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previous;}
});

test('corroborated completion is automatic and restoring it prevents another automatic close',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'nexagent-positive-completion-')),previous=process.env.DATABASE_PATH,previousHome=process.env.CLOUDCLI_HOME;process.env.CLOUDCLI_HOME=path.join(root,'.cloudcli');closeConnection();process.env.DATABASE_PATH=path.join(root,'test.db');await initializeDatabase();const user=Number(userDb.createUser('positive-completion','hash').id);
 const proof='自动完成验收证据确实全部成功';await writeFile(path.join(root,'DONE.json'),JSON.stringify({done:true,evidence:proof}));const tasks=[{id:1,title:proof,status:'pending'}];
 t.mock.method(taskmasterInboxService,'global',async()=>({projects:[{projectId:'fixture',name:'测试项目',root,tasks,audits:[]}],infohub:{}}));
 let changes=0;t.mock.method(taskmasterWorkspace,'changeInboxTask',async()=>{changes++;tasks[0].status='done';return {task:tasks[0],auditId:'completion-audit'};});t.mock.method(taskmasterWorkspace,'undo',async()=>{tasks[0].status='pending';return {status:'undone'};});
 const service=createTaskIntelligenceService(async(input,options)=>{options?.onUsage({input_tokens:100,output_tokens:100});const data=input as {evidence?:{excerpt:string}[]};const index=data.evidence?.findIndex(e=>e.excerpt.includes(proof))??-1;return {tasks:[{id:'fixture:1',summary:'验证自动完成',project:'测试项目',kind:'todo',due:null,people:[],next_action:'核对完整证据',urgency:2,completion:{status:'done',confidence:.99,evidence:index>=0?[{index,excerpt:proof}]:[]}}]};});
 try{await withUserContext(user,async()=>{await service.run(user,false);assert.equal(changes,1);assert.equal(tasks[0].status,'done');await service.correct({action:'restore',id:'fixture:1'});assert.equal(tasks[0].status,'pending');await service.run(user,false);assert.equal(changes,1);assert.equal(tasks[0].status,'pending');});}finally{t.mock.restoreAll();closeConnection();if(previous===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previous;if(previousHome===undefined)delete process.env.CLOUDCLI_HOME;else process.env.CLOUDCLI_HOME=previousHome;}
});

test('transient relay failures retry and cached results do not pay for another interpretation',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'nexagent-retry-')),previous=process.env.DATABASE_PATH,previousHome=process.env.CLOUDCLI_HOME;process.env.CLOUDCLI_HOME=path.join(root,'.cloudcli');closeConnection();process.env.DATABASE_PATH=path.join(root,'test.db');await initializeDatabase();const user=Number(userDb.createUser('retry-test','hash').id);
 t.mock.method(taskmasterInboxService,'global',async()=>({projects:[{projectId:'fixture',name:'测试项目',root,tasks:[{id:1,title:'验证模型重试缓存',status:'pending'}],audits:[]}],infohub:{}}));let attempts=0;
 const service=createTaskIntelligenceService(async(_input,options)=>{if(!options?.instructions.startsWith('你是任务整理员')){options?.onUsage({input_tokens:100,output_tokens:100});return {focus:[]};}attempts++;if(attempts<3)throw Error('fetch failed');options.onUsage({input_tokens:100,output_tokens:100});return {tasks:[{id:'fixture:1',summary:'验证重试',project:'测试项目',kind:'todo',due:null,people:[],next_action:'核查缓存',urgency:2}]};});
 try{await withUserContext(user,async()=>{await service.run(user,false);assert.equal(attempts,3);assert((await service.snapshot()).entries['fixture:1']);await service.run(user,false);assert.equal(attempts,3);});}finally{t.mock.restoreAll();closeConnection();if(previous===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previous;if(previousHome===undefined)delete process.env.CLOUDCLI_HOME;else process.env.CLOUDCLI_HOME=previousHome;}
});

test('retrieval preserves the terminal record after a long earlier progress paragraph',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'ZXQProofUnique-')),previous=process.env.DATABASE_PATH;closeConnection();process.env.DATABASE_PATH=path.join(root,'test.db');await initializeDatabase();const user=Number(userDb.createUser('evidence-terminal','hash').id),terminal='2026-10-29 ZXQProofUnique 已完成全部验收，监测 deadbeef 已停。';await writeFile(path.join(root,'STATUS.md'),'# ZXQProofUnique\n'+('较早的进展说明。'.repeat(300))+'\n'+terminal);
 try{await withUserContext(user,async()=>{const evidence=await retrieveTaskEvidence([{id:'fixture',title:'ZXQProofUnique',project:'测试项目',root,sessionIds:[]}]);const found=evidence.find(e=>e.path===path.join(root,'STATUS.md'));assert(found);assert(found.excerpt.includes(terminal));});}finally{closeConnection();if(previous===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previous;}
});


test('contradictory failure evidence cannot automatically close a task',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'nexagent-contradiction-')),previous=process.env.DATABASE_PATH,previousHome=process.env.CLOUDCLI_HOME;process.env.CLOUDCLI_HOME=path.join(root,'.cloudcli');closeConnection();process.env.DATABASE_PATH=path.join(root,'test.db');await initializeDatabase();const user=Number(userDb.createUser('contradiction','hash').id),proof='相机恢复验收未通过，四路 CSI 0 帧，仍需修复';await writeFile(path.join(root,'STATUS.md'),proof);
 t.mock.method(taskmasterInboxService,'global',async()=>({projects:[{projectId:'fixture',name:'测试项目',root,tasks:[{id:1,title:'相机恢复验收',status:'pending'}],audits:[]}],infohub:{}}));let changes=0;t.mock.method(taskmasterWorkspace,'changeInboxTask',async()=>{changes++;return {task:{},auditId:'unexpected'};});const service=createTaskIntelligenceService(async input=>{const data=input as {evidence?:{excerpt:string}[]};return {tasks:[{id:'fixture:1',summary:'相机已恢复',project:'测试项目',kind:'todo',due:null,people:[],next_action:'核查相机',urgency:2,completion:{status:'done',confidence:.99,evidence:[{index:data.evidence?.findIndex(e=>e.excerpt.includes(proof))??0,excerpt:proof}]}}]};});
 try{await withUserContext(user,async()=>{await service.run(user,false);assert.equal(changes,0);assert.equal((await service.snapshot()).entries['fixture:1'].completion?.confidence,.85);});}finally{t.mock.restoreAll();closeConnection();if(previous===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previous;if(previousHome===undefined)delete process.env.CLOUDCLI_HOME;else process.env.CLOUDCLI_HOME=previousHome;}
});


test('completion retrieval reads matching commits from the related repository main branch',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'ZXQGitUnique-')),previous=process.env.DATABASE_PATH;closeConnection();process.env.DATABASE_PATH=path.join(root,'test.db');await initializeDatabase();const user=Number(userDb.createUser('git-evidence','hash').id);execFileSync('git',['init','-b','main',root],{windowsHide:true});await writeFile(path.join(root,'proof.md'),'ZXQGitUnique completed');execFileSync('git',['-C',root,'add','proof.md'],{windowsHide:true});execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','feat: ZXQGitUnique completed'],{windowsHide:true});
 try{await withUserContext(user,async()=>{const evidence=await retrieveTaskEvidence([{id:'fixture',title:'ZXQGitUnique',project:'测试项目',root,sessionIds:[]}]);assert(evidence.some(item=>item.type==='git'&&item.path.endsWith('@main')&&item.excerpt.includes('ZXQGitUnique completed')));});}finally{closeConnection();if(previous===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previous;}
});
