import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { apply } from './workspace-search-guard.mjs';

test('multi-project root fails immediately with recovery instructions; project glob delegates unchanged', async () => {
  let handler;
  const root = path.resolve('workspace-fixture');
  apply({ on(event, fn) { assert.equal(event, 'tools/execute'); handler = fn; },
    workingDirectory: { async ensure() { return root; } } }, { roots: [root] });
  let calls = 0;
  const next = async () => { calls++; return { content: [] }; };
  const input = { name: 'glob', arguments: { pattern: '*', path: '.' }, agent: {}, signal: new AbortController().signal };
  const result = await handler(input, next);
  assert.equal(result.error.info.code, 'SEARCH_SCOPE_TOO_BROAD');
  assert.match(result.content[0].text, /Get-ChildItem/);
  assert.equal(calls, 0);
  await handler({ ...input, arguments: { pattern: '**/*.ts', path: 'project' } }, next);
  await handler({ ...input, name: 'read' }, next);
  assert.equal(calls, 2);
  assert.deepEqual(input.arguments, { pattern: '*', path: '.' });
});
