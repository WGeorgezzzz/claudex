import { getSessionOwnerId, messageQueueDb } from '@/modules/database/index.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { messageQueueService } from '@/modules/message-queue/message-queue.service.js';
import { AppError } from '@/shared/index.js';
import type { LLMProvider } from '@/shared/types.js';

/** Providers whose running turn accepts inserted user messages (Claude streaming input, Codex `turn/steer`). */
const LIVE_INPUT_PROVIDERS = new Set<string>(['claude','codex']);

/** Authenticated queue routes use this service to persist delivery before writing to an owned running turn. */
export function createLiveInputService(runtime?: Pick<typeof providerRuntimeService, 'submitLiveInput'>) {
  return {
    current(sessionId: string, userId: number) {
      if (getSessionOwnerId(sessionId)!==userId) throw new AppError('Conversation belongs to another user or is unavailable.',{statusCode:403});
      const run=chatRunRegistry.getRun(sessionId);
      if (run && Number(run.writer.userId)!==userId) throw new AppError('Conversation belongs to another user or is unavailable.',{statusCode:403});
      if (!run || run.status!=='running' || !LIVE_INPUT_PROVIDERS.has(run.provider)) throw new AppError('No active turn belongs to this server. Use its original window or add a queued message.',{code:'LIVE_INPUT_UNAVAILABLE',statusCode:409});
      return {startedAt:run.startedAt,provider:run.provider as LLMProvider};
    },
    submit(userId: number, input: Record<string,unknown>) {
      const requestId=typeof input.requestId==='string'?input.requestId:'';
      // Nothing was persisted yet: report "no running turn" as a plain 409 so
      // the client can queue the draft instead. A retry of an accepted request
      // skips this and returns its durable receipt.
      if (!messageQueueDb.byRequest(userId,requestId)) this.current(typeof input.sessionId==='string'?input.sessionId:'',userId);
      const row=messageQueueService.enqueue(userId,input,'live');
      // A transport retry returns the durable receipt even after the original run ended.
      if (row.status!=='queued') return row;
      const claimed=messageQueueDb.claim(row.id,'live');
      if (!claimed) return messageQueueDb.get(userId,row.id)!;
      try {
        const run=this.current(row.session_id,userId);
        if (!Number.isFinite(input.expectedStartedAt) || run.startedAt!==input.expectedStartedAt) throw new Error('The active turn changed. Your addition was not sent; review and queue it instead.');
        // Resolve the default lazily: provider tools themselves can enqueue work.
        (runtime??providerRuntimeService).submitLiveInput(run.provider,row.session_id,claimed.run_id!,row.content,result=>{
          messageQueueDb.finish(claimed,result.status,result.error);
        });
      } catch (reason) {
        messageQueueDb.finish(claimed,'failed',reason instanceof Error?reason.message:String(reason));
      }
      return messageQueueDb.get(userId,row.id)!;
    },
  };
}

/** Message Queue routes share this production instance; tests inject only the delivery adapter. */
export const liveInputService=createLiveInputService();
