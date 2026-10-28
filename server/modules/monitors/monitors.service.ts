import { assertOwnedSession } from '@/modules/access-control/index.js';
import { monitorsDb, userPreferencesDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';
import { parseMonitorCalendarSchedule } from '@/shared/index.js';

/** Used by monitor HTTP routes for validation and lifecycle changes. */
export const monitorsService = {
  contextSettings(userId: number) { const prefs=userPreferencesDb.getPreferences(userId);return { threshold:Number(prefs.monitorContextThreshold??300000),percent:Number(prefs.monitorContextPercent??40) }; },
  saveContextSettings(userId: number, value: unknown, percent?:unknown) {
    if(percent!==undefined){if(typeof percent!=='number'||!Number.isFinite(percent)||percent<5||percent>80)throw new AppError('窗口比例应为 5–80%',{statusCode:400});userPreferencesDb.savePreferences(userId,{monitorContextPercent:percent});if(value===undefined)return this.contextSettings(userId);}
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1000 || value > 2000000) throw new AppError('上下文阈值应为 1000–2000000 token 的整数。', { statusCode: 400 });
    userPreferencesDb.savePreferences(userId, { monitorContextThreshold: value });
    return this.contextSettings(userId);
  },
  summaries(userId:number) {
    const sessions:Record<string,ReturnType<typeof monitorsDb.summaries>>=Object.create(null);
    for(const row of monitorsDb.summaries(userId))(sessions[row.session_id]??=[]).push(row);
    return {...sessions};
  },
  create(userId: number, input: Record<string, unknown>) {
    const sessionId=typeof input.sessionId==='string'?input.sessionId:'';
    const content=typeof input.content==='string'?input.content.trim():'';
    const name=typeof input.name==='string'?input.name.trim():'';
    const schedule=parseMonitorCalendarSchedule(input.schedule);
    const intervalMinutes=input.intervalMinutes ?? (schedule?30:undefined);
    if (!name || name.length>120 || !content || content.length>20_000 ||
      typeof intervalMinutes!=='number' || !Number.isInteger(intervalMinutes) || intervalMinutes<1 || intervalMinutes>10_080) {
      throw new AppError('请填写名称、检查内容和 1–10080 分钟的整数间隔。',{code:'INVALID_MONITOR',statusCode:400});
    }
    const session=assertOwnedSession(userId, sessionId);
    if (!session || !['claude', 'codex'].includes(session.provider) || session.isArchived) {
      throw new AppError('请选择一个未归档的 Claude 或 Codex 会话。',{code:'INVALID_MONITOR_SESSION',statusCode:400});
    }
    const options=input.options && typeof input.options==='object' && !Array.isArray(input.options)
      ? input.options as Record<string,unknown> : {};
    // Only composer choices are persisted; callers cannot override cwd/session or inject runtime control options.
    const safeOptions: Record<string,unknown>={};
    for(const key of ['model','effort']) if(typeof options[key]==='string') safeOptions[key]=options[key];
    if(['default','acceptEdits','plan','bypassPermissions'].includes(String(options.permissionMode))) safeOptions.permissionMode=options.permissionMode;
    safeOptions.permissionMode ??= 'bypassPermissions';
    if(options.runMode!==undefined){if(!['isolated','original'].includes(String(options.runMode)))throw new AppError('无效运行方式',{statusCode:400});safeOptions.runMode=options.runMode;}
    return monitorsDb.create({userId,sessionId,name,content,intervalMinutes,schedule,options:safeOptions});
  },
  list(userId: number,sessionId?: string) {if(sessionId) assertOwnedSession(userId,sessionId); return monitorsDb.list(userId,sessionId);},
  update(userId: number,id: string,input: Record<string,unknown>) {
    const row=this.require(userId,id);
    if(row.status==='stopped')throw new AppError('已停止的监测不能修改。',{code:'MONITOR_CONFLICT',statusCode:409});
    if((input.name!==undefined&&typeof input.name!=='string')||(input.content!==undefined&&typeof input.content!=='string'))throw new AppError('名称和内容必须是文字。',{code:'INVALID_MONITOR',statusCode:400});
    const name=((input.name??row.name) as string).trim();
    const content=((input.content??row.content) as string).trim();
    const intervalMinutes=input.intervalMinutes??row.interval_minutes;
    const schedule=input.schedule===undefined ? (row.schedule_json?parseMonitorCalendarSchedule(JSON.parse(row.schedule_json)):null) : parseMonitorCalendarSchedule(input.schedule);
    if(!name||name.length>120||!content||content.length>20000||typeof intervalMinutes!=='number'||!Number.isInteger(intervalMinutes)||intervalMinutes<1||intervalMinutes>10080)
      throw new AppError('名称、内容或间隔无效。',{code:'INVALID_MONITOR',statusCode:400});
    if(input.runMode!==undefined){if(!['isolated','original'].includes(String(input.runMode)))throw new AppError('无效运行方式',{statusCode:400});monitorsDb.setMode(userId,id,String(input.runMode));}
    monitorsDb.update(userId,id,{name,content,intervalMinutes,schedule});
    return this.require(userId,id);
  },
  history(userId: number,id: string) {this.require(userId,id);return monitorsDb.history(userId,id);},
  require(userId: number,id: string) {
    const row=monitorsDb.get(userId,id);
    if(!row) throw new AppError('监测任务不存在。',{code:'MONITOR_NOT_FOUND',statusCode:404});
    assertOwnedSession(userId, row.session_id);
    return row;
  },
  action(userId: number,id: string,action: unknown) {
    const row=this.require(userId,id);
    if(action!=='pause' && action!=='resume' && action!=='stop' && action!=='run-now')
      throw new AppError('无效操作。',{code:'INVALID_MONITOR_ACTION',statusCode:400});
    if(row.status==='stopped' || (action==='run-now' && (row.status!=='active'||row.running_id)))
      throw new AppError('该任务当前不能执行此操作。',{code:'MONITOR_CONFLICT',statusCode:409});
    monitorsDb.action(userId,id,action);
    return monitorsDb.get(userId,id);
  },
};
