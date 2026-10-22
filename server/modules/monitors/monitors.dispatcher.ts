import { monitorsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

let timer: ReturnType<typeof setInterval>|null=null;

/** Used by server startup and monitor tests; claims runs before any provider is awaited. */
export async function dispatchMonitors(runtime: ProviderRuntimeGateway,now=new Date()): Promise<number> {
  const due=monitorsDb.due(now);
  if(!due.length)return 0;
  // Include CLI sessions outside this service; a separate terminal may own the same transcript.
  const busySessions=new Set((await sessionsService.listRunningSessions()).map(session=>session.sessionId));
  const jobs: Promise<void>[]=[];
  for(const row of due) {
    if(busySessions.has(row.session_id)||chatRunRegistry.isProcessing(row.session_id)||runtime.hasBackgroundWork(row.session_id)) {
      monitorsDb.defer(row.id,now);
      continue;
    }
    const runId=monitorsDb.claim(row.id,now);
    if(!runId) continue;
    busySessions.add(row.session_id);
    const job=(async () => {
      try {
        const session=sessionsDb.getSessionById(row.session_id);
        if(!session || session.isArchived) {monitorsDb.pauseUnavailable(row.id);throw new Error('会话已删除或归档，监测已暂停。');}
        let providerError: string|null=null;
        let completed=false;
        // SDK adapters can report failure as an event without throwing. Keep the
        // normal UI stream intact while retaining that failure in the receipt.
        const observedRuntime: ProviderRuntimeGateway=Object.create(runtime);
        observedRuntime.run=async(provider,command,options,writer)=>runtime.run(provider,command,options,{
          ...writer,
          userId: writer.userId,
          isWebSocketWriter: writer.isWebSocketWriter,
          setSessionId: writer.setSessionId?.bind(writer),
          send(data) {
            if(data && typeof data==='object') {
              const event=data as Record<string,unknown>;
              if(event.kind==='error')providerError=String(event.content||'模型执行失败。');
              if(event.kind==='complete') {
                completed=true;
                if(event.success===false || event.aborted || (typeof event.exitCode==='number' && event.exitCode!==0))providerError ||= '本轮执行失败或被中断。';
              }
            }
            writer.send(data);
          },
        });
        const result=await runDetachedChatTurn({sessionId:row.session_id,userId:row.user_id,
          content:row.consecutive_failures>0?`上次监测失败或中断，结果未确认。请先核对实际状态，避免重复执行已有副作用的操作，再继续本轮检查。此前错误：${row.last_error??'未知'}\n\n${row.content}`:row.content,
          options:{...JSON.parse(row.options),cloudcliMonitorId:row.id},interruptActiveRun:false},{runtime:observedRuntime});
        monitorsDb.finish(row.id,runId,providerError || result.error || (!result.started ? '本轮未能启动。' : !completed ? '模型未返回完成确认。' : null));
      } catch(error) {
        monitorsDb.finish(row.id,runId,(error instanceof Error?error.message:String(error)).slice(0,1000));
      }
    })();
    jobs.push(job);
  }
  await Promise.all(jobs);
  return jobs.length;
}

/** Used by server startup; persistence survives UI closure and idle server restarts. */
export function initializeMonitors(runtime: ProviderRuntimeGateway): void {
  if(timer) return;
  monitorsDb.recover();
  const poll=()=>void dispatchMonitors(runtime).catch(error=>console.error('[Monitors]',error));
  timer=setInterval(poll,15_000);
  timer.unref?.();
  poll();
}

/** Used by server shutdown; it stops new dispatches without cancelling the current model turn. */
export function closeMonitors(): void {if(timer)clearInterval(timer);timer=null;}
