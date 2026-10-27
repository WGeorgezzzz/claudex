import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { IProviderSessions, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/index.js';
import { createNormalizedMessage, getCloudCliHomeDir, readObjectRecord, sliceTailPage } from '@/shared/index.js';

/** Runtime and history share app-owned transcripts; native Harness session storage is never rewritten. */
export function deepSeekHarnessTranscriptPath(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(sessionId)) throw new Error('Invalid Harness session id');
  return path.join(getCloudCliHomeDir(), 'deepseek-harness', 'transcripts', `${sessionId}.jsonl`);
}

/** The registry translates official Harness NDJSON events into chat and persisted history messages. */
export class DeepSeekHarnessSessions implements IProviderSessions {
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[] {
    const row = readObjectRecord(raw);
    if (!row) return [];
    const base = { provider: 'deepseek-harness' as const, sessionId, id: row.uuid,
      timestamp: row.timestamp, role: row.type === 'user' ? 'user' : 'assistant' };
    if (row.type === 'user' || row.type === 'text') return [createNormalizedMessage({ ...base, kind: 'text', content: row.text || '' })];
    if (row.type === 'thinking' && row.text) return [createNormalizedMessage({ ...base, kind: 'thinking', content: row.text })];
    if (row.type === 'tool_call') return [createNormalizedMessage({ ...base, kind: 'tool_use', toolName: row.tool, toolId: row.callId, toolInput: row.input })];
    if (row.type === 'tool_result') return [createNormalizedMessage({ ...base, kind: 'tool_result', toolId: row.callId,
      content: row.result || '', toolResult: { content: row.result || '', isError: row.status === 'error' }, isError: row.status === 'error' })];
    if (row.type === 'nexagent_error') return [createNormalizedMessage({ ...base, kind: 'error', content: row.text })];
    // `final` repeats the last text event. It is a completion marker, not another assistant message.
    return [];
  }
  async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    let messages: NormalizedMessage[] = [];
    try {
      const text = await readFile(deepSeekHarnessTranscriptPath(sessionId), 'utf8');
      messages = text.split('\n').filter(Boolean).flatMap(line => {
        try { return this.normalizeMessage(JSON.parse(line), sessionId); } catch { return []; }
      });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const limit = options.limit ?? null;
    const offset = options.offset ?? 0;
    const page = sliceTailPage(messages, limit, offset);
    return { messages: page.page, total: messages.length, hasMore: page.hasMore, offset, limit };
  }
}
