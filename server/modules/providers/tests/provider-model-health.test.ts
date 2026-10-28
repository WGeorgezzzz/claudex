import test from 'node:test';
import assert from 'node:assert/strict';
import { recordModelRejection,modelHealth } from '../services/provider-model-health.js';
const catalog=(value:string)=>({OPTIONS:[{value,label:value}],DEFAULT:value});
test('an explicit account rejection disables only the rejected provider model and redacts its credential',()=>{
 recordModelRejection('codex','account-rejected-fixture','This model is not supported for this ChatGPT account sk-privatefixture');
 const result=modelHealth('codex',catalog('account-rejected-fixture'));assert.equal(result.OPTIONS[0].disabled,true);assert.ok(!result.OPTIONS[0].unavailableReason?.includes('sk-privatefixture'));assert.equal(modelHealth('claude',catalog('account-rejected-fixture')).OPTIONS[0].disabled,undefined);
});
test('network and quota failures do not disable a model',()=>{recordModelRejection('codex','transient-fixture','429 rate limit; network timeout');assert.equal(modelHealth('codex',catalog('transient-fixture')).OPTIONS[0].disabled,undefined);});
