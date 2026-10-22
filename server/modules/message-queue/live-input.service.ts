import { messageQueueDb } from '@/modules/database/index.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { messageQueueService } from '@/modules/message-queue/message-queue.service.js';
import { AppError } from '@/shared/index.js';

/** Authenticated queue routes use this service to persist delivery before writing to an owned Claude process. */
export function createLiveInputService(runtime=providerRuntimeService) {
  return {
    current(sessionId: string) {
      const run=chatRunRegistry.getRun(sessionId);
      if (!run || run.status!=='running' || run.provider!=='claude') throw new AppError('No active Claude turn belongs to this server. Use its original window or add a queued message.',{code:'LIVE_INPUT_UNAVAILABLE',statusCode:409});
      return {startedAt:run.startedAt};
    },
    submit(userId: number, input: Record<string,unknown>) {
      const row=messageQueueService.enqueue(userId,input,'live');
      // A transport retry returns the durable receipt even after the original run ended.
      if (row.status!=='queued') return row;
      const claimed=messageQueueDb.claim(row.id,'live');
      if (!claimed) return messageQueueDb.get(userId,row.id)!;
      try {
        const run=this.current(row.session_id);
        if (!Number.isFinite(input.expectedStartedAt) || run.startedAt!==input.expectedStartedAt) throw new Error('The active turn changed. Your addition was not sent; review and queue it instead.');
        runtime.submitLiveInput('claude',row.session_id,claimed.run_id!,row.content,result=>{
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
