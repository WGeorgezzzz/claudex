import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests must not inherit the running desktop's accounts, CLI paths or private gate.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = mkdtempSync(path.join(os.tmpdir(), 'claudex-backend-suite-'));
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(CLAUDE|CLAUDEX|CODEX|CLOUDCLI|ANTHROPIC|OPENAI|WORKBUDDY|VITE_|DATABASE_PATH|JWT_SECRET|API_KEY)/i.test(name)));
environment.USERPROFILE = fixture;
environment.HOME = fixture;
environment.CLOUDCLI_HOME = path.join(fixture, '.cloudcli');
environment.DATABASE_PATH = path.join(fixture, 'test.db');
mkdirSync(environment.CLOUDCLI_HOME, { recursive: true });
console.log(`Isolated backend test state: ${fixture}`);
const supplied = process.argv.slice(2);
const child = spawn(process.execPath, [
  path.join(root, 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', 'server/tsconfig.json',
  '--test', '--test-concurrency=1',
  ...(supplied.length ? supplied : ['server/**/*.test.ts', 'server/**/*.test.js']),
], { cwd: root, env: environment, stdio: 'inherit', windowsHide: true });
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
// Retain isolated state for failure diagnosis; never clean a developer home.
