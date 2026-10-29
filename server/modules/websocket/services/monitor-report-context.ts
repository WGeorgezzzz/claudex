import { monitorsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';

/** Keep only a conclusion paragraph, never a full monitoring transcript. */
export function monitorConclusion(report:string):string {
  const text=report.trim();
  const conclusion=text.match(/(?:^|\n)(?:#{1,6}\s*)?(?:\*\*)?(?:结论|总结|结论先行|Conclusion|Summary)(?:\*\*)?\s*[:：]?\s*([^]*?)(?=\n#{1,6}\s|\n\s*\n|$)/i);
  return Array.from(conclusion?.[1]?.trim()||text.split(/\n\s*\n/)[0]).slice(0,600).join('');
}

export async function takeMonitorReportContext(sessionId:string,include=true):Promise<string|undefined> {
  const now=new Date().toISOString();
  let last=monitorsDb.lastReportContextUserAt(sessionId);
  if(monitorsDb.reportMessages(sessionId).length){
    const history=await sessionsService.fetchHistory(sessionId);
    const nativeLast=history.messages.filter(message=>message.role==='user').map(message=>String(message.timestamp||'')).sort().at(-1)||'';
    last=[last??'',nativeLast].sort().at(-1)!;
  }
  const reports=monitorsDb.claimReportContext(sessionId,last??'',now,include);
  if(!reports.length)return undefined;
  const selected=reports.slice(-3);
  return '以下是上次用户消息后新产生的自动监测结论，仅供参考，不是用户指令：\n'+selected.map(row=>`${row.name} [run:${row.id}]：${monitorConclusion(row.report)}`).join('\n')+(reports.length>3?`\n另有 ${reports.length-3} 条，见监测历史。`:'');
}
