import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getCloudCliHomeDir, getClaudeConfigDir } from '@/shared/index.js';

/**
 * One Claude CLI process that is currently producing a response.
 *
 * `providerSessionId` is Claude's own session id, which is what the registry
 * records; callers map it onto an app session themselves.
 */
type LiveClaudeCliSession = {
  providerSessionId: string;
  startedAt: number;
};

/**
 * Claude Code keeps one file per running session here, named `<pid>.json`.
 * The directory belongs to the CLI, not to Nexagent: it is only ever read.
 */
const registryDirectory = () => path.join(getClaudeConfigDir(), 'sessions');

/**
 * Upper bound on registry files inspected per poll.
 *
 * The running-sessions endpoint is polled continuously, so a directory left
 * full of stale files by repeated crashes must not turn every poll into
 * unbounded filesystem work. Real installations hold a handful of entries.
 */
const MAX_REGISTRY_FILES = 256;

/**
 * Whether `pid` is still the process the registry recorded.
 *
 * A registry file outlives a crash, so its mere presence proves nothing. The
 * signal-0 probe answers "does this pid exist" (EPERM means it exists but is
 * owned by someone else, which still counts), and on Linux the recorded
 * `procStart` is compared against the kernel's start-time for that pid so a
 * reused pid cannot be mistaken for the original process.
 */
async function isRecordedProcessAlive(pid: number, procStart: unknown): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EPERM') {
      return false;
    }
  }

  if (process.platform !== 'linux' || typeof procStart !== 'string' || !procStart) {
    return true;
  }

  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    // The comm field is parenthesised and may itself contain spaces, so the
    // fields are counted from the last ')'. starttime is the 22nd field
    // overall, i.e. the 20th of what follows the comm field.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] === procStart;
  } catch {
    // No procfs entry means the process is gone between the two checks.
    return false;
  }
}

/** Reads one registry file, returning null for anything that is not a live busy session. */
async function readLiveBusySession(filePath: string): Promise<LiveClaudeCliSession | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    // Unreadable, half-written or malformed entries are simply not evidence
    // of a running session.
    return null;
  }

  const record = parsed as Record<string, unknown> | null;
  if (!record || typeof record !== 'object') {
    return null;
  }

  const providerSessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
  const pid = typeof record.pid === 'number' ? record.pid : NaN;
  if (!providerSessionId || !Number.isInteger(pid) || pid <= 0 || record.status !== 'busy') {
    return null;
  }

  if (!(await isRecordedProcessAlive(pid, record.procStart))) {
    return null;
  }

  const startedAt = typeof record.startedAt === 'number' ? record.startedAt : Date.now();
  return { providerSessionId, startedAt };
}

/**
 * Lists the Claude CLI sessions that are mid-turn right now.
 *
 * Used by the providers module's sessions service so the running-sessions poll
 * also reports turns driven outside Nexagent's own chat runs — including the
 * `claude` processes Nexagent itself spawns for the Shell view, which live in
 * the PTY map rather than the chat-run registry. Liveness is ephemeral, so it
 * is recomputed on every read instead of being cached or persisted.
 */
export async function listBusyClaudeCliSessions(): Promise<LiveClaudeCliSession[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(registryDirectory());
  } catch {
    // No registry directory at all is the normal case for an install that has
    // never run the CLI, and an unreadable one is not worth failing a poll for.
    return [];
  }

  const registryFiles = entries.filter((entry) => entry.endsWith('.json')).slice(0, MAX_REGISTRY_FILES);
  const sessions = await Promise.all(
    registryFiles.map((entry) => readLiveBusySession(path.join(registryDirectory(), entry))),
  );

  return sessions.filter((session): session is LiveClaudeCliSession => session !== null);
}

/**
 * Pids of every live Claude CLI process the registry ties to one Claude
 * session, busy or idle — what a force stop has to kill. Covers both the
 * processes Nexagent spawned through the SDK and a CLI the user runs in a
 * terminal, which Nexagent can otherwise only report, not stop.
 */
