import assert from 'node:assert/strict';
import test from 'node:test';

import { createReplySuggestionsService } from '@/modules/providers/services/reply-suggestions.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

const rows:NormalizedMessage[]=[
  {id:'u',sessionId:'s',provider:'claude',kind:'text',role:'user',content:'SuZhou gardens, two people, 600 yuan.',timestamp:'2026-10-24'},
  {id:'a',sessionId:'s',provider:'claude',kind:'text',role:'assistant',content:'Do you prefer garden A or garden B?',timestamp:'2026-10-24'},
];

test('authorizes before reading, coalesces requests and scopes cached suggestions by owner',async()=>{
  let calls=0;
  const service=createReplySuggestionsService({authorize:(user)=>{assert.equal(user,1);return {provider:'claude'};},readHistory:async()=>rows,
    generate:async context=>{calls++;assert.equal(context.at(-1)?.content,rows[1].content);return ['Choose garden B within 600 yuan.'];}});
  const [a,b]=await Promise.all([service.get(1,'s',rows[1].content!),service.get(1,'s',rows[1].content!)]);
  assert.deepEqual(a.replies,['Choose garden B within 600 yuan.']);assert.deepEqual(a,b);assert.equal(calls,1);
  await service.get(1,'s',rows[1].content!);assert.equal(calls,1);
  await assert.rejects(service.get(2,'s',rows[1].content!));assert.equal(calls,1);
});

test('a newer user message invalidates generation already in flight',async()=>{
  let current=rows;
  const service=createReplySuggestionsService({authorize:()=>({provider:'claude'}),readHistory:async()=>current,
    generate:async()=>{current=[...rows,{...rows[0],id:'u2',content:'Actually use Hangzhou.'}];return ['Choose garden A in Suzhou.'];}});
  assert.deepEqual(await service.get(1,'s',rows[1].content!),{status:'stale',replies:[]});
});

test('does not generate for mismatched replies or silently cross provider boundaries',async()=>{
  let calls=0;
  const common={readHistory:async()=>rows,generate:async()=>{calls++;return ['Unused'];}};
  const service=createReplySuggestionsService({...common,authorize:()=>({provider:'claude'})});
  assert.equal((await service.get(1,'s','A stale answer')).status,'stale');
  const other=createReplySuggestionsService({...common,authorize:()=>({provider:'codex'})});
  assert.equal((await other.get(1,'s',rows[1].content!)).status,'unsupported');assert.equal(calls,0);
});

test('malformed output fails rather than becoming template or partial suggestions',async()=>{
  const service=createReplySuggestionsService({authorize:()=>({provider:'claude'}),readHistory:async()=>rows,generate:async()=>['a','b','c','d']});
  await assert.rejects(service.get(1,'s',rows[1].content!));
});

test('a running session does not start auxiliary inference',async()=>{
  let calls=0;
  const service=createReplySuggestionsService({authorize:()=>({provider:'claude'}),readHistory:async()=>rows,isRunning:()=>true,generate:async()=>{calls++;return ['Unused'];}});
  assert.equal((await service.get(1,'s',rows[1].content!)).status,'stale');assert.equal(calls,0);
});


test('auxiliary suggestions use Sonnet even when the conversation uses Opus',async()=>{
  const service=createReplySuggestionsService({authorize:()=>({provider:'claude',model:'opus'}),readHistory:async()=>rows,
    generate:async(_context,model)=>{assert.equal(model,'sonnet');return ['Choose garden B.'];}});
  assert.equal((await service.get(1,'s',rows[1].content!)).status,'ready');
});
