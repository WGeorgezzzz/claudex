import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createClaudeLaunchEnvironment } from '@/shared/index.js';
import type { ProviderRuntimeContext } from '@/shared/types.js';

import { queryClaudeSDK } from '../list/claude/claude-runtime.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '../list/claude/claude-models.provider.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-lane-proxy-'));
  const manifest = path.join(root, 'lane-manifest.json');
  fs.writeFileSync(manifest, '\uFEFF' + JSON.stringify({ port: 42314 }));
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: root,
    HTTP_PROXY: 'http://127.0.0.1:7900',
    HTTPS_PROXY: 'http://lane:private-local-session@127.0.0.1:42314',
    NO_PROXY: 'localhost,127.0.0.1',
    ANTHROPIC_BASE_URL: 'https://example.test',
  };
  return { root, manifest, env, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('lane launch rejects inherited loopback proxies without mutating parent or valid settings', () => {
  const f = fixture();
  try {
    for (const host of ['127.0.0.1', '127.0.0.2', '127.1', 'localhost', 'LOCALHOST.', '[::1]', '[::ffff:127.0.0.1]']) {
      const env = { ...f.env, HTTPS_PROXY: `http://lane:secret@${host}:42314`, all_proxy: `${host}:42314` };
      const before = { ...env };
      const cleaned = createClaudeLaunchEnvironment(env, 'C:\\launchers\\channel.js', 'win32');
      assert.equal(cleaned.HTTPS_PROXY, undefined, host);
      assert.equal(cleaned.all_proxy, undefined, host);
      assert.equal(cleaned.HTTP_PROXY, f.env.HTTP_PROXY);
      assert.equal(cleaned.NO_PROXY, env.NO_PROXY);
      assert.equal(cleaned.ANTHROPIC_BASE_URL, env.ANTHROPIC_BASE_URL);
      assert.deepEqual(env, before);
    }
  } finally { f.cleanup(); }
});

test('direct Claude binaries, other platforms and unrelated proxies keep their environment', () => {
  const f = fixture();
  try {
    for (const executable of ['C:\\boxed\\claude.exe', 'claude', undefined]) {
      assert.deepEqual(createClaudeLaunchEnvironment(f.env, executable, 'win32'), f.env);
    }
    assert.deepEqual(createClaudeLaunchEnvironment(f.env, 'channel.js', 'linux'), f.env);
    for (const proxy of ['http://127.0.0.1:7900', 'http://proxy.example.test:42314', 'not a URL']) {
      const env = { ...f.env, HTTPS_PROXY: proxy };
      assert.deepEqual(createClaudeLaunchEnvironment(env, 'channel.js', 'win32'), env);
    }
    for (const contents of ['invalid json', '{}', '{"port":0}', '{"port":"42314"}', '{"port":65536}']) {
      fs.writeFileSync(f.manifest, contents);
      assert.deepEqual(createClaudeLaunchEnvironment(f.env, 'channel.js', 'win32'), f.env);
    }
    fs.unlinkSync(f.manifest);
    assert.deepEqual(createClaudeLaunchEnvironment(f.env, 'channel.js', 'win32'), f.env);
  } finally { f.cleanup(); }
});

test('a reinstall changing the lane port is picked up on the next launch', () => {
  const f = fixture();
  try {
    assert.equal(createClaudeLaunchEnvironment(f.env, 'channel.ps1', 'win32').HTTPS_PROXY, undefined);
    fs.writeFileSync(f.manifest, JSON.stringify({ port: 42315 }));
    assert.equal(createClaudeLaunchEnvironment(f.env, 'channel.ps1', 'win32').HTTPS_PROXY, f.env.HTTPS_PROXY);
    f.env.HTTPS_PROXY = 'http://localhost:42315';
    assert.equal(createClaudeLaunchEnvironment(f.env, 'channel.ps1', 'win32').HTTPS_PROXY, undefined);
  } finally { f.cleanup(); }
});

test('an unpatched Windows launcher receives the safe upstream after reinstall', { skip: process.platform !== 'win32' }, () => {
  const f = fixture();
  try {
    // The old launcher selects HTTPS_PROXY first. It remains completely unpatched.
    const script = path.join(f.root, 'legacy-launcher.ps1');
    fs.writeFileSync(script, 'if ($env:HTTPS_PROXY) { $env:HTTPS_PROXY } else { $env:HTTP_PROXY }');
    const args = ['-NoProfile', '-File', script];
    assert.equal(execFileSync('powershell.exe', args, { env: f.env, encoding: 'utf8', windowsHide: true }).trim(), f.env.HTTPS_PROXY);
    const env = createClaudeLaunchEnvironment(f.env, script);
    assert.equal(execFileSync('powershell.exe', args, { env, encoding: 'utf8', windowsHide: true }).trim(), f.env.HTTP_PROXY);
  } finally { f.cleanup(); }
});

test('SDK chat launch actually passes the filtered environment to its launcher', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  const previous = { ...process.env };
  let captured: NodeJS.ProcessEnv | undefined;
  try {
    Object.assign(process.env, f.env, { CLAUDE_CLI_PATH: path.join(f.root, 'channel.js') });
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async () => undefined,
      getProviderModels: async () => CLAUDE_PREDEFINED_MODELS,
      normalizeMessage: () => [],
      isProviderInstalled: async () => true,
      createQuery: ({ options }) => {
        captured = options.env as NodeJS.ProcessEnv;
        return Object.assign((async function* () { yield { type: 'result', subtype: 'success', result: 'ok', session_id: 'lane-regression' }; })(), {
          interrupt: async () => {},
        });
      },
    };
    await queryClaudeSDK('test', { sessionId: 'lane-launch-test', cwd: f.root }, { send: () => {}, userId: null } as never, context);
    assert.ok(captured);
    assert.equal(captured.HTTPS_PROXY, undefined);
    assert.equal(captured.HTTP_PROXY, f.env.HTTP_PROXY);
    assert.equal(captured.CLAUDE_CONFIG_DIR, f.root);
    assert.equal(process.env.HTTPS_PROXY, f.env.HTTPS_PROXY);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    f.cleanup();
  }
});
