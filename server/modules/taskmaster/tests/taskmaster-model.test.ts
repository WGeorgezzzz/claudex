import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installAuthorizationFixture, testUserId } from '@/test-support/authorization-fixture.js';
import { withUserContext } from '@/modules/auth/index.js';
import { generateTaskmasterExtraction } from '../taskmaster-model.service.js';
installAuthorizationFixture();

test('luna and explicit model fallback on 404,429,all 5xx and timeout, without mini or credential mutation', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-relay-'));
  await mkdir(path.join(home, 'relay')); const relay = path.join(home, 'relay');
  await writeFile(path.join(relay, 'config.toml'), 'model="gpt-6.1-sol"\nmodel_provider="test"\n[model_providers.test]\nbase_url="https://relay.invalid/v1"\n');
  await writeFile(path.join(relay, 'auth.json'), '{"OPENAI_API_KEY":"test-not-real"}');
  const previous = process.env.TASKMASTER_CODEX_HOME; process.env.TASKMASTER_CODEX_HOME = relay;
  t.after(() => { if (previous === undefined) delete process.env.TASKMASTER_CODEX_HOME; else process.env.TASKMASTER_CODEX_HOME = previous; });
  for (const failure of [404, 429, 500, 504, 'timeout', 'connect-timeout', 'explicit-model']) {
    const models: string[] = [];
    if (failure === 'explicit-model') process.env.TASKMASTER_AUTO_MODEL = 'configured-preferred';
    t.after(() => { delete process.env.TASKMASTER_AUTO_MODEL; });
    const mock = t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
      const body = JSON.parse(String(options.body)); models.push(body.model);
      assert.equal(body.max_output_tokens, 2000); assert.equal(body.reasoning.effort, 'low');
      if (models.length === 1) { if (failure === 'timeout') throw new DOMException('timeout', 'TimeoutError'); if (failure === 'connect-timeout') throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }); return new Response('', { status: failure === 'explicit-model' ? 404 : Number(failure) }); }
      return Response.json({ status: 'completed', usage: { input_tokens: 10, output_tokens: 5 }, output: [{ content: [{ type: 'output_text', text: '{"tasks":[]}' }] }] });
    });
    await withUserContext(testUserId(), () => generateTaskmasterExtraction({ sessionId: 'test', messages: [] }));
    assert.deepEqual(models, [failure === 'explicit-model' ? 'configured-preferred' : 'gpt-6-luna', 'gpt-6.1-sol']); mock.mock.restore();
  }

  delete process.env.TASKMASTER_AUTO_MODEL;
  for (const response of [new Response('', { status: 400 }), Response.json({ status: 'incomplete', output: [] })]) {
    let calls = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => { calls++; return response; });
    await assert.rejects(withUserContext(testUserId(), () => generateTaskmasterExtraction({ sessionId: 'rejected' })));
    assert.equal(calls, 1, 'invalid requests and truncated JSON must not retry another model');
    mock.mock.restore();
  }
});
