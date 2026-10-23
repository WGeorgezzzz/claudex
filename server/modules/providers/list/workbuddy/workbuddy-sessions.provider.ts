import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { IProviderSessions } from '@/shared/index.js';
import type { FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/index.js';
import { createNormalizedMessage, getCloudCliHomeDir, readObjectRecord, sliceTailPage } from '@/shared/index.js';

/** Runtime and history reader share the app-owned transcript path; native WorkBuddy files stay untouched. */
export function workBuddyTranscriptPath(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(sessionId)) throw new Error('Invalid WorkBuddy session id');
  return path.join(getCloudCliHomeDir(), 'workbuddy', 'transcripts', `${sessionId}.jsonl`);
}

/** Registry-owned WorkBuddy event normalization and history. Only sessions started in Claudex are indexed. */
export class WorkBuddySessionsProvider implements IProviderSessions {
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[] {
    const row = readObjectRecord(raw);
    if (!row) return [];
    const message = readObjectRecord(row.message);
    if (row.type === 'claudex_error') return [createNormalizedMessage({ kind: 'error', content: row.content, id: row.uuid, provider: 'workbuddy', sessionId, timestamp: row.__timestamp })];
    if (row.type === 'assistant' || row.type === 'user') {
      const content = Array.isArray(message?.content) ? message.content : [];
      return content.flatMap((value: unknown, index: number) => {
        const block = readObjectRecord(value);
        if (!block) return [];
        const base = { role: row.type, id: `${row.uuid || message?.id || row.id}-${index}`, provider: 'workbuddy' as const, sessionId,
          timestamp: row.__timestamp || row.timestamp, model: message?.model };
        if (block.type === 'text') return [createNormalizedMessage({ ...base, kind: 'text', content: block.text || '' })];
        if (block.type === 'thinking') return [createNormalizedMessage({ ...base, kind: 'thinking', content: block.thinking || '' })];
        if (block.type === 'tool_use') return [createNormalizedMessage({ ...base, kind: 'tool_use', toolName: block.name, toolId: block.id, toolInput: block.input })];
        if (block.type === 'tool_result') {
          const result = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
            ? block.content.map(part => readObjectRecord(part)?.text || '').join('\n') : JSON.stringify(block.content ?? '');
          return [createNormalizedMessage({ ...base, kind: 'tool_result', toolId: block.tool_use_id,
            toolResult: { content: result, isError: block.is_error === true }, isError: block.is_error === true })];
        }
        return [];
      });
    }
    return [];
  }
  async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    let messages: NormalizedMessage[] = [];
    try {
      const content = await readFile(workBuddyTranscriptPath(sessionId), 'utf8');
      messages = content.split('\n').filter(Boolean).flatMap(line => {
        try { return this.normalizeMessage(JSON.parse(line), sessionId); } catch { return []; }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const limit = options.limit ?? null;
    const offset = options.offset ?? 0;
    const page = sliceTailPage(messages, limit, offset);
    return { messages: page.page, total: messages.length, hasMore: page.hasMore, offset, limit };
  }
}
