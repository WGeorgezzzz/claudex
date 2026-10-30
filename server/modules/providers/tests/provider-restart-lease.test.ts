import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { createProviderRestartLease } from '../services/provider-restart-lease.service.js';
const {createProviderHandoff}=createRequire(path.join(process.cwd(), 'package.json'))('./scripts/deploy/provider-handoff.cjs');

test('cancel restores ingress; stale guard cannot resume a newer handoff', () => {
  let draining = false;
  const lease = createProviderRestartLease(value => { draining = value; });
  lease.begin('old'); assert.equal(draining, true);
  lease.cancel('old'); assert.equal(draining, false);
  lease.begin('new'); assert.throws(() => lease.cancel('old'), /mismatch/);
  assert.equal(draining, true); lease.cancel('new');
});
test('a crashed guard expires and an in-flight preparation cannot freeze ingress again', async () => {
  let draining = false;
  const lease = createProviderRestartLease(value => { draining = value; }, 20);
  lease.begin('crashed');
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(draining, false); assert.throws(() => lease.assertCurrent('crashed'), /expired/);
  lease.begin('replacement'); lease.cancel('replacement'); assert.equal(draining, false);
});
test('lost prepare response and post-prepare failure both cancel the actual lease', async () => {
  for (const responseLost of [true, false]) {
    let draining = false;
    const lease = createProviderRestartLease(value => { draining = value; });
    const guard = createProviderHandoff(async (op: string, body: {handoffId: string}) => {
      if (op === 'cancel') return lease.cancel(body.handoffId);
      const token = lease.begin(body.handoffId);
      if (responseLost) throw new Error('response connection lost');
      return {ready: true, ...token};
    });
    if (responseLost) await assert.rejects(guard.prepare(), /connection lost/);
    else { await guard.prepare(); assert.equal(draining, true); await guard.cancel(); }
    assert.equal(draining, false);
  }
});
