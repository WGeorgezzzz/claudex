import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';

// On Windows (with Windows Terminal as the default terminal) a console child
// started without windowsHide opens a visible terminal window. Every non-PTY
// launch must hide it. A hidden child still owns a (windowless) console, so
// the tools it starts inherit that console and stay hidden too; `detached`
// would drop the console and make every grandchild open a window of its own.

type CapturedSpawn = { command: string; args: readonly string[]; options: childProcess.SpawnOptions };

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    (child.stdout as PassThrough).end();
    (child.stderr as PassThrough).end();
    setImmediate(() => {
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    });
    return true;
  };
  return child;
}

async function captureSpawns(run: (captured: CapturedSpawn[]) => Promise<void>): Promise<CapturedSpawn[]> {
  const originalSpawn = childProcess.spawn;
  const captured: CapturedSpawn[] = [];
  (childProcess as { spawn: unknown }).spawn = (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    captured.push({ command, args, options });
    return fakeChild();
  };
  syncBuiltinESMExports();
  try {
    await run(captured);
  } finally {
    (childProcess as { spawn: unknown }).spawn = originalSpawn;
    syncBuiltinESMExports();
  }
  return captured;
}

test('Claude Agent SDK launches the configured Claude executable with a hidden console', async () => {
  const abortController = new AbortController();
  const captured = await captureSpawns(async (seen) => {
    const session = query({
      prompt: 'fixture',
      options: {
        // Same shape claude-runtime passes: an explicit executable plus a full env.
        pathToClaudeCodeExecutable: process.execPath,
        env: { ...process.env },
        abortController,
      },
    });
    const first = session.next().catch(() => undefined);
    for (let attempt = 0; attempt < 100 && seen.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    abortController.abort();
    await Promise.race([first, new Promise((resolve) => setTimeout(resolve, 3000))]);
  });

  const launch = captured.find((entry) => entry.command === process.execPath);
  assert.ok(launch, `Claude executable was not spawned; saw ${captured.map((entry) => entry.command).join(', ')}`);
  assert.equal(launch.options.windowsHide, true);
  assert.notEqual(launch.options.detached, true);
});

test('Codex SDK launches codex with a hidden console', async () => {
  const captured = await captureSpawns(async () => {
    const original = childProcess.spawn;
    // Finish the turn as soon as the prompt has been written.
    (childProcess as { spawn: unknown }).spawn = (...spawnArgs: Parameters<typeof original>) => {
      const child = (original as unknown as (...a: unknown[]) => ReturnType<typeof fakeChild>)(...spawnArgs);
      (child.stdin as PassThrough).on('finish', () => {
        (child.stdout as PassThrough).end(`${JSON.stringify({ type: 'thread.started', thread_id: 'fixture' })}\n`
          + `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } })}\n`);
        child.emit('exit', 0, null);
      });
      return child;
    };
    syncBuiltinESMExports();
    await new Codex({ codexPathOverride: process.execPath }).startThread().run('fixture');
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].options.windowsHide, true);
  assert.notEqual(captured[0].options.detached, true);
});

// Static guard for the launches the app makes itself: every spawn / exec call
// in server and electron sources must pass windowsHide.
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_ROOT = path.resolve(SERVER_ROOT, '..', 'electron');
const LAUNCH_CALL = /\b(?:spawn|spawnProcess|spawnFunction|crossSpawn|execFileSync|execSync|execFile|spawnSync|spawn\.sync)\s*\(/g;
const LAUNCH_IMPORT = /(?:from\s+['"](?:node:)?child_process['"]|from\s+['"]cross-spawn['"]|spawnProcess)/;
// macOS-only launches never open a Windows console.
const ALLOWED = [/spawn\('osascript'/];

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === 'tests' ? [] : sourceFiles(full);
    }
    return /\.(?:[cm]?js|ts)$/.test(entry.name) && !/\.test\.[cm]?[jt]s$/.test(entry.name) ? [full] : [];
  });
}

function callText(source: string, openParen: number): string {
  let depth = 0;
  for (let index = openParen; index < source.length; index += 1) {
    const character = source[index];
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openParen, index + 1);
    }
  }
  return source.slice(openParen);
}

test('every server and electron child-process launch hides its Windows console', () => {
  const missing: string[] = [];
  for (const file of [...sourceFiles(SERVER_ROOT), ...sourceFiles(ELECTRON_ROOT)]) {
    const source = fs.readFileSync(file, 'utf8');
    if (!LAUNCH_IMPORT.test(source)) continue;
    for (const match of source.matchAll(LAUNCH_CALL)) {
      const start = match.index ?? 0;
      const preceding = source.slice(Math.max(0, start - 12), start);
      // Skip declarations, type positions and unrelated methods such as db.exec().
      if (/(?:function\s+|\.|typeof\s+)$/.test(preceding)) continue;
      const call = match[0] + callText(source, start + match[0].length - 1).slice(1);
      if (ALLOWED.some((pattern) => pattern.test(call))) continue;
      if (/^\w+(?:\.sync)?\s*\(\s*\)/.test(call)) continue;
      if (!/windowsHide/.test(call)) {
        const line = source.slice(0, start).split('\n').length;
        missing.push(`${path.relative(SERVER_ROOT, file)}:${line}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
