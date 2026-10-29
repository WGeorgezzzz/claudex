import fs from 'node:fs';
import path from 'node:path';

import type { AnyRecord, LLMProvider, ProviderRuntimeWriter } from '@/shared/types.js';
import { DurableProvider } from './provider-supervisor.service.js';

// Composition/recovery can use this boundary without serializing SDK closures.
// No implicit retry is performed: adoption is deliberately separate from launch.
export async function launchSupervisedTurn(root: string, provider: LLMProvider, command: string, options: AnyRecord, writer: ProviderRuntimeWriter): Promise<DurableProvider> {
  if (!['codex', 'claude'].includes(provider)) throw new Error('Supervision currently supports Codex and Claude only');
  if (!options.sessionId || writer.userId == null) throw new Error('Supervision requires stable session and authenticated user identity');
  return DurableProvider.start(root, { mode: 'runtime', provider, command, options, userId: writer.userId,
    isWebSocketWriter: writer.isWebSocketWriter,
    metadata: { provider, sessionId: options.sessionId, userId: writer.userId, formerlyRunning: false,
      userTurn: !options.cloudcliMonitorId && !options.bridgeCompact && !options.cloudcliBridgeSourceSessionId } });
}

// Caller must restore its chat run before attaching. Terminal records are read
// from disk too, including output emitted while the caller was absent.
export async function attachSupervisedTurn(client: DurableProvider, writer: ProviderRuntimeWriter, offset = 0): Promise<void> {
  const metadata = client.registry().metadata;
  if (writer.userId == null || String(writer.userId) !== String(metadata.userId)) throw new Error('Supervisor belongs to another user');
  for await (const row of client.events(offset)) {
    if (row.event.kind === 'message') writer.send({ ...row.event.data, supervisorRunId: path.basename(client.directory), supervisorSeq: row.event.seq });
    else if (row.event.kind === 'session') writer.setSessionId?.(row.event.data);
    else if (row.event.kind === 'exit' && row.event.data.code !== 0) throw new Error(row.event.data.error || 'Supervised runtime failed');
  }
}

// Startup enumerates only records created by this supervisor, never host PIDs.
// Absence of an authenticated endpoint means failed adoption, not permission to
// kill a PID or start a fresh user task. Caller owns continuation queue policy.
export async function inspectSupervisedTurns(root: string): Promise<Array<{ client: DurableProvider; adopted: boolean; record: AnyRecord }>> {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const client = new DurableProvider(path.join(root, entry.name));
    try {
      const record = client.registry();
      if (record.version !== 1 || record.id !== entry.name) continue;
      result.push({ client, record, adopted: record.state === 'running' && await client.identity() });
    } catch { /* Incomplete launches retain diagnostics and are never auto-run. */ }
  }
  return result;
}
