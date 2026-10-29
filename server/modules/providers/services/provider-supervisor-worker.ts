import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const directory = process.argv[2];
const spec = JSON.parse(fs.readFileSync(path.join(directory, 'launch.json'), 'utf8'));
const token = fs.readFileSync(path.join(directory, 'token'), 'utf8');
const journal = fs.openSync(path.join(directory, 'output.ndjson'), 'ax', 0o600);
let sequence = 0;
let terminal = false;
let record: Record<string, unknown> = { version: 1, id: path.basename(directory), pid: process.pid,
  startedAt: new Date().toISOString(), state: 'starting', metadata: spec.metadata || {} };
const save = () => {
  const file = path.join(directory, 'registry.json');
  const fd = fs.openSync(file + '.tmp', 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // Windows readers/antivirus can briefly deny replacement despite an atomic
  // rename being valid. Keep the old durable registry until replacement wins.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(file + '.tmp', file); break; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '') || attempt >= 100) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
};
const emit = (kind: string, data: unknown) => {
  if (terminal) return;
  fs.writeSync(journal, JSON.stringify({ seq: ++sequence, kind, data }) + '\n');
  fs.fsyncSync(journal);
  if (kind === 'message' && !(record.metadata as Record<string, unknown>).formerlyRunning && ['text', 'tool_use', 'tool_result', 'permission_request', 'thinking'].includes(String((data as Record<string, unknown>)?.kind))) {
    record.metadata = { ...(record.metadata as object), formerlyRunning: true }; save();
  }
  if (kind === 'message' && (data as Record<string, unknown>)?.kind === 'complete') {
    record.metadata = { ...(record.metadata as object), foregroundCompleted: true }; save();
  }
};
let control: (operation: Record<string, any>) => unknown | Promise<unknown> = () => { throw new Error('Provider is starting'); };
const server = http.createServer(async (request, response) => {
  const supplied = Buffer.from(request.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    response.writeHead(403).end(); return;
  }
  if (request.method !== 'POST' || request.url !== '/control') { response.writeHead(404).end(); return; }
  let body = ''; let tooLarge = false;
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 1024 * 1024) { tooLarge = true; break; }
  }
  if (tooLarge) { response.writeHead(413).end(); return; }
  try {
    const operation = JSON.parse(body);
    const result = operation.type === 'identity' ? { id: record.id, pid: process.pid, state: record.state } : await control(operation);
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result ?? { ok: true }));
  } catch (error) { response.writeHead(400).end(String(error)); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
record.port = (server.address() as { port: number }).port;
save();
const finish = (data: unknown) => {
  if (terminal) return;
  emit('exit', data); terminal = true;
  record = { ...record, state: 'exited', endedAt: new Date().toISOString(), result: data }; save();
  fs.closeSync(journal);
  server.close();
  setTimeout(() => process.exit(0), 100).unref();
};
try {
  if (spec.mode === 'runtime') {
    const { executeSupervisedTurn } = await import('./provider-turn-worker.js');
    const result = await executeSupervisedTurn(spec, emit, handler => { control = handler; record.state = 'running'; save(); });
    finish({ code: 0, result });
  } else {
    const child = spawn(spec.command, spec.args || [], { cwd: spec.cwd, env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    record.childPid = child.pid;
    // Each journal row is bounded even when a CLI writes a huge single chunk.
    for (const name of ['stdout', 'stderr'] as const) child[name].on('data', (chunk: Buffer) => {
      for (let index = 0; index < chunk.length; index += 32768) emit(name, chunk.subarray(index, index + 32768).toString('base64'));
    });
    child.stdin.on('error', error => emit('stdin-error', error.message));
    child.on('error', error => finish({ code: null, error: error.message }));
    // close follows complete pipe draining; exit alone can lose trailing bytes.
    child.on('close', (code, signal) => finish({ code, signal }));
    control = async operation => {
      if (operation.type === 'write') {
        if (typeof operation.data !== 'string') throw new Error('data must be base64');
        await new Promise<void>((resolve, reject) => child.stdin.write(Buffer.from(operation.data, 'base64'), error => error ? reject(error) : resolve()));
      } else if (operation.type === 'end') child.stdin.end();
      else if (operation.type === 'kill') { const { killProcessTree } = await import('../../../shared/process-tree.js'); await killProcessTree(child.pid!); }
      else throw new Error('Unknown operation');
      return { ok: true };
    };
    record.state = 'running'; save();
  }
} catch (error) { finish({ code: 1, error: error instanceof Error ? error.message : String(error) }); }