export async function findClaudeCliProcessIds(providerSessionId: string): Promise<number[]> {
  const pids = new Set<number>();
  for (const directory of new Set([registryDirectory(), path.join(os.homedir(), '.claude', 'sessions'), process.env.CLAUDE_CONFIG_DIR && path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions')].filter(Boolean) as string[])) {
    for (const entry of (await fsp.readdir(directory).catch(() => [] )).filter(name => name.endsWith('.json')).slice(0, MAX_REGISTRY_FILES)) {
      try {
        const record = JSON.parse(await fsp.readFile(path.join(directory, entry), 'utf8'));
        if (providerSessionId && record.sessionId === providerSessionId && Number.isInteger(record.pid) && record.pid > 0 && await isRecordedProcessAlive(record.pid, record.procStart)) pids.add(record.pid);
      } catch { /* stale registry */ }
    }
  }
  for (const row of await findResumedProviderProcesses(providerSessionId, 'claude')) pids.add(row.pid);
  return [...pids];
}

let processTableCache: { at: number; pending: Promise<string> } | undefined;
let parsedProcessTable: { text: string; rows: ProcessRow[] } | undefined;
const registrySnapshots = new WeakMap<Promise<string>, Map<string, Promise<Array<{ pid: number; provider: string; sessionIds?: string[]; startedAt: number }>>>>();
const providerCandidates = new WeakMap<Promise<string>, Map<string, ProcessRow[]>>();

type ProcessRow = { pid: number; ppid: number; name: string; command: string; startedAt?: number };
/** Providers uses exact native IDs and executable names to find recoverable CLI orphans without touching unrelated agents. */
export async function findResumedProviderProcesses(id: string, provider: string): Promise<ProcessRow[]> {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return [];
  if (!processTableCache || Date.now() - processTableCache.at > 3000) processTableCache = { at: Date.now(), pending: new Promise<string>(resolve => execFile(process.platform === 'win32' ? 'powershell.exe' : 'ps', process.platform === 'win32' ? [
    '-NoProfile', '-NonInteractive', '-Command',
    "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'claude|codex|node' } | ForEach-Object { @{pid=$_.ProcessId;ppid=$_.ParentProcessId;name=$_.Name;command=$_.CommandLine;startedAt=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()} }) | ConvertTo-Json -Compress"
  ] : ['-A', '-o', 'pid=,ppid=,comm=,args='], {windowsHide:true,timeout:15000,maxBuffer:4*1024*1024}, (_error, stdout) => resolve(String(stdout || '')))) };
  const snapshot = processTableCache.pending;
  const table = await snapshot;
  let rows: ProcessRow[] = [];
  try {
    if (parsedProcessTable?.text === table) rows = parsedProcessTable.rows;
    else {
    const parsed = process.platform === 'win32' ? JSON.parse(table || '[]') : table.trim().split('\n').map(line => { const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/); return m ? {pid:Number(m[1]),ppid:Number(m[2]),name:m[3],command:m[4]} : null; }).filter(Boolean);
    rows = Array.isArray(parsed) ? parsed : [parsed];
    parsedProcessTable = { text: table, rows };
    }
  } catch { return []; }
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const resume = new RegExp('(?:--resume(?:=|\\s+)|resume\\s+)["\\s]*' + escaped + '(?=["\\s]|$)', 'i');
  const registered = new Set<number>();
  const directory = path.join(getCloudCliHomeDir(), 'provider-processes');
  let registries = registrySnapshots.get(snapshot);
  if (!registries) { registries = new Map(); registrySnapshots.set(snapshot, registries); }
  let records = registries.get(directory);
  if (!records) {
    records = (async () => {
      const files = (await fsp.readdir(directory).catch(() => [])).slice(0, MAX_REGISTRY_FILES);
      const values = await Promise.all(files.map(async file => {
        try { return JSON.parse(await fsp.readFile(path.join(directory, file), 'utf8')); }
        catch { return null; }
      }));
      return values.filter(value => value && typeof value === 'object');
    })();
    registries.set(directory, records);
  }
  // One registry read per process-table snapshot, shared by every historical
  // session lookup. Keep the existing three-second process freshness bound.
  for (const record of await records) {
    try {
      const row = rows.find(item => item.pid === record.pid);
      if (record.provider === provider && record.sessionIds?.includes(id) && row && row.startedAt && Math.abs(row.startedAt - record.startedAt) < 10000) registered.add(row.pid);
    } catch { /* stale record is never enough to kill a reused pid */ }
  }
  let candidatesByProvider = providerCandidates.get(snapshot);
  if (!candidatesByProvider) { candidatesByProvider = new Map(); providerCandidates.set(snapshot, candidatesByProvider); }
  let candidates = candidatesByProvider.get(provider);
  if (!candidates) {
    const executable = new RegExp(provider, 'i');
    candidates = rows.filter(row => row.pid !== process.pid && row.command && executable.test(row.name + ' ' + row.command.split(' ').slice(0, 3).join(' ')));
    candidatesByProvider.set(provider, candidates);
  }
  return candidates.filter(row => resume.test(row.command) || registered.has(row.pid));
}
