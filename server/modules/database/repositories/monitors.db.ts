import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';
import type { MonitorCalendarSchedule, MonitorRecord, MonitorRunRecord } from '@/shared/types.js';
import { nextMonitorCalendarRun } from '@/shared/index.js';

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
}

/** Used by the monitors module to atomically reserve runs and retain their outcomes. */
export const monitorsDb = {
  create(input: { userId: number; sessionId: string; name: string; content: string; options: unknown; intervalMinutes: number; schedule?:MonitorCalendarSchedule|null }): MonitorRecord {
    const id = randomUUID();
    const now = new Date();
    getConnection().prepare(`INSERT INTO monitors
      (id,user_id,session_id,name,content,options,interval_minutes,next_run_at,created_at,schedule_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,input.userId,input.sessionId,input.name,input.content,
      JSON.stringify(input.options),input.intervalMinutes,
      (input.schedule ? nextMonitorCalendarRun(input.schedule,now) : new Date(now.getTime()+input.intervalMinutes*60_000)).toISOString(),now.toISOString(),input.schedule?JSON.stringify(input.schedule):null);
    return this.get(input.userId,id)!;
  },
  get(userId: number, id: string): MonitorRecord | undefined {
    return getConnection().prepare('SELECT * FROM monitors WHERE user_id=? AND id=?').get(userId,id) as MonitorRecord | undefined;
  },
  list(userId: number, sessionId?: string): MonitorRecord[] {
    return getConnection().prepare(`SELECT * FROM monitors WHERE user_id=?${sessionId ? ' AND session_id=?' : ''} ORDER BY created_at DESC`)
      .all(...(sessionId ? [userId,sessionId] : [userId])) as MonitorRecord[];
  },
  due(now: Date): MonitorRecord[] {
    return getConnection().prepare("SELECT * FROM monitors WHERE status='active' AND running_id IS NULL AND next_run_at<=? ORDER BY next_run_at LIMIT 20")
      .all(now.toISOString()) as MonitorRecord[];
  },
  claim(id: string, now: Date): string | null {
    const db=getConnection();
    return db.transaction(() => {
      // Calendar tasks commonly share a time. Reserve one monitor per session even before
      // the asynchronous provider startup has registered that session as running.
      if(db.prepare('SELECT 1 FROM monitors WHERE session_id=(SELECT session_id FROM monitors WHERE id=?) AND running_id IS NOT NULL LIMIT 1').get(id))return null;
      const runId=randomUUID();
      const changed=db.prepare("UPDATE monitors SET running_id=?,last_error=NULL WHERE id=? AND status='active' AND running_id IS NULL AND next_run_at<=?")
        .run(runId,id,now.toISOString());
      if (!changed.changes) return null;
      db.prepare("INSERT INTO monitor_runs(id,monitor_id,started_at,status) VALUES(?,?,?,'running')").run(runId,id,now.toISOString());
      return runId;
    })();
  },
  defer(id: string, now: Date): void {
    getConnection().prepare("UPDATE monitors SET next_run_at=?,last_error=? WHERE id=? AND status='active' AND running_id IS NULL")
      .run(new Date(now.getTime()+30_000).toISOString(),'会话正在运行，等待空闲后检查。',id);
  },
  finish(id: string, runId: string, error: string | null, now = new Date()): void {
    const db=getConnection();
    db.transaction(() => {
      const row=db.prepare('SELECT * FROM monitors WHERE id=? AND running_id=?').get(id,runId) as MonitorRecord | undefined;
      if (!row) return;
      db.prepare("UPDATE monitor_runs SET status=?,error=?,finished_at=? WHERE id=? AND status='running'")
        .run(error ? 'failed' : 'succeeded',error,now.toISOString(),runId);
      db.prepare(`UPDATE monitors SET running_id=NULL,run_count=run_count+1,last_error=?,next_run_at=?,
        status=CASE WHEN status='active' AND ? IS NOT NULL THEN 'paused' ELSE status END WHERE id=? AND running_id=?`)
        .run(error,(row.schedule_json ? nextMonitorCalendarRun(JSON.parse(row.schedule_json),now) : new Date(now.getTime()+row.interval_minutes*60_000)).toISOString(),error,id,runId);
    })();
  },
  action(userId: number,id: string,action: 'pause'|'resume'|'stop'|'run-now'): void {
    if(action==='run-now') {
      getConnection().prepare("UPDATE monitors SET next_run_at=? WHERE id=? AND user_id=? AND status='active' AND running_id IS NULL")
        .run(new Date().toISOString(),id,userId);
      return;
    }
    const status=action==='pause'?'paused':action==='stop'?'stopped':'active';
    const row=this.get(userId,id),now=new Date();
    const resumeAt=action==='resume'&&row?.schedule_json ? nextMonitorCalendarRun(JSON.parse(row.schedule_json),now).toISOString() : now.toISOString();
    getConnection().prepare(`UPDATE monitors SET status=?,next_run_at=CASE WHEN ?='active' THEN ? ELSE next_run_at END,
      last_error=CASE WHEN ?='active' THEN NULL ELSE last_error END WHERE id=? AND user_id=?`)
      .run(status,status,resumeAt,status,id,userId);
  },
  history(userId: number,id: string): MonitorRunRecord[] {
    return getConnection().prepare(`SELECT r.* FROM monitor_runs r JOIN monitors m ON m.id=r.monitor_id
      WHERE m.id=? AND m.user_id=? ORDER BY r.started_at DESC LIMIT 50`).all(id,userId) as MonitorRunRecord[];
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
  recover(): void {
    const db=getConnection();
    db.transaction(() => {
      db.prepare("UPDATE monitor_runs SET status='interrupted',finished_at=?,error=? WHERE status='running'")
        .run(new Date().toISOString(),'服务重启，上一轮结果未确认，请检查后恢复。');
      db.prepare("UPDATE monitors SET status=CASE WHEN status='stopped' THEN 'stopped' ELSE 'paused' END,running_id=NULL,last_error=? WHERE running_id IS NOT NULL")
        .run('服务重启，上一轮结果未确认；已暂停，避免重复执行。');
    })();
  },
};
