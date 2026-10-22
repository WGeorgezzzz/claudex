import type Database from 'better-sqlite3';
import { getConnection } from '@/modules/database/connection.js';
import type { SessionWorkspaceEntry } from '@/shared/types.js';

/** Database migrations install per-user organization and queue dispatch controls without touching native transcripts. */
export function initializeSessionWorkspaceTables(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_workspace (
    user_id INTEGER NOT NULL, session_id TEXT NOT NULL, pinned_at INTEGER,
    unread INTEGER NOT NULL DEFAULT 0, queue_paused INTEGER NOT NULL DEFAULT 0,
    last_activity_at TEXT, PRIMARY KEY(user_id,session_id)
  )`);
}

const selectState=`SELECT s.session_id AS sessionId, COALESCE(s.custom_name,'New conversation') AS title,
  s.provider, p.project_id AS projectId,s.project_path AS projectPath,
  w.pinned_at AS pinnedAt,COALESCE(w.unread,0) AS unread,COALESCE(w.queue_paused,0) AS queuePaused,
  w.last_activity_at AS lastActivityAt,COALESCE(q.queuedCount,0) AS queuedCount,
  COALESCE(q.runningCount,0) AS runningCount,COALESCE(q.blockedCount,0) AS blockedCount,0 AS approvalCount
  FROM sessions s LEFT JOIN projects p ON p.project_path=s.project_path
  LEFT JOIN session_workspace w ON w.session_id=s.session_id AND w.user_id=?
  LEFT JOIN (SELECT session_id,SUM(status='queued') AS queuedCount,SUM(status='running') AS runningCount,
    SUM(status IN ('failed','interrupted')) AS blockedCount FROM message_queue WHERE user_id=?
    GROUP BY session_id) q ON q.session_id=s.session_id`;
const normalize=(row:SessionWorkspaceEntry):SessionWorkspaceEntry=>({...row,unread:Boolean(row.unread),queuePaused:Boolean(row.queuePaused)});

/** Session Workspace routes, the queue scheduler, and completion events share durable user-scoped state. */
export const sessionWorkspaceDb={
  get(userId:number,sessionId:string):SessionWorkspaceEntry|undefined {
    const row=getConnection().prepare(`${selectState} WHERE s.session_id=?`).get(userId,userId,sessionId) as SessionWorkspaceEntry|undefined;
    return row?normalize(row):undefined;
  },
  list(userId:number):SessionWorkspaceEntry[] {
    return (getConnection().prepare(`${selectState} WHERE s.isArchived=0 AND
      (w.pinned_at IS NOT NULL OR w.unread=1 OR w.queue_paused=1 OR q.queuedCount>0 OR q.runningCount>0 OR q.blockedCount>0)
      ORDER BY w.pinned_at DESC,w.last_activity_at DESC,s.updated_at DESC`).all(userId,userId) as SessionWorkspaceEntry[]).map(normalize);
  },
  update(userId:number,sessionId:string,input:{pinned?:boolean;unread?:boolean;queuePaused?:boolean;readThrough?:string|null}):SessionWorkspaceEntry {
    const db=getConnection();
    db.transaction(()=>{
      db.prepare('INSERT OR IGNORE INTO session_workspace(user_id,session_id) VALUES(?,?)').run(userId,sessionId);
      if(input.pinned!==undefined)db.prepare('UPDATE session_workspace SET pinned_at=CASE WHEN ? THEN COALESCE(pinned_at,?) ELSE NULL END WHERE user_id=? AND session_id=?').run(Number(input.pinned),Date.now(),userId,sessionId);
      if(input.queuePaused!==undefined)db.prepare('UPDATE session_workspace SET queue_paused=? WHERE user_id=? AND session_id=?').run(Number(input.queuePaused),userId,sessionId);
      if(input.unread!==undefined) {
        if(input.unread===false && input.readThrough!==undefined) {
          db.prepare('UPDATE session_workspace SET unread=0 WHERE user_id=? AND session_id=? AND (last_activity_at IS NULL OR last_activity_at<=?)').run(userId,sessionId,input.readThrough??'');
        } else db.prepare('UPDATE session_workspace SET unread=? WHERE user_id=? AND session_id=?').run(Number(input.unread),userId,sessionId);
      }
    })();
    return this.get(userId,sessionId)!;
  },
  noteActivity(userId:number,sessionId:string,when=new Date().toISOString()):void {
    getConnection().prepare(`INSERT INTO session_workspace(user_id,session_id,unread,last_activity_at)
      SELECT ?,?,1,? WHERE EXISTS(SELECT 1 FROM sessions WHERE session_id=?)
      ON CONFLICT(user_id,session_id) DO UPDATE SET unread=1,last_activity_at=excluded.last_activity_at`)
      .run(userId,sessionId,when,sessionId);
  },
};
