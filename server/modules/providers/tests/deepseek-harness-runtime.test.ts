import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deepSeekHarnessRuntime } from '../list/deepseek-harness/deepseek-harness-runtime.provider.js';
import type { ProviderRuntimeContext, NormalizedMessage } from '@/shared/index.js';

test('native completion remains successful after a reported tool failure; fatal exits still fail', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-runtime-regression-'));
  const oldInstall = process.env.DEEPSEEK_HARNESS_INSTALL_DIR;
  const oldHome = process.env.CLOUDCLI_HOME;
  process.env.DEEPSEEK_HARNESS_INSTALL_DIR = directory;
  process.env.CLOUDCLI_HOME = path.join(directory, 'home');
  try {
    await mkdir(path.join(directory, 'runtime/node_modules/@deepseek-ai/dsh'), { recursive: true });
    for (const name of ['runtime/node_modules/@deepseek-ai/dsh/package.json', 'rp.patch.yml', 'rp.dpapi']) await writeFile(path.join(directory, name), '{}');
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => null, resolveResumeModel: async () => 'configured',
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'configured' }),
      normalizeMessage: () => [], isProviderInstalled: async () => true,
    };
    for (const exitCode of [0, 2]) {
      const rows = [
        { type: 'session', sessionId: 'session-runtime-test' },
        { type: 'tool_call', callId: 'one', tool: 'glob', input: { pattern: '*' } },
        { type: 'tool_result', callId: 'one', status: 'error', result: 'tool timed out' },
        { type: 'text', text: 'Search failed; please specify the project.' },
        { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
        { type: 'final', text: 'Search failed; please specify the project.' },
      ];
      await writeFile(path.join(directory, 'run.ps1'), rows.map(row => "Write-Output '" + JSON.stringify(row) + "'").join('\n') + `\nexit ${exitCode}\n`);
      const messages: NormalizedMessage[] = [];
      const run = deepSeekHarnessRuntime.run('regression', { cwd: directory }, { send: row => messages.push(row as NormalizedMessage) }, context);
      if (exitCode === 0) {
        await run;
        assert.equal(messages.filter(row => row.kind === 'error').length, 0);
        assert.equal(messages.filter(row => row.kind === 'tool_result' && row.isError).length, 1);
      } else {
        await assert.rejects(run, /did not complete/);
        assert.equal(messages.filter(row => row.kind === 'error').length, 1);
      }
    }
    assert.match(await readFile(path.join(directory, 'run.ps1'), 'utf8'), /exit 2/);
  } finally {
    if (oldInstall === undefined) delete process.env.DEEPSEEK_HARNESS_INSTALL_DIR; else process.env.DEEPSEEK_HARNESS_INSTALL_DIR = oldInstall;
    if (oldHome === undefined) delete process.env.CLOUDCLI_HOME; else process.env.CLOUDCLI_HOME = oldHome;
  }
});
