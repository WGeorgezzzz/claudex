import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { Codex } from '@openai/codex-sdk';

test('SDK turns hide Windows consoles while preserving streaming and cancellation', async () => {
  const originalSpawn = childProcess.spawn;
  const controller = new AbortController();
  let options;
  childProcess.spawn = (_command, _args, spawnOptions) => {
    options = spawnOptions;
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    child.stdin.on('finish', () => {
      child.stdout.end(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }) + '\n'
        + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } }) + '\n');
      child.emit('exit', 0);
    });
    return child;
  };
  syncBuiltinESMExports();
  try {
    const result = await new Codex({ codexPathOverride: process.execPath }).startThread().run('fixture', { signal: controller.signal });
    assert.equal(result.usage.output_tokens, 1);
    assert.equal(options.signal, controller.signal);
    assert.equal(options.windowsHide, true);
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
});
