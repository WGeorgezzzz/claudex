import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const {drainManagedSessions}=createRequire(import.meta.url)('../../../scripts/deploy/drain-managed-sessions.cjs');
test('forced deployment interrupts queued turns that arrive after its first snapshot',async()=>{
 const batches=[[{sessionId:'first'}],[{sessionId:'new-queued-turn'}],[]];
 const stopped:string[]=[],snapshots:string[][]=[];
 await drainManagedSessions({list:async()=>batches.shift(),interrupt:async(row:{sessionId:string})=>stopped.push(row.sessionId),record:(rows:{sessionId:string}[])=>snapshots.push(rows.map(r=>r.sessionId))});
 assert.deepEqual(stopped,['first','new-queued-turn']);assert.deepEqual(snapshots.at(-1),stopped);
});
test('forced deployment keeps an empty managed list untouched and bounds restart loops',async()=>{
 let stopped=0;
 await drainManagedSessions({list:async()=>[],interrupt:async()=>stopped++,record:()=>{}});assert.equal(stopped,0);
 await assert.rejects(drainManagedSessions({list:async()=>[{sessionId:'restarting'}],interrupt:async()=>stopped++,record:()=>{},maxBatches:2}),/keep restarting/);
 assert.equal(stopped,2);
});
