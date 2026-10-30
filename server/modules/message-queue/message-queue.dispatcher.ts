import { createHash } from 'node:crypto';

import { withUserContext } from '@/modules/auth/index.js';
import { getSessionOwnerId, messageQueueDb, sessionDraftsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { messageQueueService, notifyMessageQueueChanged, registerMessageQueueWakeup } from '@/modules/message-queue/message-queue.service.js';
import type { QueuedTurnRecord } from '@/shared/types.js';

let timer: ReturnType<typeof setTimeout>|null=null;
let activeRuntime: ProviderRuntimeGateway | null = null;
const invalidLegacy = new Set<string>();

/** Dispatcher and migration tests atomically import the old single-slot queue without losing its draft. */
export function importLegacyQueuedMessages(): void {
  for (const candidate of sessionDraftsDb.listQueuedMessages()) {
    try {
      const input=candidate.queuedMessage as {content?:unknown;options?:Record<string,unknown>;attachments?:unknown;images?:unknown}|null;
      if (!input || typeof input.content!=='string') throw new Error('Invalid legacy queue entry; original draft retained.');
      const key='legacy:'+createHash('sha256').update(`${candidate.userId}:${candidate.sessionId}:${candidate.claimToken}`).digest('hex');
      messageQueueDb.importLegacy(candidate,()=>messageQueueService.enqueue(candidate.userId,{
        sessionId:candidate.sessionId,requestId:key,content:input.content,
        options:{...input.options,attachments:input.attachments??input.images??[]},
      }));
    } catch (error) {
      const key=`${candidate.userId}:${candidate.sessionId}`;
      if (!invalidLegacy.has(key)) {
        invalidLegacy.add(key);
        console.warn('[MessageQueue] Legacy draft retained:',error instanceof Error?error.message:String(error));
      }
    }
  }
}

async function executeClaim(row: QueuedTurnRecord, runtime: ProviderRuntimeGateway): Promise<void> {
  let terminal=false, providerError: string|null=null;
  try {
    if (getSessionOwnerId(row.session_id)!==row.user_id) throw new Error('Conversation owner no longer matches queued message.');
    const session=withUserContext(row.user_id,()=>sessionsDb.getSessionById(row.session_id));
    if (!session || session.isArchived) throw new Error('Conversation was removed or archived before dispatch.');
    const observed: ProviderRuntimeGateway=Object.create(runtime);
    observed.run=async(provider,command,options,writer)=>runtime.run(provider,command,{...options,cloudcliQueueAttempt:row},{
      ...writer,
      userId:writer.userId, isWebSocketWriter:writer.isWebSocketWriter,
      setSessionId:writer.setSessionId?.bind(writer),
      send(data) {
        if (data && typeof data==='object' && !terminal) {
          const event=data as Record<string,unknown>;
          if (event.kind==='error') providerError=String(event.content||'Provider failed.').slice(0,1000);
          if (event.kind==='complete') {
            terminal=true;
            const failed=providerError || (event.success===false || (typeof event.exitCode==='number' && event.exitCode!==0) ? 'Provider reported a failed turn.' : null);
            messageQueueDb.finish(row,event.aborted?'interrupted':failed?'failed':'succeeded',
              event.aborted?'Turn was interrupted. Review before retrying.':failed);
          }
        }
        writer.send(data);
      },
    });
    const outcome=await withUserContext(row.user_id,()=>runDetachedChatTurn({
      sessionId:row.session_id,userId:row.user_id,content:row.content,
      options:JSON.parse(row.options),interruptActiveRun:false,
    },{runtime:observed}));
    if (!outcome.started && /run (?:was |is )already in progress/i.test(outcome.error||'')) {
      messageQueueDb.defer(row);
    } else if (!terminal) {
      messageQueueDb.finish(row,'failed',providerError||outcome.error||'Provider ended without a completion confirmation.');
    }
  } catch (error) {
    messageQueueDb.finish(row,'failed',(error instanceof Error?error.message:String(error)).slice(0,1000));
  } finally {
    notifyMessageQueueChanged();
    wakeMessageQueue();
  }
}

/** Startup polls this bounded pass; tests await it to verify exact outcomes and FIFO ordering. */
export async function dispatchMessageQueue(runtime: ProviderRuntimeGateway): Promise<number> {
  importLegacyQueuedMessages();
  const candidates=messageQueueDb.heads();
  if (!candidates.length) return 0;
  // Respect a CLI session owned by another server or terminal, too.
  const externalBusy=new Set((await sessionsService.listRunningSessions(true)).map(session=>session.sessionId));
  const jobs: Promise<void>[]=[];
  for (const candidate of candidates) {
    const background = runtime.hasBackgroundWork(candidate.session_id);
    // A completed local turn retains its SDK while background tasks run. New
    // ordinary turns continue through that owner, even if CLI discovery also
    // sees the held process. Foreground turns and unrelated CLI owners stay busy.
    const retainedBackground = background && chatRunRegistry.getRun(candidate.session_id)?.status === 'completed';
    if (chatRunRegistry.isProcessing(candidate.session_id)
      || (!retainedBackground && (externalBusy.has(candidate.session_id) || background))) continue;
    const row=messageQueueDb.claim(candidate.id);
    if (row) jobs.push(executeClaim(row,runtime));
  }
  await Promise.all(jobs);
  return jobs.length;
}

function scheduleDispatch(delayMs: number): void {
  if (!activeRuntime) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const runtime = activeRuntime;
    if (!runtime) return;
    // Provider turns may run for hours. Keep independent sessions progressing;
    // durable claims remain the concurrency guard used by overlapping passes.
    scheduleDispatch(messageQueueDb.heads().length > 0 ? 1000 : 30_000);
    void dispatchMessageQueue(runtime)
      .catch((error) => {
        console.error('[MessageQueue]', error);
      });
  }, delayMs);
  timer.unref?.();
}

/** Queue enqueue/settlement and session-workspace resume wake an idle dispatcher immediately. */
export function wakeMessageQueue(): void {
  if (activeRuntime) scheduleDispatch(0);
}

/** Server startup recovers uncertain attempts without replay and dispatches independently of browser tabs. */
export function initializeMessageQueue(runtime: ProviderRuntimeGateway, protectedSessions: string[] = []): void {
  if (activeRuntime) return;
  activeRuntime = runtime;
  registerMessageQueueWakeup(wakeMessageQueue);
  messageQueueDb.recover(protectedSessions);
  scheduleDispatch(0);
}

/** Server shutdown stops new claims; running work remains under its existing runtime owner. */
export function closeMessageQueue(): void {
  if (timer) clearTimeout(timer);
  timer=null;
  activeRuntime = null;
  registerMessageQueueWakeup(null);
}
