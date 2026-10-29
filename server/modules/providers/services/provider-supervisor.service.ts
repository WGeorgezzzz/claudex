import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Runtime adapters and restart recovery use this disk-backed boundary. The
// worker, never the web server, owns provider stdin, stdout and SDK state.
export class DurableProvider {
  constructor(readonly directory: string) {}

  static async start(root: string, spec: Record<string, unknown>, env = process.env): Promise<DurableProvider> {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = path.join(root, crypto.randomUUID());
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'launch.json'), JSON.stringify(spec), { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(directory, 'token'), crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    const worker = fileURLToPath(new URL('./provider-supervisor-worker.js', import.meta.url));
    const log = fs.openSync(path.join(directory, 'worker.log'), 'a', 0o600);
    // A detached console host avoids inheriting the server's Windows console
    // lifetime. No IPC channel or inherited pipe ties this worker to its client.
    const command = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32/conhost.exe') : process.execPath;
    const args = process.platform === 'win32' ? ['--headless', process.execPath, worker, directory] : [worker, directory];
    const child = spawn(command, args, { detached: true, windowsHide: true, stdio: ['ignore', log, log], env });
    let spawnError: Error | undefined;
    child.on('error', error => { spawnError = error; });
    child.unref();
    fs.closeSync(log);
    const client = new DurableProvider(directory);
    for (let attempt = 0; attempt < 300; attempt++) {
      if (spawnError) throw spawnError;
      if (fs.existsSync(path.join(directory, 'registry.json'))) return client;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Provider supervisor failed to start; retained diagnostics: ${directory}`);
  }

  registry(): Record<string, any> {
    return JSON.parse(fs.readFileSync(path.join(this.directory, 'registry.json'), 'utf8'));
  }

  async control(operation: Record<string, unknown>): Promise<any> {
    const record = this.registry();
    const token = fs.readFileSync(path.join(this.directory, 'token'), 'utf8');
    const response = await fetch(`http://127.0.0.1:${record.port}/control`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(operation), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Supervisor control rejected (${response.status}): ${await response.text()}`);
    return response.json();
  }

  // Authentication to the recorded endpoint defeats stale/reused PID adoption.
  async identity(): Promise<boolean> {
    try { return (await this.control({ type: 'identity' })).id === path.basename(this.directory); }
    catch { return false; }
  }

  // Cursor advances only after the consumer successfully handles an event.
  // A crash can replay the last event; consumers must deduplicate by run+seq.
  async *events(offset = 0): AsyncGenerator<{ offset: number; event: Record<string, any> }> {
    const file = path.join(this.directory, 'output.ndjson');
    for (;;) {
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(256 * 1024);
      let count: number;
      try { count = fs.readSync(fd, buffer, 0, buffer.length, offset); }
      finally { fs.closeSync(fd); }
      const lastNewline = buffer.subarray(0, count).lastIndexOf(10);
      if (lastNewline >= 0) {
        for (const line of buffer.subarray(0, lastNewline + 1).toString('utf8').split('\n').filter(Boolean)) {
          const event = JSON.parse(line);
          offset += Buffer.byteLength(line) + 1;
          yield { offset, event };
          if (event.kind === 'exit') return;
        }
      } else if (count === buffer.length) {
        throw new Error('Supervisor journal record exceeds read bound');
      }
      const record = this.registry();
      if (count === 0 && record.state !== 'running') return;
      if (count === 0 && !(await this.identity())) throw new Error('Supervisor unavailable; output retained, adoption failed');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
