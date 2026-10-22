import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, messageQueueDb, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { createCompleteMessage } from '@/shared/utils.js';
import { providerModelsService } from '@/modules/providers/index.js';
import { messageQueueService } from '@/modules/message-queue/message-queue.service.js';
import { dispatchMessageQueue, importLegacyQueuedMessages } from '@/modules/message-queue/message-queue.dispatcher.js';
import { createLiveInputService } from '@/modules/message-queue/live-input.service.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import type { ProviderLiveInputResult } from '@/shared/types.js';

async function fixture(check:(userId:number)=>Promise<void>|void) {
  const previous=process.env.DATABASE_PATH;
  const root=await mkdtemp(path.join(os.tmpdir(),'workbench-queue-'));
  closeConnection();process.env.DATABASE_PATH=path.join(root,'test.db');await initializeDatabase();
  const userId=Number(userDb.createUser('queue-test','hash').id);
  sessionsDb.createAppSession('queue-session','claude',root,'Queue');
  try {await check(userId);}
  finally {
    chatRunRegistry.clearAll();closeConnection();
    if(previous===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previous;
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
    await rm(root,{recursive:true,force:true});
  }
}
const enqueue=(user:number,id:string,content=id)=>messageQueueService.enqueue(user,{
  sessionId:'queue-session',requestId:id,content,options:{permissionMode:'default'},
});

test('live delivery persists one receipt, bypasses queued work, and never starts another runtime',()=>fixture(user=>{
  const queued=enqueue(user,'next-turn');
  const running=messageQueueDb.claim(queued.id)!;
  const run=chatRunRegistry.startRun({appSessionId:'queue-session',provider:'claude',connection:null,userId:user,providerSessionId:null})!;
  let delivered=0;
  let settle:((result:ProviderLiveInputResult)=>void)|undefined;
  const live=createLiveInputService({...providerRuntimeService,submitLiveInput(_provider,_session,_id,_content,done){delivered++;settle=done;}});
  const input={sessionId:'queue-session',requestId:'addition',content:'also do this',expectedStartedAt:run.startedAt};
  const receipt=live.submit(user,input);
  assert.equal(receipt.status,'running');assert.equal(receipt.delivery_mode,'live');
  assert.equal(live.submit(user,input).id,receipt.id);assert.equal(delivered,1);
  assert.equal(messageQueueDb.get(user,running.id)?.status,'running');
  settle!({status:'succeeded',error:null});
  assert.equal(messageQueueDb.get(user,receipt.id)?.status,'succeeded');
  assert.equal(messageQueueDb.attempts(user,receipt.id).length,1);
}));

test('uncertain live input is never replayed after restart; explicit recovery creates a separate queued turn',()=>fixture(user=>{
  const live=messageQueueService.enqueue(user,{sessionId:'queue-session',requestId:'lost',content:'preserve me'},'live');
  const queued=enqueue(user,'next');
  messageQueueDb.recover();
  const uncertain=messageQueueDb.get(user,live.id)!;
  assert.equal(uncertain.status,'interrupted');
  assert.deepEqual(messageQueueDb.heads().map(row=>row.id),[queued.id]);
  const retry=messageQueueService.update(user,live.id,{action:'retry',revision:uncertain.revision});
  assert.notEqual(retry.id,live.id);assert.equal(retry.delivery_mode,'queued');
  assert.equal(messageQueueDb.get(user,live.id)?.status,'interrupted');
  assert.equal(messageQueueService.update(user,live.id,{action:'retry',revision:uncertain.revision}).id,retry.id);
}));

test('live input refuses a changed turn and keeps an auditable failure without calling the provider',()=>fixture(user=>{
  chatRunRegistry.startRun({appSessionId:'queue-session',provider:'claude',connection:null,userId:user,providerSessionId:null});
  const live=createLiveInputService({...providerRuntimeService,submitLiveInput(){throw new Error('must not be called');}});
  const receipt=live.submit(user,{sessionId:'queue-session',requestId:'stale',content:'addition',expectedStartedAt:1});
  assert.equal(receipt.status,'failed');assert.match(receipt.error||'',/active turn changed/);
}));
function runtime(run?:ProviderRuntimeGateway['run'],busy=false):ProviderRuntimeGateway {
  return {hasRuntime:()=>true,hasBackgroundWork:()=>busy,
    run:run??(async(_provider,_command,options,writer)=>{writer.send(createCompleteMessage({provider:'claude',sessionId:String(options.sessionId),exitCode:0}));}),
    abort:async()=>{throw new Error('Queue must never abort existing work');},stopBackgroundTask:async()=>false,
    resolveToolApproval:()=>{},getPendingApprovalsForSession:()=>[]};
}

test('transport retries are idempotent; different input and stale edits are rejected',()=>fixture(user=>{
  const first=enqueue(user,'request','first');
  assert.equal(enqueue(user,'request','first').id,first.id);
  assert.throws(()=>enqueue(user,'request','different'),/different input/);
  assert.equal(messageQueueDb.list(user,'queue-session').length,1);
  const edited=messageQueueService.update(user,first.id,{revision:first.revision,content:'edited'});
  assert.equal(edited.content,'edited');
  assert.throws(()=>messageQueueService.update(user,first.id,{revision:first.revision,content:'stale'}),/changed/);
  assert.throws(()=>messageQueueService.update(user+1,first.id,{revision:edited.revision,action:'cancel'}),/not found/);
  const row=messageQueueService.enqueue(user,{sessionId:'queue-session',requestId:'paths',content:'x',options:{cwd:'/override',sessionId:'wrong',permissionMode:'default'}});
  assert.deepEqual(JSON.parse(row.options),{permissionMode:'default'});
}));

test('FIFO dispatch preserves every entry and confirms completion events',()=>fixture(async user=>{
  const first=enqueue(user,'first'), second=enqueue(user,'second');
  const sent:string[]=[];
  const rt=runtime(async(_p,command,options,writer)=>{
    sent.push(command);
    writer.send(createCompleteMessage({provider:'claude',sessionId:String(options.sessionId),exitCode:0}));
  });
  assert.equal(await dispatchMessageQueue(rt),1);
  assert.equal(messageQueueDb.get(user,first.id)?.status,'succeeded');
  assert.equal(messageQueueDb.get(user,second.id)?.status,'queued');
  assert.equal(await dispatchMessageQueue(rt),1);
  assert.deepEqual(sent,['first','second']);
  assert.equal(await dispatchMessageQueue(rt),0);
}));

test('a failed head pauses later work; explicit retry retains the failed attempt',()=>fixture(async user=>{
  const first=enqueue(user,'first'), second=enqueue(user,'second');
  await dispatchMessageQueue(runtime(async(_p,_c,_o,writer)=>{
    writer.send({kind:'error',content:'model unavailable'});
    writer.send(createCompleteMessage({provider:'claude',exitCode:0}));
  }));
  assert.equal(messageQueueDb.get(user,first.id)?.status,'failed');
  assert.equal(await dispatchMessageQueue(runtime()),0);
  const failed=messageQueueDb.get(user,first.id)!;
  messageQueueService.update(user,first.id,{revision:failed.revision,action:'retry'});
  await dispatchMessageQueue(runtime());
  assert.deepEqual(messageQueueDb.attempts(user,first.id).map(row=>row.status),['failed','succeeded']);
  assert.equal(messageQueueDb.get(user,second.id)?.status,'queued');
  await dispatchMessageQueue(runtime());
  assert.equal(messageQueueDb.get(user,second.id)?.status,'succeeded');
}));

test('background work is untouched and claimed messages cannot be cancelled or edited',()=>fixture(async user=>{
  const row=enqueue(user,'busy');
  assert.equal(await dispatchMessageQueue(runtime(undefined,true)),0);
  assert.equal(messageQueueDb.get(user,row.id)?.attempt_count,0);
  const claimed=messageQueueDb.claim(row.id)!;
  assert.throws(()=>messageQueueService.update(user,row.id,{revision:claimed.revision,action:'cancel'}),/changed/);
  assert.throws(()=>messageQueueService.update(user,row.id,{revision:claimed.revision,content:'overwrite'}),/changed/);
}));

test('overlapping polls cannot duplicate a claim and independent sessions still progress',()=>fixture(async user=>{
  sessionsDb.createAppSession('other-session','claude',os.tmpdir(),'Other');
  const first=enqueue(user,'slow');
  let release!:()=>void;
  let started!:()=>void;
  const ready=new Promise<void>(resolve=>{started=resolve;});
  const rt=runtime(async(_p,command,_o,writer)=>{
    if(command==='slow'){started();await new Promise<void>(resolve=>{release=resolve;});}
    writer.send(createCompleteMessage({provider:'claude',exitCode:0}));
  });
  const pass=dispatchMessageQueue(rt);
  await ready;
  const other=messageQueueService.enqueue(user,{sessionId:'other-session',requestId:'other',content:'other'});
  assert.equal(await dispatchMessageQueue(rt),1);
  assert.equal(messageQueueDb.get(user,other.id)?.status,'succeeded');
  assert.equal(messageQueueDb.get(user,first.id)?.attempt_count,1);
  release();await pass;
}));

test('restart retains queued entries and marks uncertain execution interrupted without replay',()=>fixture(async user=>{
  const first=enqueue(user,'first'), second=enqueue(user,'second');
  assert.ok(messageQueueDb.claim(first.id));
  closeConnection();await initializeDatabase();messageQueueDb.recover();
  assert.equal(messageQueueDb.get(user,first.id)?.status,'interrupted');
  assert.equal(messageQueueDb.get(user,second.id)?.status,'queued');
  assert.equal(await dispatchMessageQueue(runtime()),0);
  const interrupted=messageQueueDb.get(user,first.id)!;
  messageQueueService.update(user,first.id,{revision:interrupted.revision,action:'cancel'});
  assert.equal(await dispatchMessageQueue(runtime()),1);
  assert.equal(messageQueueDb.attempts(user,first.id)[0].status,'interrupted');
}));

test('missing terminal confirmation is a failure, not inferred success',()=>fixture(async user=>{
  const row=enqueue(user,'no-confirmation');
  await dispatchMessageQueue(runtime(async()=>{}));
  assert.equal(messageQueueDb.get(user,row.id)?.status,'failed');
  assert.match(messageQueueDb.get(user,row.id)?.error||'',/without a completion/);
}));

test('a preparation failure releases the run reservation and remains explicitly retryable',()=>fixture(async user=>{
  const row=messageQueueService.enqueue(user,{sessionId:'queue-session',requestId:'prepare-failure',content:'test',options:{model:'model-test'}});
  const original=providerModelsService.setSessionModel;
  providerModelsService.setSessionModel=()=>{throw new Error('metadata write failed');};
  try {await dispatchMessageQueue(runtime());}
  finally {providerModelsService.setSessionModel=original;}
  assert.equal(messageQueueDb.get(user,row.id)?.status,'failed');
  assert.equal(chatRunRegistry.isProcessing('queue-session'),false);
}));

test('legacy queue import is atomic and preserves unsent text',()=>fixture(user=>{
  sessionDraftsDb.saveDraft(user,'queue-session',{text:'still typing',queuedMessage:{content:'legacy',options:{permissionMode:'default'}}});
  importLegacyQueuedMessages();importLegacyQueuedMessages();
  assert.equal(messageQueueDb.list(user,'queue-session').length,1);
  const draft=sessionDraftsDb.getDrafts(user)[0];
  assert.equal(draft.text,'still typing');assert.equal(draft.queuedMessage,null);
}));
