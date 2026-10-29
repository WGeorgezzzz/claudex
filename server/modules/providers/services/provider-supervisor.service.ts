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
    const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$e=Get-Content -Raw -Encoding UTF8 -LiteralPath ${quote(environmentFile)}|ConvertFrom-Json;foreach($p in $e.PSObject.Properties){[Environment]::SetEnvironmentVariable($p.Name,[string]$p.Value,'Process')};Remove-Item -LiteralPath ${quote(environmentFile)};& ${quote(process.execPath)} ${runtimeArguments.map(quote).join(' ')} *>> ${quote(path.join(directory, 'worker.log'))}`;
    // conhost can hand off its clients and return. Keep the scheduler's root
    // action waiting on the actual worker, or task completion can reap its job.
    const broker = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$b=${quote(path.join(directory, 'broker.log'))};Add-Content -LiteralPath $b -Value ('start '+$PID);try{Start-Process -WindowStyle Hidden -FilePath ${quote(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/conhost.exe'))} -ArgumentList @('--headless',${quote(powershell)},'-NoProfile','-NonInteractive','-EncodedCommand',${quote(Buffer.from(script, 'utf16le').toString('base64'))});$r=${quote(path.join(directory, 'registry.json'))};for($i=0;$i -lt 300 -and -not(Test-Path -LiteralPath $r);$i++){Start-Sleep -Milliseconds 100};$workerId=(Get-Content -Raw -Encoding UTF8 -LiteralPath $r|ConvertFrom-Json).pid;Add-Content -LiteralPath $b -Value ('wait '+$workerId);$p=[Diagnostics.Process]::GetProcessById($workerId);$h=$p.Handle;$p.WaitForExit();Add-Content -LiteralPath $b -Value ('exit '+$p.ExitCode)}catch{Add-Content -LiteralPath $b -Value $_.Exception.Message;throw}finally{Add-Content -LiteralPath $b -Value 'cleanup';Unregister-ScheduledTask -TaskName ${quote(taskName)} -Confirm:$false -ErrorAction SilentlyContinue}`;
    let taskBroker = broker;
    if (env.NEXAGENT_PROVIDER_BREAKAWAY === '1') {
      const source = 'using System;using System.Text;using System.Runtime.InteropServices;public class DetachedOwner{[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]public struct S{public int cb;public string r,d,t;public int x,y,w,h,cx,cy,f,flags;public short show,extra;public IntPtr pad,si,so,se;}[StructLayout(LayoutKind.Sequential)]public struct P{public IntPtr p,t;public int pid,tid;}[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr a,IntPtr b,bool inherit,int flags,IntPtr env,string cwd,ref S si,out P pi);[DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr h);public static int Run(string app,string args){S s=new S();s.cb=Marshal.SizeOf(s);s.flags=1;s.show=0;P p;if(!CreateProcess(app,new StringBuilder("\\\""+app+"\\\" "+args),IntPtr.Zero,IntPtr.Zero,false,0x1000210,IntPtr.Zero,null,ref s,out p))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());CloseHandle(p.p);CloseHandle(p.t);return p.pid;}}';
      const launcher = path.join(directory, 'breakaway.cs');
      fs.writeFileSync(launcher, source);
      const start = broker.indexOf('Start-Process '), end = broker.indexOf(';$r=', start);
      const launchArgs = '--headless "' + powershell + '" -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
      taskBroker = broker.slice(0, start) + 'Add-Type -Path ' + quote(launcher) + ';[DetachedOwner]::Run(' + quote(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/conhost.exe')) + ',' + quote(launchArgs) + ') | Out-Null' + broker.slice(end);
    }
    const taskArguments = `-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(taskBroker, 'utf16le').toString('base64')}`;
    const bootstrap = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$a=New-ScheduledTaskAction -Execute ${quote(powershell)} -Argument ${quote(taskArguments)};Register-ScheduledTask -TaskName ${quote(taskName)} -Action $a -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden) | Out-Null;Start-ScheduledTask -TaskName ${quote(taskName)}`;
    const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')] : runtimeArguments;
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
