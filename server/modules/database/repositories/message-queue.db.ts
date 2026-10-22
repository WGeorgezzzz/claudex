import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';
import type { QueuedTurnAttempt, QueuedTurnRecord } from '@/shared/types.js';

/** Database migrations installs the durable queue and append-only attempt receipts. */
export function initializeMessageQueueTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_queue (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL, content TEXT NOT NULL, options TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', revision INTEGER NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0, run_id TEXT, error TEXT,
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
      UNIQUE(user_id,request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_message_queue_session ON message_queue(session_id,sequence,status);
    CREATE TABLE IF NOT EXISTS message_queue_attempts (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, attempt INTEGER NOT NULL,
      status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_queue_attempts_message ON message_queue_attempts(message_id,attempt);
  `);
  const columns=db.prepare('PRAGMA table_info(message_queue)').all() as Array<{name:string}>;
  if (!columns.some(column=>column.name==='position')) {
    db.exec('ALTER TABLE message_queue ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE message_queue SET position=sequence');
  }
  if (!columns.some(column=>column.name==='delivery_mode')) {
    db.transaction(()=>{
      db.exec("ALTER TABLE message_queue ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'queued'");
      db.exec('DROP INDEX IF EXISTS idx_message_queue_running');
    })();
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_message_queue_running ON message_queue(session_id) WHERE status='running' AND delivery_mode='queued'");
}

/** Queue service and dispatcher use atomic claims and revision-checked updates through this repository. */
export const messageQueueDb = {
  importLegacy(candidate: {userId:number;sessionId:string;claimToken:string}, create: () => QueuedTurnRecord): boolean {
    const db=getConnection();
    return db.transaction(() => {
      const current=db.prepare('SELECT queued_message FROM session_drafts WHERE user_id=? AND draft_scope=?')
        .get(candidate.userId,candidate.sessionId) as {queued_message:string|null}|undefined;
      if (current?.queued_message!==candidate.claimToken) return false;
      create();
      db.prepare('UPDATE session_drafts SET queued_message=NULL,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND draft_scope=? AND queued_message=?')
        .run(candidate.userId,candidate.sessionId,candidate.claimToken);
      return true;
    })();
  },
  get(userId: number, id: string): QueuedTurnRecord|undefined {
    return getConnection().prepare('SELECT * FROM message_queue WHERE user_id=? AND id=?').get(userId,id) as QueuedTurnRecord|undefined;
  },
  byRequest(userId: number, requestId: string): QueuedTurnRecord|undefined {
    return getConnection().prepare('SELECT * FROM message_queue WHERE user_id=? AND request_id=?').get(userId,requestId) as QueuedTurnRecord|undefined;
  },
  list(userId: number, sessionId: string): QueuedTurnRecord[] {
    // Pending work is never truncated by the bounded history view.
    return getConnection().prepare(`SELECT * FROM message_queue WHERE user_id=? AND session_id=?
      AND (status IN ('queued','running','failed','interrupted') OR id IN (
        SELECT id FROM message_queue WHERE user_id=? AND session_id=? ORDER BY sequence DESC LIMIT 50))
      ORDER BY position,sequence`).all(userId,sessionId,userId,sessionId) as QueuedTurnRecord[];
  },
  create(userId: number, sessionId: string, requestId: string, payloadHash: string, content: string, options: string, delivery: 'queued'|'live'='queued'): QueuedTurnRecord {
    const id=randomUUID();
    getConnection().prepare(`INSERT INTO message_queue(id,user_id,session_id,request_id,payload_hash,content,options,created_at,delivery_mode,position)
      VALUES(?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM message_queue))`).run(id,userId,sessionId,requestId,payloadHash,content,options,new Date().toISOString(),delivery);
    return this.get(userId,id)!;
  },
  heads(): QueuedTurnRecord[] {
    return getConnection().prepare(`SELECT q.* FROM message_queue q WHERE q.status='queued' AND q.delivery_mode='queued'
      AND NOT EXISTS(SELECT 1 FROM session_workspace w WHERE w.session_id=q.session_id AND w.user_id=q.user_id AND w.queue_paused=1)
      AND NOT EXISTS(SELECT 1 FROM message_queue previous WHERE previous.session_id=q.session_id
        AND previous.delivery_mode='queued' AND previous.position<q.position AND previous.status IN ('queued','running','failed','interrupted'))
      ORDER BY q.position,q.sequence LIMIT 8`).all() as QueuedTurnRecord[];
  },
  claim(id: string, delivery: 'queued'|'live'='queued'): QueuedTurnRecord|null {
    const db=getConnection();
    return db.transaction(() => {
      const runId=randomUUID(), now=new Date().toISOString();
      const changed=db.prepare(`UPDATE message_queue SET status='running',run_id=?,attempt_count=attempt_count+1,
        started_at=?,finished_at=NULL,error=NULL,revision=revision+1 WHERE id=? AND status='queued' AND delivery_mode=?
        AND (delivery_mode='live' OR (NOT EXISTS(SELECT 1 FROM session_workspace w WHERE w.session_id=message_queue.session_id AND w.user_id=message_queue.user_id AND w.queue_paused=1)
          AND NOT EXISTS(SELECT 1 FROM message_queue p WHERE p.session_id=message_queue.session_id
          AND p.delivery_mode='queued' AND p.position<message_queue.position AND p.status IN ('queued','running','failed','interrupted'))))`)
        .run(runId,now,id,delivery);
      if (!changed.changes) return null;
      const row=db.prepare('SELECT * FROM message_queue WHERE id=?').get(id) as QueuedTurnRecord;
      db.prepare(`INSERT INTO message_queue_attempts(id,message_id,attempt,status,started_at)
        VALUES(?,?,?,'running',?)`).run(runId,id,row.attempt_count,now);
      return row;
    })();
  },
  defer(row: QueuedTurnRecord): void {
    const db=getConnection();
    db.transaction(() => {
      // No provider started: release the reservation, rather than fabricating a failed attempt.
      db.prepare("DELETE FROM message_queue_attempts WHERE id=? AND status='running'").run(row.run_id);
      db.prepare(`UPDATE message_queue SET status='queued',run_id=NULL,started_at=NULL,
        attempt_count=MAX(0,attempt_count-1),revision=revision+1 WHERE id=? AND run_id=? AND status='running'`)
        .run(row.id,row.run_id);
    })();
  },
  finish(row: QueuedTurnRecord, status: 'succeeded'|'failed'|'interrupted', error: string|null): void {
    const db=getConnection(), now=new Date().toISOString();
    db.transaction(() => {
      const changed=db.prepare(`UPDATE message_queue SET status=?,error=?,finished_at=?,revision=revision+1
        WHERE id=? AND run_id=? AND status='running'`).run(status,error,now,row.id,row.run_id);
      if (!changed.changes) return;
      db.prepare("UPDATE message_queue_attempts SET status=?,error=?,finished_at=? WHERE id=? AND status='running'")
        .run(status,error,now,row.run_id);
    })();
  },
  edit(userId: number, id: string, revision: number, content: string): boolean {
    return getConnection().prepare(`UPDATE message_queue SET content=?,revision=revision+1
      WHERE user_id=? AND id=? AND revision=? AND status='queued'`).run(content,userId,id,revision).changes>0;
  },
  move(userId:number,id:string,revision:number,direction:'up'|'down'):boolean {
    const db=getConnection();
    return db.transaction(()=>{
      const row=this.get(userId,id);
      if(!row||row.revision!==revision||row.status!=='queued'||row.delivery_mode!=='queued')return false;
      const adjacent=db.prepare(`SELECT * FROM message_queue WHERE session_id=? AND delivery_mode='queued'
        AND status IN ('queued','running','failed','interrupted') AND position ${direction==='up'?'<':'>'} ?
        ORDER BY position ${direction==='up'?'DESC':'ASC'} LIMIT 1`).get(row.session_id,row.position) as QueuedTurnRecord|undefined;
      // Never move across a running or uncertain head, or another user's entry.
      if(!adjacent||adjacent.status!=='queued'||adjacent.user_id!==userId)return false;
      const update=db.prepare('UPDATE message_queue SET position=?,revision=revision+1 WHERE id=?');
      update.run(adjacent.position,row.id);update.run(row.position,adjacent.id);
      return true;
    })();
  },
  action(userId: number, id: string, revision: number, action: 'retry'|'cancel'): boolean {
    return getConnection().prepare(`UPDATE message_queue SET status=?,revision=revision+1,
      run_id=NULL,error=CASE WHEN ?='retry' THEN NULL ELSE error END
      WHERE user_id=? AND id=? AND revision=? AND status IN (${action==='retry' ? "'failed','interrupted'" : "'queued','failed','interrupted'"})`)
      .run(action==='retry'?'queued':'cancelled',action,userId,id,revision).changes>0;
  },
  attempts(userId: number, id: string): QueuedTurnAttempt[] {
    return getConnection().prepare(`SELECT a.* FROM message_queue_attempts a JOIN message_queue q ON q.id=a.message_id
      WHERE q.user_id=? AND q.id=? ORDER BY a.attempt`).all(userId,id) as QueuedTurnAttempt[];
  },
  recover(): void {
    const db=getConnection(), now=new Date().toISOString();
    db.transaction(() => {
      const error='Server restarted before completion was confirmed. Review this attempt before retrying.';
      db.prepare("UPDATE message_queue_attempts SET status='interrupted',finished_at=?,error=? WHERE status='running'").run(now,error);
      db.prepare("UPDATE message_queue SET status='interrupted',finished_at=?,error=?,revision=revision+1 WHERE status='running' OR (delivery_mode='live' AND status='queued')").run(now,error);
    })();
  },
};
