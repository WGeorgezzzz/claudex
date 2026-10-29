import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
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
  return Buffer.concat(fs.readFileSync(path.join(client.directory, 'output.ndjson'), 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(row => row.kind === kind).map(row => Buffer.from(row.data, 'base64'))).toString('utf8');
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
  fs.mkdirSync(path.join(root, 'codex-home'));
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
  fs.mkdirSync(path.join(root, 'claude-home'));
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

test('Windows Stop-ScheduledTask preserves supervisor and output outside the stopped task job', { timeout: 90000, skip: process.platform !== 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(resultsRoot, 'scheduled-'));
  const name = 'Nexagent-Survival-Test-' + path.basename(root);
  const marker = path.join(root, 'client.json');
  const moduleURL = new URL('../services/provider-supervisor.service.js', import.meta.url).href;
  const program = `let i=0;setInterval(()=>process.stdout.write((i++)+':scheduled\\n'),100);`;
  const controllerPath = path.join(root, 'controller.mjs');
  fs.writeFileSync(controllerPath, `import fs from 'node:fs';import {DurableProvider} from ${JSON.stringify(moduleURL)};const c=await DurableProvider.start(${JSON.stringify(root)},{command:process.execPath,args:['-e',${JSON.stringify(program)}]});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({directory:c.directory,pid:process.pid}));setInterval(()=>{},1000);`);
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const powershell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const ps = (script: string) => execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" + script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8' });
  let client: DurableProvider | undefined;
  try {
    // A GUI test action creates no console. Its kill-on-close job makes the
    // controller's death observable when Task Scheduler stops the root action.
    const harness = path.join(root, 'TaskOwner.exe');
    const source = `using System;using System.Diagnostics;using System.Runtime.InteropServices;
public class Owner {
[DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a,string n);
[DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr p,uint l);
[DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
public static void Main(string[] args) {
IntPtr job=CreateJobObject(IntPtr.Zero,null);IntPtr info=Marshal.AllocHGlobal(144);
for(int i=0;i<144;i++)Marshal.WriteByte(info,i,0);Marshal.WriteInt32(info,16,0x2000);
if(!SetInformationJobObject(job,9,info,144))throw new Exception("job flags "+Marshal.GetLastWin32Error());
Process p=Process.Start(new ProcessStartInfo(args[0],"\\\""+args[1]+"\\\""){UseShellExecute=false,CreateNoWindow=true});
if(!AssignProcessToJobObject(job,p.Handle))throw new Exception("assign job "+Marshal.GetLastWin32Error());p.WaitForExit();GC.KeepAlive(job);
}}`;
    ps(`Add-Type -TypeDefinition ${quote(source)} -OutputAssembly ${quote(harness)} -OutputType WindowsApplication`);
    const args = `"${process.execPath}" "${controllerPath}"`;
    ps(`$a=New-ScheduledTaskAction -Execute ${quote(harness)} -Argument ${quote(args)};Register-ScheduledTask -TaskName ${quote(name)} -Action $a -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -Hidden) | Out-Null;Start-ScheduledTask -TaskName ${quote(name)}`);
    await until(() => fs.existsSync(marker));
    client = new DurableProvider(JSON.parse(fs.readFileSync(marker, 'utf8')).directory);
    await until(() => output(client!).includes('3:scheduled'));
    const before = output(client);
    ps(`Stop-ScheduledTask -TaskName ${quote(name)}`);
    await sleep(2000);
    const controllerPid = JSON.parse(fs.readFileSync(marker, 'utf8')).pid;
    assert.throws(() => process.kill(controllerPid, 0), 'Stop-ScheduledTask must actually terminate the owning controller');
    const alive = await client.identity();
    const after = output(client);
    fs.writeFileSync(path.join(root, 'assertions.json'), JSON.stringify({ stopScheduledTask: true, alive, beforeBytes: before.length, afterBytes: after.length, registry: client.registry() }, null, 2));
    assert.equal(alive, true, 'Supervisor is still inside the scheduled-task job; detached/conhost alone is insufficient');
    assert.ok(after.length > before.length);
  } finally {
    if (client && await client.identity()) await client.control({ type: 'kill' });
    if (fs.existsSync(marker)) {
      const pid = JSON.parse(fs.readFileSync(marker, 'utf8')).pid;
      try { process.kill(pid, 'SIGKILL'); } catch { /* Task already terminated its own controller. */ }
    }
    ps(`try{Unregister-ScheduledTask -TaskName ${quote(name)} -Confirm:$false -ErrorAction Stop}catch{if($_.Exception.HResult -ne -2147024894){throw}}`);
  }
});
