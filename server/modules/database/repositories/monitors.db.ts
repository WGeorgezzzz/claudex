import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';
import type { MonitorCalendarSchedule, MonitorProbeSpec, MonitorRecord, MonitorRunRecord } from '@/shared/types.js';
import { nextMonitorCalendarRun, compactMonitorProbeState, summarizeMonitorProbeEvent, cleanMonitorReport } from '@/shared/index.js';

/** Used by database migrations to add durable, non-destructive monitoring tables. */
export function initializeMonitorTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitors (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, session_id TEXT NOT NULL,
      name TEXT NOT NULL, content TEXT NOT NULL, options TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      next_run_at TEXT NOT NULL, running_id TEXT, run_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_monitors_due ON monitors(status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_monitors_session_running ON monitors(session_id, running_id);
    CREATE TABLE IF NOT EXISTS monitor_runs (
      id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, started_at TEXT NOT NULL,
      finished_at TEXT, status TEXT NOT NULL, error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_monitor_runs_monitor ON monitor_runs(monitor_id, started_at);
  `);
  const columns=db.prepare('PRAGMA table_info(monitors)').all() as {name:string}[];
  if(!columns.some(column=>column.name==='schedule_json')) db.exec('ALTER TABLE monitors ADD COLUMN schedule_json TEXT');
  if(!columns.some(column=>column.name==='consecutive_failures')) db.exec('ALTER TABLE monitors ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0');
  if(!columns.some(column=>column.name==='pause_reason')) db.exec('ALTER TABLE monitors ADD COLUMN pause_reason TEXT');
  if(!columns.some(column=>column.name==='state_record')) db.exec("ALTER TABLE monitors ADD COLUMN state_record TEXT NOT NULL DEFAULT ''");
  if(!columns.some(column=>column.name==='no_change_count')) db.exec("ALTER TABLE monitors ADD COLUMN no_change_count INTEGER NOT NULL DEFAULT 0");
  for(const [name,type] of Object.entries({probe_json:'TEXT',probe_state_json:'TEXT',monitor_mode:"TEXT NOT NULL DEFAULT 'scheduled'",last_event_json:'TEXT',last_probe_at:'TEXT',heartbeat_count:'INTEGER NOT NULL DEFAULT 0',model_round_count:'INTEGER NOT NULL DEFAULT 0',probe_error:'TEXT'})) if(!columns.some(c=>c.name===name)) db.exec(`ALTER TABLE monitors ADD COLUMN ${name} ${type}`);
  for(const row of db.prepare('SELECT id,probe_state_json,last_event_json FROM monitors WHERE probe_state_json IS NOT NULL OR last_event_json IS NOT NULL').all() as Array<{id:string;probe_state_json:string|null;last_event_json:string|null}>) {
    try { db.prepare('UPDATE monitors SET probe_state_json=?,last_event_json=? WHERE id=?').run(row.probe_state_json?JSON.stringify(compactMonitorProbeState(JSON.parse(row.probe_state_json))):null,row.last_event_json?JSON.stringify(summarizeMonitorProbeEvent(JSON.parse(row.last_event_json))):null,row.id); } catch { }
  }
  const runColumns=db.prepare('PRAGMA table_info(monitor_runs)').all() as {name:string}[];
  for(const [name,type] of Object.entries({session_id:'TEXT',report:'TEXT',input_tokens:'INTEGER',context_tokens:'INTEGER',output_tokens:'INTEGER',cache_read_tokens:'INTEGER',cache_creation_tokens:'INTEGER',total_tokens:'INTEGER',round_number:'INTEGER',event_type:'TEXT',prompt_evidence:'TEXT'})) if(!runColumns.some(c=>c.name===name)) db.exec(`ALTER TABLE monitor_runs ADD COLUMN ${name} ${type}`);
  // Keep a rollback copy before changing inherited Opus monitor defaults. The
  // table is durable and the INSERT is idempotent across restarts.
  db.exec(`CREATE TABLE IF NOT EXISTS monitor_model_migration_backup_20261029 (id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,options TEXT NOT NULL)`);
  db.exec(`INSERT OR IGNORE INTO monitor_model_migration_backup_20261029(id,user_id,options)
    SELECT id,user_id,options FROM monitors
    WHERE status IN ('active','paused') AND COALESCE(json_extract(options,'$.modelExplicit'),0)=0 AND session_id IN (SELECT session_id FROM sessions WHERE provider='claude') AND lower(COALESCE(json_extract(options,'$.model'),'')) IN ('opus','opus[1m]','claude-opus-5-5','claude-opus-5-5[1m]')`);
  db.exec(`UPDATE monitors SET options=json_set(options,'$.model','claude-sonnet-5-5','$.effort','medium')
    WHERE status IN ('active','paused') AND COALESCE(json_extract(options,'$.modelExplicit'),0)=0 AND session_id IN (SELECT session_id FROM sessions WHERE provider='claude') AND lower(COALESCE(json_extract(options,'$.model'),'')) IN ('opus','opus[1m]','claude-opus-5-5','claude-opus-5-5[1m]')`);
}

// Retry transport/model failures without tight loops: 1, 2, 4, 8, 16, then 30 minutes.
const retryAt = (failures: number, now: Date, error = '') => {
  // Provider session-limit errors are account-wide and retrying every 30
  // minutes only burns more quota. Keep the monitor active, show the error,
  // and wait for the provider reset window before trying again.
  const sessionLimit = /session limit|hit your session limit|usage limit|rate limit/i.test(error);
  const minutes = sessionLimit ? 120 : Math.min(30, 2 ** Math.min(5, Math.max(0, failures - 1)));
  return new Date(now.getTime() + minutes * 60_000).toISOString();
};

function nextProbeAt(row: MonitorRecord, now: Date): string {
  try {
    const probe = row.probe_json ? JSON.parse(row.probe_json) as MonitorProbeSpec : null;
    const minutes = Math.min(60, Math.max(1, Number(probe?.intervalMinutes) || 3));
    return new Date(now.getTime() + minutes * 60_000).toISOString();
  } catch {
    return new Date(now.getTime() + 3 * 60_000).toISOString();
  }
}

/** Used by the monitors module to atomically reserve runs and retain their outcomes. */
export const monitorsDb = {
  isMonitorSession(userId:number,sessionId:string) {
    return !!getConnection().prepare('SELECT 1 FROM monitor_runs r JOIN monitors m ON m.id=r.monitor_id WHERE m.user_id=? AND r.session_id=? AND (r.session_id<>m.session_id OR r.id=m.running_id) LIMIT 1').get(userId,sessionId);
  },
  attachSession(id:string,runId:string,sessionId:string) {
    getConnection().prepare('UPDATE monitor_runs SET session_id=?,round_number=(SELECT run_count+1 FROM monitors WHERE id=monitor_id) WHERE id=? AND monitor_id=?').run(sessionId,runId,id);
  },
  saveUsage(id:string,runId:string,usage:{inputTokens?:number;used?:number;outputTokens?:number;cacheReadTokens?:number;cacheCreationTokens?:number}) {
    const input=usage.inputTokens===undefined?null:Math.max(0,usage.inputTokens-(usage.cacheReadTokens??0)-(usage.cacheCreationTokens??0));
    getConnection().prepare("UPDATE monitor_runs SET input_tokens=?,output_tokens=?,cache_read_tokens=?,cache_creation_tokens=?,total_tokens=? WHERE id=? AND monitor_id=? AND status='running'")
      .run(input,usage.outputTokens??null,usage.cacheReadTokens??null,usage.cacheCreationTokens??null,usage.used??null,runId,id);
  },
  saveReport(userId:number,id:string,runId:string,report:string,state:string,usage:{inputTokens?:number;used?:number;outputTokens?:number;cacheReadTokens?:number;cacheCreationTokens?:number;contextTokens?:number},fingerprint?:string) {
    const db=getConnection();db.transaction(()=>{
      const row=this.get(userId,id);if(!row||row.running_id!==runId)throw new Error('Monitor run changed');
      const directInput=usage.inputTokens===undefined?null:Math.max(0,usage.inputTokens-(usage.cacheReadTokens??0)-(usage.cacheCreationTokens??0));
      db.prepare('UPDATE monitor_runs SET report=?,input_tokens=?,context_tokens=?,output_tokens=?,cache_read_tokens=?,cache_creation_tokens=?,total_tokens=? WHERE id=? AND monitor_id=?').run(report.slice(0,20000),directInput,usage.contextTokens??null,usage.outputTokens??null,usage.cacheReadTokens??null,usage.cacheCreationTokens??null,usage.used??null,runId,id);
      const meta=fingerprint?`\n<monitor-meta>${JSON.stringify({fingerprint,capturedAt:new Date().toISOString()})}</monitor-meta>`:'';
      const stateLimit=Math.max(0,2000-meta.length);
      db.prepare('UPDATE monitors SET state_record=? WHERE id=? AND user_id=?').run(state.slice(0,stateLimit)+meta,id,userId);
    })();
  },
  recordPromptEvidence(id:string,runId:string,eventType:string|null,promptEvidence:string): void {
    getConnection().prepare('UPDATE monitor_runs SET event_type=?,prompt_evidence=? WHERE id=? AND monitor_id=? AND status=\'running\'')
      .run(eventType, promptEvidence.slice(0, 12_000), runId, id);
  },
  reportMessages(sessionId:string) {
    const rows = getConnection().prepare(`SELECT r.id,r.report,r.session_id,COALESCE(r.finished_at,r.started_at) AS started_at,r.round_number,m.name,m.id AS monitor_id FROM monitor_runs r JOIN monitors m ON m.id=r.monitor_id JOIN sessions s ON s.session_id=m.session_id WHERE m.session_id=? AND (r.session_id<>m.session_id OR r.error LIKE '上下文维护：%') AND r.report IS NOT NULL AND s.owner_id=m.user_id ORDER BY r.started_at,r.rowid`).all(sessionId) as {id:string;report:string;session_id:string;started_at:string;name:string;monitor_id:string;round_number:number|null}[];
    return rows.map(row => ({ ...row, report: cleanMonitorReport(row.report) }));
  },
  lastModelRunAt(id:string): string|null {
    const row=getConnection().prepare("SELECT finished_at FROM monitor_runs WHERE monitor_id=? AND status IN ('succeeded','failed','interrupted') AND (error IS NULL OR (error<>'无变化，未调用模型。' AND error NOT LIKE '上下文维护：%')) ORDER BY finished_at DESC LIMIT 1").get(id) as {finished_at:string|null}|undefined;
    return row?.finished_at??null;
  },
  isRunSession(userId:number,id:string,sessionId:string) {
    return !!getConnection().prepare('SELECT 1 FROM monitor_runs r JOIN monitors m ON m.id=r.monitor_id WHERE m.id=? AND m.user_id=? AND r.id=m.running_id AND r.session_id=?').get(id,userId,sessionId);
  },
  setMode(userId:number,id:string,mode:string) {
    const row=this.get(userId,id);if(!row)return;
    getConnection().prepare('UPDATE monitors SET options=? WHERE id=? AND user_id=?').run(JSON.stringify({...JSON.parse(row.options),runMode:mode}),id,userId);
  },
  /** Monitor lifecycle records compaction receipts alongside the normal run history. */
  recordContext(userId: number, id: string, detail: Record<string, unknown>): void {
    const row=this.get(userId,id);
    if (!row) throw new Error('Monitor not found');
    const now = new Date().toISOString();
    getConnection().prepare("INSERT INTO monitor_runs(id,monitor_id,started_at,finished_at,status,error,session_id,report) VALUES(?,?,?,?,?,?,?,?)")
      .run(randomUUID(), id, now, now, detail.action === 'migration-failed' ? 'failed' : 'succeeded', '上下文维护：' + JSON.stringify(detail),row.session_id,detail.action==='isolated'?'原会话上下文超过 120000 token，监测已自动切换为独立回合，原会话保留。':null);
  },
  /** Compare the claimed run before moving its monitor; preserve all previous session IDs in options. */
  migrateSession(userId: number, id: string, runId: string, previousSessionId: string, sessionId: string): void {
    const row = this.get(userId, id);
    if (!row || row.running_id !== runId || row.session_id !== previousSessionId) throw new Error('Monitor changed during context maintenance');
    const options = JSON.parse(row.options);
    getConnection().prepare('UPDATE monitors SET session_id=?,options=? WHERE id=? AND user_id=? AND running_id=? AND session_id=?')
      .run(sessionId, JSON.stringify({ ...options, previousSessionId, previousSessionIds: [...(options.previousSessionIds || []), previousSessionId] }), id, userId, runId, previousSessionId);
  },
  create(input: { userId: number; sessionId: string; name: string; content: string; options: unknown; intervalMinutes: number; schedule?:MonitorCalendarSchedule|null; probe?:MonitorProbeSpec|null }): MonitorRecord {
    const id = randomUUID();
    const now = new Date();
    getConnection().prepare(`INSERT INTO monitors
      (id,user_id,session_id,name,content,options,interval_minutes,next_run_at,created_at,schedule_json,probe_json,monitor_mode)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.userId,input.sessionId,input.name,input.content,
      JSON.stringify(input.options),input.intervalMinutes,
      (input.schedule ? nextMonitorCalendarRun(input.schedule,now) : new Date(now.getTime()+input.intervalMinutes*60_000)).toISOString(),now.toISOString(),input.schedule?JSON.stringify(input.schedule):null,input.probe?JSON.stringify(input.probe):null,input.probe?'event':'scheduled');
    return this.get(input.userId,id)!;
  },
  get(userId: number, id: string): MonitorRecord | undefined {
    return getConnection().prepare('SELECT * FROM monitors WHERE user_id=? AND id=?').get(userId,id) as MonitorRecord | undefined;
  },
  list(userId: number, sessionId?: string, includeStopped=false): MonitorRecord[] {
    return getConnection().prepare(`SELECT * FROM monitors WHERE user_id=?${sessionId ? ' AND session_id=?' : ''}${includeStopped ? '' : " AND status IN ('active','paused')"} ORDER BY created_at DESC`)
      .all(...(sessionId ? [userId,sessionId] : [userId])) as MonitorRecord[];
  },
  summaries(userId: number) {
    return getConnection().prepare(`SELECT m.id,m.session_id,m.name,m.status,m.interval_minutes,m.schedule_json,m.next_run_at,m.running_id,m.last_error,m.consecutive_failures,
      (SELECT r.status FROM monitor_runs r WHERE r.monitor_id=m.id AND (r.error IS NULL OR r.error NOT LIKE '上下文维护：%') ORDER BY r.started_at DESC,r.rowid DESC LIMIT 1) AS last_result
      FROM monitors m JOIN sessions s ON s.session_id=m.session_id
      WHERE m.user_id=? AND s.owner_id=? AND s.isArchived=0 AND m.status<>'stopped' ORDER BY m.created_at DESC`).all(userId,userId) as {
        id:string;session_id:string;name:string;status:string;interval_minutes:number;schedule_json:string|null;next_run_at:string;running_id:string|null;last_error:string|null;consecutive_failures:number;last_result:string|null;
      }[];
  },
  due(now: Date): MonitorRecord[] {
    return getConnection().prepare(`SELECT * FROM monitors WHERE status='active' AND running_id IS NULL AND next_run_at<=? AND (monitor_mode<>'event' OR (last_event_json IS NOT NULL AND
      (COALESCE(model_round_count,0)=0 OR json_extract(last_event_json,'$.type') IN ('done','dead') OR json_extract(last_event_json,'$.evidence')='用户手动立即运行'
       OR COALESCE(julianday(json_extract(probe_state_json,'$.lastModelAt')),0)+interval_minutes/1440.0<=julianday(?)))) ORDER BY next_run_at LIMIT 20`)
      .all(now.toISOString(),now.toISOString()) as MonitorRecord[];
  },
  probeDue(now: Date): MonitorRecord[] {
    return getConnection().prepare(`SELECT * FROM monitors WHERE status='active' AND running_id IS NULL AND monitor_mode='event' AND last_event_json IS NULL
      AND (last_probe_at IS NULL OR julianday(last_probe_at)+COALESCE(NULLIF(json_extract(probe_json,'$.intervalMinutes'),0),3)/1440.0<=julianday(?))
      ORDER BY COALESCE(last_probe_at,created_at) LIMIT 32`).all(now.toISOString()) as MonitorRecord[];
  },
  markProbeGenerationFailed(id:string):void {
    getConnection().prepare("UPDATE monitors SET probe_error='Script generation failed; scheduled fallback' WHERE id=?").run(id);
  },
  setProbe(userId:number,id:string,probe:MonitorProbeSpec|null): void {
    const db=getConnection();
    db.exec('CREATE TABLE IF NOT EXISTS monitor_probe_audit (id INTEGER PRIMARY KEY,monitor_id TEXT,user_id INTEGER,changed_at TEXT,old_probe TEXT,new_probe TEXT)');
    const old=this.get(userId,id);
    if(old?.probe_json!==JSON.stringify(probe))db.prepare('INSERT INTO monitor_probe_audit(monitor_id,user_id,changed_at,old_probe,new_probe) VALUES(?,?,?,?,?)').run(id,userId,new Date().toISOString(),old?.probe_json||null,probe?JSON.stringify(probe):null);
    getConnection().prepare("UPDATE monitors SET probe_json=?,probe_state_json=NULL,monitor_mode=?,last_event_json=NULL,last_probe_at=NULL,probe_error=NULL,next_run_at=? WHERE user_id=? AND id=? AND status<>'stopped'")
      .run(probe?JSON.stringify(probe):null,probe?'event':'scheduled',new Date().toISOString(),userId,id);
  },
  setSuppressions(userId:number,id:string,suppress:string[]):void {
    getConnection().prepare("UPDATE monitors SET probe_json=json_set(probe_json,'$.suppress',json(?)) WHERE user_id=? AND id=? AND probe_json IS NOT NULL").run(JSON.stringify(suppress.slice(0,16).map(value=>value.slice(0,256))),userId,id);
  },
  saveProbeObservation(id:string,state:Record<string,unknown>,event:unknown|null,nextRunAt:Date,probeError:string|null=null,now=new Date()): void {
    const eventAt = event && typeof event === 'object' && typeof (event as {at?:unknown}).at === 'string'
      ? String((event as {at:string}).at) : null;
    getConnection().prepare('UPDATE monitors SET probe_state_json=?,last_event_json=?,last_probe_at=?,next_run_at=?,probe_error=? WHERE id=? AND status=\'active\'')
      .run(JSON.stringify(compactMonitorProbeState(state)),event?JSON.stringify(summarizeMonitorProbeEvent(event as Record<string,unknown>)):null,now.toISOString(),eventAt || nextRunAt.toISOString(),probeError,id);
  },
  recordHeartbeat(id:string,now=new Date(),message='无事件，未调用模型。'): void {
    const db=getConnection(); const row=db.prepare('SELECT user_id,session_id FROM monitors WHERE id=?').get(id) as {user_id:number;session_id:string}|undefined; if(!row)return;
    db.prepare("INSERT INTO monitor_runs(id,monitor_id,started_at,finished_at,status,report,total_tokens,session_id,event_type) VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(),id,now.toISOString(),now.toISOString(),'heartbeat',message,0,row.session_id,'heartbeat');
    db.prepare('UPDATE monitors SET heartbeat_count=heartbeat_count+1 WHERE id=?').run(id);
  },
  markModelRound(id:string): void {
    const db=getConnection(); const row=db.prepare('SELECT probe_state_json FROM monitors WHERE id=?').get(id) as {probe_state_json:string|null}|undefined;
    const state=compactMonitorProbeState(JSON.parse(row?.probe_state_json||'{}'));
    for(const value of Object.values((state.items||{}) as Record<string,Record<string,unknown>>))if(value.offset!==undefined)value.modelOffset=value.offset;
    state.lastModelAt=new Date().toISOString(); delete state.pendingEvent; delete state.pendingCounts;
    db.prepare('UPDATE monitors SET model_round_count=model_round_count+1,probe_state_json=? WHERE id=?').run(JSON.stringify(compactMonitorProbeState(state)),id);
  },
  claim(id: string, now: Date): string | null {
    const db=getConnection();
    return db.transaction(() => {
      // Calendar tasks commonly share a time. Reserve one monitor per session even before
      // the asynchronous provider startup has registered that session as running.
      if(db.prepare('SELECT 1 FROM monitors WHERE session_id=(SELECT session_id FROM monitors WHERE id=?) AND running_id IS NOT NULL LIMIT 1').get(id))return null;
      const runId=randomUUID();
      const changed=db.prepare("UPDATE monitors SET running_id=? WHERE id=? AND status='active' AND running_id IS NULL AND next_run_at<=?")
        .run(runId,id,now.toISOString());
      if (!changed.changes) return null;
      db.prepare("INSERT INTO monitor_runs(id,monitor_id,started_at,status) VALUES(?,?,?,'running')").run(runId,id,now.toISOString());
      return runId;
    })();
  },
  defer(id: string, now: Date): void {
    getConnection().prepare("UPDATE monitors SET next_run_at=?,last_error=CASE WHEN consecutive_failures=0 THEN ? ELSE last_error END WHERE id=? AND status='active' AND running_id IS NULL")
      .run(new Date(now.getTime()+30_000).toISOString(),'会话正在运行，等待空闲后检查。',id);
  },
  finish(id: string, runId: string, error: string | null, now = new Date()): void {
    const db=getConnection();
    db.transaction(() => {
      const row=db.prepare('SELECT * FROM monitors WHERE id=? AND running_id=?').get(id,runId) as MonitorRecord | undefined;
      if (!row) return;
      db.prepare("UPDATE monitor_runs SET status=?,error=?,finished_at=? WHERE id=? AND status='running'")
        .run(error ? 'failed' : 'succeeded',error,now.toISOString(),runId);
      const failures = error ? row.consecutive_failures + 1 : 0;
      const next = error ? retryAt(failures, now, error) : row.monitor_mode === 'event'
        ? nextProbeAt(row, now)
        : (row.schedule_json ? nextMonitorCalendarRun(JSON.parse(row.schedule_json),now) : new Date(now.getTime()+row.interval_minutes*60_000)).toISOString();
      db.prepare(`UPDATE monitors SET running_id=NULL,run_count=run_count+1,last_error=?,next_run_at=?,consecutive_failures=?,no_change_count=0,last_event_json=CASE WHEN ? IS NULL THEN NULL ELSE last_event_json END
        WHERE id=? AND running_id=?`).run(error,next,failures,error,id,runId);
    })();
  },
  finishNoChange(id:string,runId:string,now=new Date()): void {
    const db=getConnection();db.transaction(()=>{
      const row=db.prepare('SELECT * FROM monitors WHERE id=? AND running_id=?').get(id,runId) as (MonitorRecord&{no_change_count?:number})|undefined;
      if(!row)return;
      const count=(row.no_change_count??0)+1;
      const minutes=count>=3?60:count===2?30:15;
      const lastReal=this.lastModelRunAt(id);
      const nextAt=lastReal?Math.min(now.getTime()+minutes*60000,Math.max(now.getTime()+1000,Date.parse(lastReal)+60*60000)):now.getTime()+minutes*60000;
      db.prepare("UPDATE monitor_runs SET status='skipped',report='无变化，未调用模型',input_tokens=0,output_tokens=0,cache_read_tokens=0,cache_creation_tokens=0,total_tokens=0,context_tokens=0,error=?,finished_at=? WHERE id=? AND status='running'").run('无变化，未调用模型。',now.toISOString(),runId);
       const scheduledNext = row.monitor_mode === 'event' ? nextProbeAt(row, now) : new Date(nextAt).toISOString();
       db.prepare('UPDATE monitors SET running_id=NULL,run_count=run_count+1,last_error=?,next_run_at=?,consecutive_failures=0,no_change_count=? WHERE id=? AND running_id=?').run('无变化，未调用模型。',scheduledNext,count,id,runId);
    })();
  },
  action(userId: number,id: string,action: 'pause'|'resume'|'stop'|'run-now'): void {
    if(action==='run-now') {
      const row=this.get(userId,id);
      if(row?.monitor_mode==='event') {
        const state=JSON.parse(row.probe_state_json||'{}');
        const event={type:'heartbeat',at:new Date().toISOString(),evidence:'用户手动立即运行',delta:state.pendingDelta||'',fields:state.lastFields||{}};
        getConnection().prepare("UPDATE monitors SET last_event_json=? WHERE id=? AND user_id=? AND status='active' AND running_id IS NULL").run(JSON.stringify(event),id,userId);
      }
      getConnection().prepare("UPDATE monitors SET next_run_at=? WHERE id=? AND user_id=? AND status='active' AND running_id IS NULL")
        .run(new Date().toISOString(),id,userId);
      return;
    }
    const status=action==='pause'?'paused':action==='stop'?'stopped':'active';
    const row=this.get(userId,id),now=new Date();
    const resumeAt=action==='resume'&&row?.schedule_json ? nextMonitorCalendarRun(JSON.parse(row.schedule_json),now).toISOString() : now.toISOString();
    getConnection().prepare(`UPDATE monitors SET status=?,next_run_at=CASE WHEN ?='active' THEN ? ELSE next_run_at END,
      last_error=CASE WHEN ?='active' THEN NULL ELSE last_error END,
      consecutive_failures=CASE WHEN ?='active' THEN 0 ELSE consecutive_failures END,pause_reason=? WHERE id=? AND user_id=?`)
      .run(status,status,resumeAt,status,status,status==='active'?null:'user',id,userId);
  },
  pauseUnavailable(id: string): void {
    getConnection().prepare("UPDATE monitors SET status='paused',pause_reason='session-unavailable' WHERE id=? AND status='active'").run(id);
  },
  history(userId: number,id: string): MonitorRunRecord[] {
    const rows = getConnection().prepare(`SELECT r.* FROM monitor_runs r JOIN monitors m ON m.id=r.monitor_id
      WHERE m.id=? AND m.user_id=? ORDER BY r.started_at DESC LIMIT 50`).all(id,userId) as MonitorRunRecord[];
    return rows.map(row => ({ ...row, report: row.report == null ? row.report : cleanMonitorReport(row.report) }));
  },
  update(userId: number,id: string,input: {name:string;content:string;intervalMinutes:number;schedule:MonitorCalendarSchedule|null}): void {
    const row=this.get(userId,id);if(!row)return;
    const scheduleJson=input.schedule?JSON.stringify(input.schedule):null;
    const changed=row.schedule_json!==scheduleJson||(!input.schedule&&row.interval_minutes!==input.intervalMinutes);
    const now=new Date();
    const next=input.schedule?nextMonitorCalendarRun(input.schedule,now):new Date(now.getTime()+input.intervalMinutes*60_000);
    getConnection().prepare(`UPDATE monitors SET name=?,content=?,interval_minutes=?,
      next_run_at=CASE WHEN ? THEN ? ELSE next_run_at END,schedule_json=?
      WHERE user_id=? AND id=? AND status<>'stopped'`)
      .run(input.name,input.content,input.intervalMinutes,changed?1:0,next.toISOString(),scheduleJson,userId,id);
  },
  recover(now = new Date()): void {
    const db=getConnection();
    db.transaction(() => {
      db.prepare("UPDATE monitor_runs SET status='interrupted',finished_at=?,error=? WHERE status='running'")
        .run(now.toISOString(),'服务重启，上一轮结果未确认；保留中断记录，下一轮先核对实际状态。');
      const rows=db.prepare('SELECT * FROM monitors WHERE running_id IS NOT NULL').all() as MonitorRecord[];
      for(const row of rows) db.prepare(`UPDATE monitors SET running_id=NULL,run_count=run_count+1,consecutive_failures=consecutive_failures+1,
        next_run_at=CASE WHEN status='active' THEN ? ELSE next_run_at END,last_error=? WHERE id=?`)
        .run(retryAt(row.consecutive_failures+1,now),'服务重启，上一轮结果未确认；启用中的监测将自动重试，先核对实际状态。',row.id);
    })();
  },
};
