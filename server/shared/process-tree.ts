import { execFile } from 'node:child_process';

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
export async function killProcessTree(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return false;
  }

  const descendants = await listDescendants(pid);
  if (descendants.includes(process.pid)) {
    console.warn(`[process-tree] Refusing to kill ${pid}: this server runs inside its tree.`);
    return false;
  }

  if (process.platform === 'win32') {
    await run('taskkill', ['/PID', String(pid), '/T', '/F']);
  } else {
    for (const child of [...descendants].reverse()) {
      try { process.kill(child, 'SIGKILL'); } catch { /* already gone */ }
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }

  // Process exit is not synchronous with the kill call.
  for (let attempt = 0; attempt < 20 && isAlive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
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
  const childrenByParent = new Map<number, number[]>();
  for (const line of table.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const list = childrenByParent.get(ppid) ?? [];
    list.push(pid);
    childrenByParent.set(ppid, list);
  }

  const result: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childrenByParent.get(current) ?? []) {
      if (result.includes(child)) continue;
      result.push(child);
      queue.push(child);
    }
  }
  return result;
}
