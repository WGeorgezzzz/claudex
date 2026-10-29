import { monitorsDb, getConnection } from '@/modules/database/index.js';
import { withUserContext } from '@/modules/auth/index.js';
import type { AnyRecord } from '@/shared/types.js';

import { finishMonitorReport } from './monitor-isolated.service.js';

// Provider supervision replays this receipt after owner death. The monitor's
// running_id is the compare-and-set owner; already finalized receipts are inert.
export async function finishSupervisedMonitorRound(receipt: AnyRecord, outcome: AnyRecord): Promise<AnyRecord | null> {
  return withUserContext(receipt.row.user_id, async () => {
    const current = monitorsDb.get(receipt.row.user_id, receipt.row.id);
    if (!current || current.running_id !== receipt.runId) return null;
    const failure = outcome.providerError || (!outcome.completed ? 'Provider ended without completion confirmation.' : null);
    if (!failure) await finishMonitorReport(current, receipt.runId, receipt.sessionId, outcome.finalText || '', receipt.isolated, receipt.fingerprint, outcome.usage);
    monitorsDb.finish(current.id, receipt.runId, failure);
    return getConnection().prepare('SELECT id,report,total_tokens,status,finished_at,round_number FROM monitor_runs WHERE id=?').get(receipt.runId) as AnyRecord;
  });
}
