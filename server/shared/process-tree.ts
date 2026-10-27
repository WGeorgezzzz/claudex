import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Kills a process together with everything it started.
 *
 * A force stop has to take down what the agent CLI spawned — foreground and
 * background shells, sub-agents, MCP servers — not just the CLI itself, or a
 * `sleep 600` keeps the work alive after the conversation says it stopped.
 * Windows has `taskkill /T` for the tree; elsewhere the descendants are
 * collected from `ps` and killed children-first.
 *
 * The caller decides which pid is safe to kill. A tree that contains this
 * server (Nexagent started from inside that CLI) is refused rather than
 * killed. Resolves `true` once the root pid is gone.
 */
export async function killProcessTree(pid: number, capturedDescendants?: number[]): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return false;
  }

  const descendants = capturedDescendants ?? await listDescendants(pid);
  if (descendants.includes(process.pid)) {
    console.warn(`[process-tree] Refusing to kill ${pid}: this server runs inside its tree.`);
    return false;
  }

  if (process.platform === 'win32') {
    // MSYS exec replaces an intermediate Windows process. Its children then
    // retain an exited Windows parent, so /T alone cannot reach those children.
    await run('taskkill', [...[...descendants].reverse(), pid].flatMap(id => ['/PID', String(id)]).concat(['/T', '/F']));
  } else {
    for (const child of [...descendants].reverse()) {
      try { process.kill(child, 'SIGKILL'); } catch { /* already gone */ }
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }

  // Process exit is not synchronous with the kill call.
  for (let attempt = 0; attempt < 20 && [pid, ...descendants].some(isAlive); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return ![pid, ...descendants].some(isAlive);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 10_000 }, (_error, stdout) => {
      // A tree that is already partly gone makes taskkill exit non-zero; the
      // liveness check afterwards is the real answer.
      resolve(String(stdout ?? ''));
    });
  });
}

/** Breadth-first descendants of `root`, parents before children. */
export async function listDescendants(root: number): Promise<number[]> {
  const table = process.platform === 'win32'
    ? await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
    ])
    : await run('ps', ['-A', '-o', 'pid=,ppid=']);
  let msys = '';
  if (process.platform === 'win32') {
    const candidates = [
      process.env.CLAUDE_CODE_GIT_BASH_PATH && path.resolve(path.dirname(process.env.CLAUDE_CODE_GIT_BASH_PATH), '../usr/bin/ps.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git/usr/bin/ps.exe'),
    ];
    const executable = candidates.find(candidate => candidate && existsSync(candidate));
    if (executable) msys = await run(executable, ['-W']);
  }
  return descendantsFromTables(root, table, msys);
}

/** Merge native and MSYS parent edges using WINPID, never PID/name guesses. */
export function descendantsFromTables(root: number, table: string, msys = ''): number[] {
  const childrenByParent = new Map<number, number[]>();
  const add = (pid: number, ppid: number) => {
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0 || ppid <= 0 || pid === ppid) return;
    const list = childrenByParent.get(ppid) ?? [];
    if (!list.includes(pid)) list.push(pid);
    childrenByParent.set(ppid, list);
  };
  for (const line of table.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    add(pid, ppid);
  }
  const rows = msys.split('\n').map(line => line.trim().split(/\s+/)).filter(row => /^\d+$/.test(row[0]));
  const winPids = new Map(rows.map(row => [Number(row[0]), Number(row[3])]));
  for (const row of rows) {
    const parent = winPids.get(Number(row[1]));
    if (parent) add(Number(row[3]), parent);
  }

  const result: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childrenByParent.get(current) ?? []) {
      if (child === root || result.includes(child)) continue;
      result.push(child);
      queue.push(child);
    }
  }
  return result;
}
