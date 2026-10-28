import { randomUUID } from 'node:crypto';

import { monitorsDb, userPreferencesDb } from '@/modules/database/index.js';
import { providerTokenUsageService } from '@/modules/providers/index.js';
import { sessionBridgeService } from '@/modules/session-bridge/index.js';
import type { MonitorRecord } from '@/shared/types.js';

/** Dispatcher checks actual transcript usage before/after each monitor run and retains the old conversation. */
export async function maintainMonitorContext(row: MonitorRecord, runId: string, sessionId: string): Promise<string> {
  const configured = Number(userPreferencesDb.getPreferences(row.user_id).monitorContextThreshold ?? 300000);
  const threshold = Number.isFinite(configured) && configured >= 1000 ? configured : 300000;
  let before: number;
  try { before = (await providerTokenUsageService.getSessionTokenUsage(sessionId)).used; }
  catch { return sessionId; } // A session that has not run yet has no usage record.
  if (before < threshold) return sessionId;
  const started = Date.now();
  let reason = '';
  try {
    const receipt = sessionBridgeService.compact(row.user_id, sessionId, { requestId: 'monitor-compact:' + randomUUID(), instruction: '保留监测说明、最近结论和任务文件路径。' });
    const result = await sessionBridgeService.wait(row.user_id, { receiptIds: [receipt.id], timeoutSec: 300 });
    if (result.timedOut) throw new Error('CONTEXT_COMPACT_PENDING');
    if (result.receipts[0]?.status !== 'succeeded') throw new Error(result.receipts[0]?.error || 'Native compact failed');
    const after = await providerTokenUsageService.getSessionTokenUsage(sessionId).then(usage => usage.used).catch(() => null);
    if(after===null || after>=before)throw new Error('原生压缩未降低当前上下文，改为保留旧会话并交接。');
    monitorsDb.recordContext(row.user_id, row.id, { action: 'compact', beforeTokens: before, afterTokens: after, durationMs: Date.now() - started, sessionId });
    return sessionId;
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
    // A command with an uncertain completion must settle before a replacement is allowed.
    if (reason === 'CONTEXT_COMPACT_PENDING') throw error;
  }
  const history = await sessionBridgeService.read(sessionId, 0, row.user_id);
  const options = JSON.parse(row.options);
  const summary = history.messages.slice(-12).map(message => `${message.role}: ${message.content}`).join('\n').slice(-10000);
  const next = sessionBridgeService.create(row.user_id, sessionId, {
    requestId: 'monitor-handoff:' + randomUUID(), provider: history.provider as 'claude' | 'codex', cwd: history.projectPath || undefined,
    model: options.model || history.model || undefined, effort: options.effort || history.effort || undefined, title: row.name + ' · 接续',
    prompt: `自动监测上下文交接。监测 ID：${row.id}；本轮先接收交接，不执行新的工作。\n监测说明：${row.content}\n项目任务活文件：${history.projectPath}/.taskmaster/tasks/tasks.json\n最近汇报（仅供参考）：\n${summary}\n请确认交接完成。`,
  }, options.permissionMode || 'default');
  const handed = await sessionBridgeService.wait(row.user_id, { receiptIds: [next.receipt.id], timeoutSec: 300 });
  if (handed.timedOut || handed.receipts[0]?.status !== 'succeeded') {
    monitorsDb.recordContext(row.user_id, row.id, { action: 'migration-failed', beforeTokens: before, newSessionId: next.sessionId, reason, durationMs: Date.now() - started });
    throw new Error('上下文交接未成功，保留原监测和两个会话，请查看运行记录。');
  }
  monitorsDb.migrateSession(row.user_id, row.id, runId, sessionId, next.sessionId);
  const after = await providerTokenUsageService.getSessionTokenUsage(next.sessionId).then(usage => usage.used).catch(() => null);
  monitorsDb.recordContext(row.user_id, row.id, { action: 'migrated', beforeTokens: before, afterTokens: after, previousSessionId: sessionId, sessionId: next.sessionId, reason, durationMs: Date.now() - started });
  return next.sessionId;
}
