import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';
import type { DotMemory, DotThread, DotTask } from '@/shared/index.js';

/** Database initialization creates user-scoped Dot state without modifying provider transcripts. */
export function initializeDotTables(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS dot_threads(user_id INTEGER NOT NULL, session_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dot_memories(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,content TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS dot_tasks(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,source_session_id TEXT NOT NULL,target_session_id TEXT NOT NULL,queue_id TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,reported INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,UNIQUE(user_id,request_id));
    CREATE INDEX IF NOT EXISTS idx_dot_memories_user ON dot_memories(user_id,deleted);
    CREATE INDEX IF NOT EXISTS idx_dot_tasks_pending ON dot_tasks(reported);`);
}

/** Dot services use this repository for ownership, revision checks and durable delegation recovery. */
export const dotDb = {
  transaction<T>(fn:()=>T):T { return getConnection().transaction(fn)(); },
  threads(userId:number):DotThread[] { return getConnection().prepare(`SELECT d.session_id AS sessionId,s.custom_name AS title,d.created_at AS createdAt FROM dot_threads d JOIN sessions s ON s.session_id=d.session_id WHERE d.user_id=? AND s.isArchived=0 ORDER BY d.created_at DESC`).all(userId) as DotThread[]; },
  owns(userId:number,sessionId:string):boolean { return Boolean(getConnection().prepare('SELECT 1 FROM dot_threads d JOIN sessions s ON s.session_id=d.session_id WHERE d.user_id=? AND d.session_id=? AND s.isArchived=0').get(userId,sessionId)); },
  addThread(userId:number,sessionId:string) { getConnection().prepare('INSERT INTO dot_threads VALUES(?,?,?)').run(userId,sessionId,new Date().toISOString()); },
  memories(userId:number):DotMemory[] { return getConnection().prepare('SELECT id,content,revision,created_at AS createdAt,updated_at AS updatedAt FROM dot_memories WHERE user_id=? AND deleted=0 ORDER BY updated_at DESC').all(userId) as DotMemory[]; },
  saveMemory(userId:number,content:string,id?:string,revision?:number):boolean {
    const now=new Date().toISOString();
    if(id)return Boolean(getConnection().prepare('UPDATE dot_memories SET content=?,revision=revision+1,updated_at=? WHERE user_id=? AND id=? AND revision=? AND deleted=0').run(content,now,userId,id,revision).changes);
    getConnection().prepare('INSERT INTO dot_memories(id,user_id,content,created_at,updated_at) VALUES(?,?,?,?,?)').run(randomUUID(),userId,content,now,now);return true;
  },
  forget(userId:number,id:string,revision:number):boolean { return Boolean(getConnection().prepare('UPDATE dot_memories SET deleted=1,revision=revision+1,updated_at=? WHERE user_id=? AND id=? AND revision=? AND deleted=0').run(new Date().toISOString(),userId,id,revision).changes); },
  tasks(userId:number):DotTask[] { return getConnection().prepare('SELECT d.*,q.status,q.error,q.revision,q.finished_at,s.custom_name AS title,s.project_path AS projectPath FROM dot_tasks d JOIN message_queue q ON q.id=d.queue_id JOIN sessions s ON s.session_id=d.target_session_id WHERE d.user_id=? ORDER BY d.created_at DESC LIMIT 200').all(userId) as DotTask[]; },
  byRequest(userId:number,id:string):DotTask|undefined { return getConnection().prepare('SELECT d.*,q.status,q.error,q.revision,q.finished_at FROM dot_tasks d JOIN message_queue q ON q.id=d.queue_id WHERE d.user_id=? AND d.request_id=?').get(userId,id) as DotTask|undefined; },
  addTask(task:Omit<DotTask,'status'|'error'|'revision'|'finished_at'|'reported'>) { getConnection().prepare('INSERT INTO dot_tasks(id,user_id,source_session_id,target_session_id,queue_id,request_id,payload_hash,created_at) VALUES(@id,@user_id,@source_session_id,@target_session_id,@queue_id,@request_id,@payload_hash,@created_at)').run(task); },
  pendingReports():DotTask[] { return getConnection().prepare("SELECT d.*,q.status,q.error,q.revision,q.finished_at FROM dot_tasks d JOIN message_queue q ON q.id=d.queue_id WHERE d.reported=0 AND q.status IN ('succeeded','failed','interrupted','cancelled') LIMIT 20").all() as DotTask[]; },
  reported(id:string) { getConnection().prepare('UPDATE dot_tasks SET reported=1 WHERE id=?').run(id); },
};
