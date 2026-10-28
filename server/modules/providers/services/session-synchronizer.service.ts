import { getCurrentUserContext, withUserContext } from '@/modules/auth/index.js';
import path from 'node:path';
import { access } from 'node:fs/promises';

import { scanStateDb, sessionsDb, getConnection } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider } from '@/shared/types.js';

type SessionSynchronizeResult = {
  processedByProvider: Record<LLMProvider, number>;
  /** Indexed sessions dropped because their transcript file no longer exists. */
  prunedOrphans: number;
  failures: string[];
};

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * Removes indexed sessions whose transcript file has disappeared from disk.
 *
 * Nothing else deletes these rows: the synchronizers only ever upsert, and the
 * watcher reacts to `add`/`change` but not `unlink`. A transcript removed by
 * hand — or written by a test run that pointed at the real `~/.claude` — left a
 * permanent sidebar entry that opened an empty "Untitled" session.
 *
 * A row is only dropped when its *containing directory* still exists. That
 * keeps an unmounted or not-yet-created home from being read as "every
 * transcript was deleted" and wiping the whole index.
 */
const pruneOrphanedSessions = async (): Promise<number> => {
  const knownDirectoryExists = new Map<string, boolean>();
  let pruned = 0;

  for (const { session_id: sessionId, jsonl_path: jsonlPath } of sessionsDb.getSessionsWithTranscriptPath()) {
    if (await pathExists(jsonlPath)) {
      continue;
    }

    const directory = path.dirname(jsonlPath);
    let directoryExists = knownDirectoryExists.get(directory);
    if (directoryExists === undefined) {
      directoryExists = await pathExists(directory);
      knownDirectoryExists.set(directory, directoryExists);
    }

    if (!directoryExists) {
      continue;
    }

    if (sessionsDb.deleteSessionById(sessionId)) {
      pruned += 1;
    }
  }

  return pruned;
};

/**
 * The scan that every `synchronizeSessions()` caller shares while it runs.
 *
 * Opening the UI fires `/api/projects` and `/api/projects/archived` at once,
 * and each used to start its own full provider scan from the same
 * `last_scanned_at` cursor: identical work over identical transcripts,
 * contending for the same synchronous SQLite writes and doubling how long the
 * sidebar sits on its loading screen. Callers that arrive while a scan is
 * already running now await that scan instead of starting another.
 */
const inFlightSynchronizations = new Map<number, Promise<SessionSynchronizeResult>>();

/**
 * Runs all provider synchronizers and updates scan_state.last_scanned_at.
 */
async function runSessionSynchronization(): Promise<SessionSynchronizeResult> {
  const lastScanAt = scanStateDb.getLastScannedAt();
  const scanBoundary = new Date();
  const processedByProvider: Record<LLMProvider, number> = {
    claude: 0,
    codex: 0,
    cursor: 0,
    opencode: 0,
    workbuddy: 0, 'deepseek-harness': 0, gemini:0,
  };
  const failures: string[] = [];

  const results = await Promise.allSettled(
    providerRegistry.listProviders().filter(provider => getCurrentUserContext()?.role !== 'member' || provider.id === 'claude' || provider.id === 'codex').map(async (provider) => ({
      provider: provider.id,
      processed: await provider.sessionSynchronizer.synchronize(lastScanAt ?? undefined),
    }))
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      processedByProvider[result.value.provider] = result.value.processed;
      continue;
    }

    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    failures.push(reason);
  }

  // Pruning is skipped after a partial sync: a provider that just failed may
  // not have re-indexed transcripts it would otherwise have re-created.
  // A passive verification copy deliberately has only selected transcripts.
  // Never interpret its incomplete filesystem as permission to delete baseline rows.
  const prunedOrphans = failures.length === 0 && process.env.CLAUDEX_PASSIVE_INSTANCE !== '1'
    ? await pruneOrphanedSessions() : 0;

  if (failures.length === 0) {
    scanStateDb.updateLastScannedAt(scanBoundary);
  } else {
    console.warn(
      `[Sessions] Skipping scan_state cursor advance because ${failures.length} provider sync(s) failed.`,
    );
  }

  return {
    processedByProvider,
    prunedOrphans,
    failures,
  };
}

/**
 * Orchestrates provider-specific session indexers and indexed-session lifecycle operations.
 */
export const sessionSynchronizerService = {
  /**
   * Scans every provider for new or changed sessions, coalescing concurrent
   * callers onto a single scan.
   */
  async synchronizeSessions(): Promise<SessionSynchronizeResult> {
    const context = getCurrentUserContext();
    if (!context) {
      const users = getConnection().prepare('SELECT id FROM users WHERE is_active=1 ORDER BY id').all() as Array<{id: number}>;
      if (users.length) {
        const combined: SessionSynchronizeResult = { processedByProvider: {claude: 0, codex: 0, cursor: 0, opencode: 0, workbuddy: 0, 'deepseek-harness': 0, gemini:0}, prunedOrphans: 0, failures: [] };
        const results = await Promise.allSettled(users.map(user => withUserContext(user.id, () => this.synchronizeSessions())));
        for (const result of results) {
          if (result.status === 'rejected') { combined.failures.push(String(result.reason)); continue; }
          for (const provider of Object.keys(combined.processedByProvider) as LLMProvider[]) combined.processedByProvider[provider] += result.value.processedByProvider[provider];
          combined.prunedOrphans += result.value.prunedOrphans;
          combined.failures.push(...result.value.failures);
        }
        return combined;
      }
    }
    const key = context?.userId ?? 0;
    const existing = inFlightSynchronizations.get(key);
    if (existing) return existing;
    const scan = runSessionSynchronization().finally(() => { inFlightSynchronizations.delete(key); });
    inFlightSynchronizations.set(key, scan);
    return scan;
  },

  /**
   * Indexes one provider artifact file without running a full provider rescan.
   */
  async synchronizeProviderFile(
    provider: LLMProvider,
    filePath: string
  ): Promise<{ provider: LLMProvider; indexed: boolean; sessionId: string | null }> {
    const resolvedProvider = providerRegistry.resolveProvider(provider);
    const sessionId = await resolvedProvider.sessionSynchronizer.synchronizeFile(filePath);
    return {
      provider,
      indexed: Boolean(sessionId),
      sessionId,
    };
  },
};
