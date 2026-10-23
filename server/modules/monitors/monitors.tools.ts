import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { sessionsDb } from '@/modules/database/index.js';
import { monitorsService } from '@/modules/monitors/monitors.service.js';
import type { ProviderRuntimeContext } from '@/shared/types.js';
import { parseMonitorCalendarSchedule } from '@/shared/index.js';

const shape={
  action:z.enum(['list','create','update','pause','resume','stop','run_now','history']),
  id:z.string().optional().describe('Existing monitor id returned by list/create. Required except for list/create.'),
  name:z.string().min(1).max(120).optional(),
  content:z.string().min(1).max(20000).optional().describe('Instructions for each check, including scope, reporting rule and stop condition requested by the user.'),
  intervalMinutes:z.number().int().min(1).max(10080).optional().describe('Minutes after each completed check. Required for interval scheduling.'),
  schedule:z.discriminatedUnion('frequency',[
    z.object({frequency:z.literal('daily'),time:z.string(),timeZone:z.string()}).strict(),
    z.object({frequency:z.literal('weekly'),time:z.string(),timeZone:z.string(),weekdays:z.array(z.number().int().min(1).max(7)).min(1).max(7)}).strict(),
  ]).nullable().optional().describe('Calendar time HH:mm with explicit IANA timeZone. Weekly ISO weekdays: Monday=1, Sunday=7. Null switches back to interval scheduling.'),
};
type ToolContext={userId:number;sessionId:string;monitorId?:string;model?:string;effort?:string;permissionMode?:string;readOnly?:boolean};

function visible(row:ReturnType<typeof monitorsService.require>) {
  return {id:row.id,name:row.name,content:row.content,intervalMinutes:row.interval_minutes,status:row.status,
    schedule:row.schedule_json?JSON.parse(row.schedule_json):null,permissionMode:JSON.parse(row.options).permissionMode??'default',
    running:Boolean(row.running_id),nextRunAt:row.status==='active'?row.next_run_at:null,runCount:row.run_count,lastError:row.last_error,
    consecutiveFailures:row.consecutive_failures,autoRetry:row.status==='active'&&row.consecutive_failures>0,pauseReason:row.pause_reason};
}

/** Used by the MCP adapter and scope/lifecycle tests; does not accept credentials or session overrides. */
export function executeMonitorTool(context:ToolContext,input:unknown): unknown {
  const args=z.object(shape).strict().parse(input);
  const session=sessionsDb.getSessionById(context.sessionId);
  if(!session||session.provider!=='claude'||!Number.isInteger(context.userId))throw new Error('当前 Claude 会话或用户无效。');
  if(context.readOnly&&!['list','history'].includes(args.action))throw new Error('转发、委派回报和规划回合只能查看监测；修改调度需要用户在普通回合中明确提出。');
  // Scheduled turns may inspect/stop themselves but cannot broaden their own schedule.
  if(context.monitorId && !['list','history','pause','stop'].includes(args.action))
    throw new Error('自动监测期间只能查看、暂停或停止自身任务；创建或修改请由用户在聊天中提出。');
  if(args.action==='list')return {monitors:monitorsService.list(context.userId,context.sessionId)
    .filter(row=>!context.monitorId||row.id===context.monitorId).map(visible)};
  if(args.action==='create') {
    const schedule=parseMonitorCalendarSchedule(args.schedule);
    if(!args.name||!args.content||(!args.intervalMinutes&&!schedule))throw new Error('创建必须提供名称、检查内容，以及间隔或日历规则。');
    const scheduleJson=schedule?JSON.stringify(schedule):null;
    const duplicate=monitorsService.list(context.userId,context.sessionId).find(row=>row.status!=='stopped'&&row.name===args.name!.trim()&&row.content===args.content!.trim()&&row.schedule_json===scheduleJson&&(schedule||row.interval_minutes===args.intervalMinutes));
    if(duplicate)return {monitor:visible(duplicate),reused:true};
    const row=monitorsService.create(context.userId,{sessionId:context.sessionId,name:args.name,content:args.content,intervalMinutes:args.intervalMinutes,schedule,
      options:{model:session.model||context.model,effort:session.effort||context.effort,permissionMode: context.permissionMode || 'default'}});
    return {monitor:visible(row),reused:false,permissionMode:JSON.parse(row.options).permissionMode,note:'已保存到本地调度器。权限沿用创建时的会话设置。电脑和本地服务需运行，关闭聊天页面不影响调度。'};
  }
  const id=args.id||context.monitorId;
  if(!id)throw new Error('请先列出监测并提供确切任务 id。');
  const row=monitorsService.require(context.userId,id);
  if(row.session_id!==context.sessionId||(context.monitorId&&id!==context.monitorId))throw new Error('只能管理当前会话范围内的监测。');
  if(args.action==='history')return {id,runs:monitorsService.history(context.userId,id)};
  if(args.action==='update')return {monitor:visible(monitorsService.update(context.userId,id,args))};
  return {monitor:visible(monitorsService.action(context.userId,id,args.action==='run_now'?'run-now':args.action)!),note:'暂停或停止不会强制中断已开始的一轮。'};
}

