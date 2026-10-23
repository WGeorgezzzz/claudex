import assert from 'node:assert/strict';

import { test } from 'vitest';

import { restoreLiveInsertionMessages } from '@/modules/chat/utils/liveInsertionMessages';
import type { ChatMessage, QueuedConversationMessage } from '@/shared/types';

const receipt:QueuedConversationMessage={id:'live',session_id:'session',content:'Inserted requirement',status:'succeeded',delivery_mode:'live',
  revision:2,attempt_count:1,error:null,created_at:'2026-10-23T20:16:02Z',started_at:null,finished_at:null};
const message=(content:string,timestamp:string,type:ChatMessage['type']='user'):ChatMessage=>({type,content,timestamp});

test('reconstructs a missing live user message between the tool and final reply after reload',()=>{
  const before=message('Original task','2026-10-23T20:15:55Z'),after=message('Reply with inserted requirement','2026-10-23T20:17:00Z','assistant');
  const result=restoreLiveInsertionMessages([before,after],[receipt]);
  assert.equal(result.length,3);assert.equal(result[1].content,receipt.content);assert.equal(result[1].insertedMidTurn,true);
  assert.equal(result[0],before);assert.equal(result[2],after);
  assert.equal(restoreLiveInsertionMessages(result,[receipt]).length,3);
});

test('marks an existing local or persisted echo once without duplicating it',()=>{
  const result=restoreLiveInsertionMessages([message(receipt.content,receipt.created_at)],[receipt]);
  assert.equal(result.length,1);assert.equal(result[0].insertedMidTurn,true);
});

test('identical insertions remain distinct and failed or queued records never fabricate user messages',()=>{
  const result=restoreLiveInsertionMessages([message(receipt.content,receipt.created_at)],[receipt,{...receipt,id:'second'},
    {...receipt,id:'failed',status:'failed'},{...receipt,id:'next',delivery_mode:'queued'}]);
  assert.equal(result.length,2);assert.ok(result.every(row=>row.insertedMidTurn));
});

test('receipts outside a paginated tail are not injected above unloaded history',()=>{
  assert.equal(restoreLiveInsertionMessages([message('Later turn','2026-10-23T21:00:00Z')],[receipt]).length,1);
});
