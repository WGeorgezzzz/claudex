import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const {partitionDeploymentSessions}=createRequire(import.meta.url)('../../../scripts/deploy/running-session-ownership.cjs');
test('deployment waits for owned turns and their background work',()=>{
 const turn={sessionId:'owned-turn',canInterrupt:true},background={sessionId:'owned-background',canInterrupt:false,tasks:[{taskId:'shell-1'}]},legacy={sessionId:'legacy-owned'};
 assert.deepEqual(partitionDeploymentSessions([turn,background,legacy]),{managed:[turn,background,legacy],independent:[]});
});
test('independent and recovered CLIs are preserved instead of being interrupted by deployment',()=>{
 const external={sessionId:'independent-codex',canInterrupt:false,statusText:'Recovered CLI process; force stop is available'},cli={sessionId:'independent-claude',canInterrupt:false,statusText:'Running in the Claude CLI',tasks:[]};
 const rows=[external,cli],before=structuredClone(rows);assert.deepEqual(partitionDeploymentSessions(rows),{managed:[],independent:rows});assert.deepEqual(rows,before);
});

test('an ambiguous non-interruptible run still blocks deployment',()=>{const row={sessionId:'unknown-owner',canInterrupt:false};assert.deepEqual(partitionDeploymentSessions([row]),{managed:[row],independent:[]});});