const instructions=`Nexcode 的定期监测由 cloudcli_monitor MCP 工具持久保存。
用户要求定期检查、持续监测、创建/修改/暂停/恢复/停止监测时，优先调用此工具，不要用临时 CronCreate、sleep 循环、后台 shell 或口头承诺代替。
只在用户明确要求时创建或修改。间隔或检查对象不明确时先询问。已有任务先 list，使用返回的 id；不得猜测其他会话的 id。
只有工具返回成功才说已创建或已修改，告知名称、调度规则、状态和下次时间。nextRunAt 是 UTC，按日历规则的 timeZone 或用户本地时区描述。
每天/每周固定时间使用 schedule，必须明确 IANA 时区，不用服务器时区猜测用户时区。间隔使用 intervalMinutes。日历规则错过后最多执行一次；恢复按下一个未来时刻，不追补多轮。夏令时不存在的时间跳过，重复时间只取第一次。
任务保存在本机服务，关闭聊天页面仍有效；电脑和服务必须运行。忙时等待，失败保留记录并按 1、2、4、8、16、30 分钟退避重试。服务重启后已启用的监测自动恢复；上一轮结果未确认时先核对实际状态，避免重复副作用。用户手动暂停/停止仍保持，不自行恢复。聊天创建的监测沿用创建时用户选择的权限模式；不得自行提升权限。
监测执行中若用户设定的完成/停止条件已满足，可用 stop 停止自身任务；不要创建新的监测。`;

/** Providers binds this factory to an authenticated Claude turn's actual user/session. */
export function createMonitorQuery(context:ToolContext): NonNullable<ProviderRuntimeContext['createQuery']> {
  return ({prompt,options})=>{
    const server=createSdkMcpServer({name:'cloudcli_monitor',version:'1.0.0',instructions,alwaysLoad:true,
      tools:[tool('monitor','创建、列出、修改、暂停、恢复、停止当前会话的持久定期监测，或查看运行记录。根据用户明确要求操作。',shape,async args=>{
        try{return {content:[{type:'text' as const,text:JSON.stringify(executeMonitorTool(context,args))}]};}
        catch(error){return {isError:true,content:[{type:'text' as const,text:error instanceof Error?error.message:String(error)}]};}
      },{alwaysLoad:true})]});
    const previousPrompt=options.systemPrompt;
    const appended=typeof previousPrompt==='string'?previousPrompt+'\n'+instructions:
      {...(previousPrompt||{type:'preset',preset:'claude_code'}),append:[previousPrompt?.append,instructions].filter(Boolean).join('\n')};
    return query({prompt:prompt as AsyncIterable<SDKUserMessage>,options:{...options,
      systemPrompt:appended,mcpServers:{...(options.mcpServers??{}),cloudcli_monitor:server}} as Options});
  };
}
