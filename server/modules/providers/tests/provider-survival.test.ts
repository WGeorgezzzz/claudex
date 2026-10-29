import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import { DurableProvider } from '../services/provider-supervisor.service.js';

const resultsRoot = process.env.PROVIDER_SURVIVAL_RESULTS || fs.mkdtempSync(path.join(os.tmpdir(), 'provider-survival-'));
fs.mkdirSync(resultsRoot, { recursive: true });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 300; attempt++) { if (await predicate()) return; await sleep(100); }
  throw new Error('Condition timeout');
}
function output(client: DurableProvider, kind = 'stdout') {
  return fs.readFileSync(path.join(client.directory, 'output.ndjson'), 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(row => row.kind === kind).map(row => Buffer.from(row.data, 'base64').toString('utf8')).join('');
}
async function write(client: DurableProvider, data: unknown) {
  return client.control({ type: 'write', data: Buffer.from(JSON.stringify(data) + '\n').toString('base64') });
}

test('abrupt client death preserves independent worker, byte-exact stdout/stderr, EOF and durable replay', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(resultsRoot, 'stream-'));
  const marker = path.join(root, 'client.json');
  const moduleURL = new URL('../services/provider-supervisor.service.js', import.meta.url).href;
  const program = `let i=0;const t=setInterval(()=>{process.stdout.write(i+':中文🙂\\n');process.stderr.write(i+':err\\n');if(++i===100){clearInterval(t);process.stdin.resume();}},20);process.stdin.on('end',()=>process.exit(0));`;
  const script = `import fs from 'node:fs';import {DurableProvider} from ${JSON.stringify(moduleURL)};const c=await DurableProvider.start(${JSON.stringify(root)},{command:process.execPath,args:['-e',${JSON.stringify(program)}]});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({directory:c.directory,pid:process.pid}));setInterval(()=>{},1000);`;
  const controller = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: 'ignore' });
  await until(() => fs.existsSync(marker));
  const client = new DurableProvider(JSON.parse(fs.readFileSync(marker, 'utf8')).directory);
  const original = client.registry();
  await until(() => output(client).includes('3:中文'));
  controller.kill('SIGKILL'); await once(controller, 'exit');
  await until(() => output(client).includes('99:中文'));
  assert.equal(await client.identity(), true);
  assert.equal(client.registry().pid, original.pid);
  assert.equal(client.registry().childPid, original.childPid);
  assert.equal(output(client), Array.from({ length: 100 }, (_, i) => `${i}:中文🙂\n`).join(''));
  assert.equal(output(client, 'stderr'), Array.from({ length: 100 }, (_, i) => `${i}:err\n`).join(''));
  await client.control({ type: 'end' });
  const events = [];
  for await (const row of client.events()) events.push(row);
  assert.equal(events.at(-1)?.event.kind, 'exit');
  assert.equal(events.at(-1)?.event.data.code, 0);
  assert.equal(new Set(events.map(row => row.event.seq)).size, events.length);
  const cursor = events[2].offset;
  const replay = [];
  for await (const row of new DurableProvider(client.directory).events(cursor)) replay.push(row);
  assert.deepEqual(replay, events.slice(3));
  fs.writeFileSync(path.join(root, 'assertions.json'), JSON.stringify({ controllerKilled: true, original, stdoutLines: 100, stderrLines: 100, exact: true, replay: true }, null, 2));
});

test('real installed Codex app-server: authenticated reattach preserves process and JSON-RPC after client disconnect', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(resultsRoot, 'codex-'));
  const launcher = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
  const client = await DurableProvider.start(root, { command: process.execPath, args: [launcher, 'app-server'], cwd: root },
    { ...process.env, CODEX_HOME: path.join(root, 'codex-home'), CLOUDCLI_HOME: path.join(root, 'cloudcli'), DATABASE_PATH: path.join(root, 'test.db') });
  try {
    const original = client.registry();
    await write(client, { id: 1, method: 'initialize', params: { clientInfo: { name: 'survival-test', version: '1' }, capabilities: {} } });
    await until(() => output(client).includes('"id":1'));
    await write(client, { method: 'initialized', params: {} });
    await write(client, { id: 2, method: 'config/read', params: {} });
    // The request is sent before the new client exists: its reply is durable.
    await until(() => output(client).includes('"id":2'));
    const adopted = new DurableProvider(client.directory);
    assert.equal(await adopted.identity(), true);
    assert.equal(adopted.registry().childPid, original.childPid);
    await write(adopted, { id: 3, method: 'config/read', params: {} });
    await until(() => output(adopted).includes('"id":3'));
    const replies = output(adopted).split('\n').filter(Boolean).map(line => JSON.parse(line));
    for (const id of [1, 2, 3]) { assert.equal(replies.filter(row => row.id === id).length, 1); assert.equal(replies.find(row => row.id === id)?.error, undefined); }
    const token = fs.readFileSync(path.join(client.directory, 'token'), 'utf8');
    fs.writeFileSync(path.join(client.directory, 'token'), 'wrong-token');
    assert.equal(await new DurableProvider(client.directory).identity(), false);
    fs.writeFileSync(path.join(client.directory, 'token'), token);
    fs.writeFileSync(path.join(root, 'assertions.json'), JSON.stringify({ realCLI: launcher, original, preservedPid: true, replies: [1, 2, 3], unauthorizedRejected: true, modelTurn: false }, null, 2));
  } finally { await client.control({ type: 'kill' }); }
});

test('real Claude CLI streaming initialize remains connected across client replacement', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(resultsRoot, 'claude-'));
  const executable = process.env.SURVIVAL_CLAUDE_EXE || path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  assert.ok(fs.existsSync(executable), `Claude CLI required at ${executable}`);
  const client = await DurableProvider.start(root, { command: executable, args: ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'], cwd: root },
    { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, 'claude-home'), CLOUDCLI_HOME: path.join(root, 'cloudcli'), DATABASE_PATH: path.join(root, 'test.db') });
  try {
    const original = client.registry();
    await write(client, { type: 'control_request', request_id: 'survival-init', request: { subtype: 'initialize' } });
    await until(() => output(client).includes('survival-init'));
    const adopted = new DurableProvider(client.directory);
    assert.equal(await adopted.identity(), true);
    assert.equal(adopted.registry().childPid, original.childPid);
    assert.ok(output(adopted).includes('control_response'));
    fs.writeFileSync(path.join(root, 'assertions.json'), JSON.stringify({ executable, original, preservedPid: true, initializeReply: true, modelTurn: false }, null, 2));
  } finally { await client.control({ type: 'kill' }); }
});
