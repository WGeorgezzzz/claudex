import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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
    let worker = fileURLToPath(new URL('./provider-supervisor-worker.js', import.meta.url));
    const runtimeArguments: string[] = [];
    if (!fs.existsSync(worker)) {
      worker = fileURLToPath(new URL('./provider-supervisor-worker.ts', import.meta.url));
      runtimeArguments.push(createRequire(import.meta.url).resolve('tsx/cli'), '--tsconfig', fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)));
    }
    runtimeArguments.push(worker, directory);
    const log = fs.openSync(path.join(directory, 'worker.log'), 'a', 0o600);
    // Windows Task Scheduler is a broker: a separate task owns the supervisor,
    // so stopping the web server's task/job cannot terminate its provider tree.
    // conhost alone and detached:true do not establish that ownership boundary.
    const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const command = process.platform === 'win32' ? powershell : process.execPath;
    const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    env = { ...env, NEXAGENT_PROVIDER_WORKER: '1' };
    const environmentFile = path.join(directory, 'environment.json');
    const taskName = 'Nexagent-Provider-' + path.basename(directory);
    if (process.platform === 'win32') fs.writeFileSync(environmentFile, JSON.stringify(env), { mode: 0o600 });
    const launchFile = path.join(directory, 'launch.ps1');
    const brokerFile = path.join(directory, 'broker.ps1');
    const registrationFile = path.join(directory, 'register.ps1');
    // Windows PowerShell 5 wraps native stderr as NativeCommandError. Stop
    // would terminate the redirected pipeline (and Node) on an SDK warning.
    // Keep setup fail-fast, then let Node's exit code own the native boundary.
    const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$e=Get-Content -Raw -Encoding UTF8 -LiteralPath ${quote(environmentFile)}|ConvertFrom-Json;foreach($p in $e.PSObject.Properties){[Environment]::SetEnvironmentVariable($p.Name,[string]$p.Value,'Process')};Remove-Item -LiteralPath ${quote(environmentFile)};$ErrorActionPreference='Continue';& ${quote(process.execPath)} ${runtimeArguments.map(quote).join(' ')} *>> ${quote(path.join(directory, 'worker.log'))};exit $LASTEXITCODE`;
    // File arguments keep the command line bounded even for long/non-ASCII
    // account roots. A BOM makes Windows PowerShell 5 read UTF-8 script text.
    const broker = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$b=${quote(path.join(directory,'broker.log'))};function Log($m){Add-Content -Encoding UTF8 -LiteralPath $b -Value ((Get-Date).ToString('o')+' '+$m)};Log ('start '+$PID);try{Start-Process -WindowStyle Hidden -FilePath ${quote(path.join(process.env.SystemRoot || 'C:/Windows','System32/conhost.exe'))} -ArgumentList @('--headless',${quote(powershell)},'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${quote('"'+launchFile+'"')});$r=${quote(path.join(directory,'registry.json'))};for($i=0;$i -lt 300 -and -not(Test-Path -LiteralPath $r);$i++){Start-Sleep -Milliseconds 100};$workerId=(Get-Content -Raw -Encoding UTF8 -LiteralPath $r|ConvertFrom-Json).pid;Log ('wait '+$workerId);$p=[Diagnostics.Process]::GetProcessById($workerId);$h=$p.Handle;$p.WaitForExit();Log ('exit '+$p.ExitCode)}catch{Log $_.Exception.Message;throw}finally{Log 'cleanup';Unregister-ScheduledTask -TaskName ${quote(taskName)} -Confirm:$false -ErrorAction SilentlyContinue}`;
    const taskArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+brokerFile+'"';
    const bootstrap = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$a=New-ScheduledTaskAction -Execute ${quote(powershell)} -Argument ${quote(taskArguments)};Register-ScheduledTask -TaskName ${quote(taskName)} -Action $a -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden) | Out-Null;Start-ScheduledTask -TaskName ${quote(taskName)}`;
    if(process.platform === 'win32') for(const [file,text] of [[launchFile,script],[brokerFile,broker],[registrationFile,bootstrap]]) fs.writeFileSync(file, '\uFEFF'+text, {mode:0o600});
    const args = process.platform === 'win32' ? ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',registrationFile] : runtimeArguments;
    const child = spawn(command, args, { detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', log, log], env });
    let spawnError: Error | undefined;
    child.on('error', error => { spawnError = error; });
    child.unref();
    fs.closeSync(log);
    const client = new DurableProvider(directory);
    for (let attempt = 0; attempt < 300; attempt++) {
      if (spawnError) throw spawnError;
      if (fs.existsSync(path.join(directory, 'registry.json')) && client.registry().state !== 'starting') return client;
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
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid journal cursor');
    const file = path.join(this.directory, 'output.ndjson');
    let readOffset = offset;
    let pending = Buffer.alloc(0);
    for (;;) {
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(256 * 1024);
      let count: number;
      try { count = fs.readSync(fd, buffer, 0, buffer.length, readOffset); }
      finally { fs.closeSync(fd); }
      readOffset += count;
      pending = Buffer.concat([pending, buffer.subarray(0, count)]);
      let newline: number;
      while ((newline = pending.indexOf(10)) >= 0) {
        const event = JSON.parse(pending.subarray(0, newline).toString('utf8'));
        pending = pending.subarray(newline + 1);
        offset += newline + 1;
        yield { offset, event };
        if (event.kind === 'exit') return;
      }
      const record = this.registry();
      if (count === 0 && record.state !== 'running') {
        if (pending.length) throw new Error('Incomplete supervisor journal; output retained');
        return;
      }
      if (count === 0 && !(await this.identity())) throw new Error('Supervisor unavailable; output retained, adoption failed');
      if (count < buffer.length) await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
