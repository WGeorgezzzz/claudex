import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { descendantsFromTables, isAlive, killProcessTree } from '@/shared/process-tree.js';

test('MSYS WINPID ancestry includes exec-reparented sleeps without touching another shell', () => {
  const native = '100 10\n200 100\n300 200\n400 999\n500 998\n600 10';
  const msys = 'PID PPID PGID WINPID TTY UID STIME COMMAND\n182 1 182 300 ? 1 00:00 bash\n183 182 182 400 ? 1 00:00 sleep\n184 182 182 500 ? 1 00:00 sleep\n185 1 185 600 ? 1 00:00 bash';
  assert.deepEqual(descendantsFromTables(100, native, msys), [200, 300, 400, 500]);
});

// A parent that starts a long-running grandchild (the shape of a CLI running
// `sleep 600` in a shell) and reports the grandchild's pid.
const PARENT_SCRIPT = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
process.stdout.write(String(child.pid) + '\\n');
setInterval(() => {}, 1000);
`;

test('killProcessTree kills the root and every process it started', async () => {
  const parent = spawn(process.execPath, ['-e', PARENT_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const grandchildPid = await new Promise<number>((resolve, reject) => {
    parent.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
    parent.once('error', reject);
  });
  assert.ok(isAlive(parent.pid!));
  assert.ok(isAlive(grandchildPid));

  assert.equal(await killProcessTree(parent.pid!), true);
  for (let attempt = 0; attempt < 20 && isAlive(grandchildPid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(isAlive(parent.pid!), false);
  assert.equal(isAlive(grandchildPid), false);
});

test('killProcessTree never kills this process and ignores invalid pids', async () => {
  assert.equal(await killProcessTree(process.pid), false);
  assert.equal(await killProcessTree(0), false);
  assert.equal(await killProcessTree(-5), false);
  assert.ok(isAlive(process.pid));
});

test('killProcessTree refuses a tree that contains this server', async () => {
  // The parent of this test process holds this process in its tree.
  assert.equal(await killProcessTree(process.ppid), false);
  assert.ok(isAlive(process.ppid));
});
