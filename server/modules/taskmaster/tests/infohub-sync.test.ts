import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTaskmasterWorkspaceService } from '../taskmaster-workspace.service.js';
import { infohubRecord,infohubTopics } from '../taskmaster-infohub.model.js';
import type { InfohubUnit } from '../taskmaster-infohub.model.js';

const unit=(changes:Partial<InfohubUnit>={}):InfohubUnit=>({id:42,kind:'todo',status:'open',title:'同步验收任务',summary:'摘要',updated_at:Math.floor(Date.now()/1000)-10,for_me:1,tags:['project:实验','topic:同步'],parents:[{id:7,title:'主题'}],messages:[{id:9,source:'lark',link:'https://example.test/message'}],...changes});
test('source IDs deduplicate incrementally, merge legacy evidence and remote completion is reversible',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'infohub-tasks-')),service=createTaskmasterWorkspaceService(async()=>{throw Error('No organizer model');});
  await service.initialize(root);
  await service.importInbox(root,1,'legacy',[{id:5,title:'同步验收任务',detail:'旧证据',source:'飞书会议',due:'',urgency:'中',options:[],recommended:'A'}]);
  let u=unit(),records=[infohubRecord(u)],topics=infohubTopics([u]);
  const first=await service.reconcileInfohub(root,1,records,topics);assert.equal(first.merges.length,1);assert.ok(first.backup);
  assert.equal((await service.list(root,1)).tasks.length,1);
  const again=await service.reconcileInfohub(root,1,records,topics);assert.equal(again.imported,0);assert.equal(again.auditId,null);
  const task=(await service.list(root,1)).tasks[0];assert.equal(task.source,'infohub');assert.equal(task.sourceId,'42');assert.match(JSON.stringify(task.originEvidence),/旧证据/);
  u=unit({status:'done',updated_at:Math.floor(Date.now()/1000)+1});
  const complete=await service.reconcileInfohub(root,1,[infohubRecord(u)],topics);assert.equal((await service.list(root,1)).tasks[0].status,'done');
  await service.undo(root,1,'global',complete.auditId!);assert.equal((await service.list(root,1)).tasks[0].status,'pending');
});
test('local completion and undo produce opposite remote writebacks without losing the task ID',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'infohub-bidirectional-')),service=createTaskmasterWorkspaceService(async()=>({}));
  const u=unit();await service.reconcileInfohub(root,1,[infohubRecord(u)],infohubTopics([u]));
  const id=String((await service.list(root,1)).tasks[0].id);
  const action=await service.changeInboxTask(root,1,id,async()=>({status:'done'}));
  const outgoing=await service.reconcileInfohub(root,1,[infohubRecord(u)],infohubTopics([u]));assert.equal(outgoing.writes[0].status,'done');
  const confirmed=unit({status:'done',updated_at:Math.floor(Date.now()/1000)});await service.reconcileInfohub(root,1,[infohubRecord(confirmed)],infohubTopics([confirmed]));
  await service.undo(root,1,'global',action.auditId!);
  const reverse=await service.reconcileInfohub(root,1,[infohubRecord(confirmed)],infohubTopics([confirmed]));assert.equal(reverse.writes[0].status,'pending');assert.equal(reverse.writes[0].taskId,Number(id));
});
test('a newer remote change wins a stale local completion and undone imports stay removed',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'infohub-conflicts-')),service=createTaskmasterWorkspaceService(async()=>({})),u=unit();
  const initial=await service.reconcileInfohub(root,1,[infohubRecord(u)],infohubTopics([u]));
  await service.undo(root,1,'global',initial.auditId!);await service.reconcileInfohub(root,1,[infohubRecord(u)],infohubTopics([u]));assert.equal((await service.list(root,1)).tasks.length,0);
  const updated=unit({summary:'新版本',updated_at:Math.floor(Date.now()/1000)+10});await service.reconcileInfohub(root,1,[infohubRecord(updated)],infohubTopics([updated]));
  const id=String((await service.list(root,1)).tasks[0].id);await service.changeInboxTask(root,1,id,async()=>({status:'done'}));
  const remote=unit({status:'dropped',updated_at:Math.floor(Date.now()/1000)+20});const result=await service.reconcileInfohub(root,1,[infohubRecord(remote)],infohubTopics([remote]));assert.equal(result.writes.length,0);assert.equal((await service.list(root,1)).tasks[0].status,'cancelled');
});

test('undoing source edits keeps the reverted fields until that source changes again',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'infohub-field-undo-')),service=createTaskmasterWorkspaceService(async()=>({}));
 const original=unit();await service.reconcileInfohub(root,1,[infohubRecord(original)],infohubTopics([original]));
 const edited=unit({title:'来源修改后的标题',updated_at:original.updated_at+1});const receipt=await service.reconcileInfohub(root,1,[infohubRecord(edited)],infohubTopics([edited]));
 await service.undo(root,1,'global',receipt.auditId!);await service.reconcileInfohub(root,1,[infohubRecord(edited)],infohubTopics([edited]));assert.equal((await service.list(root,1)).tasks[0].title,original.title);
 const later=unit({title:'来源下一次修改',updated_at:edited.updated_at+1});await service.reconcileInfohub(root,1,[infohubRecord(later)],infohubTopics([later]));assert.equal((await service.list(root,1)).tasks[0].title,later.title);
});
test('a todo used as a parent retains its own ancestor in the source graph',()=>{
 const root=unit({id:1,kind:'topic',parents:[]}),parent=unit({id:2,parents:[{id:1,title:'根主题'}]}),child=unit({id:3,parents:[{id:2,title:'父待办'}]});const topics=infohubTopics([root,parent,child]);assert.deepEqual(topics.find(t=>t.id==='infohub-unit:2')?.parentIds,['infohub-unit:1']);
});
