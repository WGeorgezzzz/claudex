import { withUserContext } from '@/modules/auth/index.js';
import { assertOwnedSession } from '@/modules/access-control/index.js';
import { monitorsDb } from '@/modules/database/index.js';
import { sessionsService, providerTokenUsageService } from '@/modules/providers/index.js';
import { connectedClients, clientUserIds } from '@/modules/websocket/index.js';
import { createNormalizedMessage } from '@/shared/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { maintainMonitorContext } from './monitor-context.service.js';
import { prepareIsolatedRound, finishMonitorReport } from './monitor-isolated.service.js';

let timer: ReturnType<typeof setInterval>|null=null;
export function shouldIsolateMonitor(runMode:unknown,contextTokens:number):boolean{return runMode!=='original'||contextTokens>120_000;}

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
    const job=Promise.resolve().then(() => withUserContext(row.user_id, async () => {
      try {
        const session=assertOwnedSession(row.user_id,row.session_id);
        if(!session || session.isArchived) {monitorsDb.pauseUnavailable(row.id);throw new Error('会话已删除或归档，监测已暂停。');}
        const requestedOriginal=JSON.parse(row.options).runMode==='original';
        const sourceUsage=requestedOriginal?await providerTokenUsageService.getSessionTokenUsage(row.session_id).catch(()=>({used:0})):null;
        const forcedIsolated=requestedOriginal&&shouldIsolateMonitor('original',sourceUsage?.used??0);
        const isolated=!requestedOriginal||forcedIsolated;
        if(forcedIsolated){
          monitorsDb.setMode(row.user_id,row.id,'isolated');
          monitorsDb.recordContext(row.user_id,row.id,{action:'isolated',beforeTokens:sourceUsage?.used,reason:'原会话超过 120000 token，保留原会话并切换独立回合'});
          const notice=createNormalizedMessage({id:'monitor-context-switch:'+runId,kind:'text',role:'assistant',provider:session.provider as LLMProvider,sessionId:row.session_id,timestamp:new Date().toISOString(),content:`监测「${row.name}」原会话上下文已超过 120000 token，本轮自动切换为独立回合以控制上下文成本。`});
          for(const client of connectedClients)if(client.readyState===1&&clientUserIds.get(client)===row.user_id)client.send(JSON.stringify(notice));
        }
        const round=await prepareIsolatedRound(row,runId,isolated);
        if(round?.skip){monitorsDb.finishNoChange(row.id,runId);return;}
        const sessionId=round?.sessionId||await maintainMonitorContext(row,runId,row.session_id);
        let finalText='';
        let providerError: string|null=null;
        let completed=false;
        let cumulativeUsage: {inputTokens?:number;outputTokens?:number;cacheReadTokens?:number;cacheCreationTokens?:number;used?:number}|undefined;
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
              if(event.text==='monitor_usage'&&event.monitorUsage&&typeof event.monitorUsage==='object'){cumulativeUsage=event.monitorUsage;monitorsDb.saveUsage(row.id,runId,cumulativeUsage);}
              if(event.kind==='text'&&event.role==='assistant'&&typeof event.content==='string')finalText=event.content;
              if(event.kind==='error')providerError=String(event.content||'模型执行失败。');
              if(event.kind==='complete') {
                completed=true;
                if(event.success===false || event.aborted || (typeof event.exitCode==='number' && event.exitCode!==0))providerError ||= '本轮执行失败或被中断。';
              }
            }
            writer.send(data);
          },
        });
        const result=await runDetachedChatTurn({sessionId,userId:row.user_id,
          content:row.consecutive_failures>0?`上次监测失败或中断，结果未确认。请先核对实际状态，避免重复执行已有副作用的操作，再继续本轮检查。此前错误：${row.last_error??'未知'}\n\n${round?.content||row.content}`:(round?.content||row.content),
          options:{...(round?.options||JSON.parse(row.options)),cloudcliMonitorId:row.id},interruptActiveRun:false},{runtime:observedRuntime});
        const failure = providerError || result.error || (!result.started ? '本轮未能启动。' : !completed ? '模型未返回完成确认。' : null);
        const current = monitorsDb.get(row.user_id, row.id);
        if(!failure)await finishMonitorReport(row,runId,sessionId,finalText,isolated,round?.fingerprint,cumulativeUsage);
        if (!isolated && !failure && current?.status === 'active') await maintainMonitorContext(current, runId, sessionId);
        monitorsDb.finish(row.id,runId,failure);
      } catch(error) {
        monitorsDb.finish(row.id,runId,(error instanceof Error?error.message:String(error)).slice(0,1000));
      }
    })).catch(error => { monitorsDb.finish(row.id,runId,String(error).slice(0,1000)); });
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
