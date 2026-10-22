import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';

/** Database startup installs revocable device sessions and an independent remote credential. */
export function initializeAuthSessionTables(db:Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS auth_sessions(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,kind TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS remote_identity(user_id INTEGER PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,totp_secret TEXT NOT NULL,last_totp_step INTEGER NOT NULL DEFAULT -1);`);
}

/** Auth owns device lifetime and remote credentials; callers never receive password or OTP secret readbacks. */
export const authSessionsDb={
  create(userId:number,kind:string){const id=randomUUID(),now=Date.now();getConnection().prepare('INSERT INTO auth_sessions(id,user_id,kind,created_at,expires_at) VALUES(?,?,?,?,?)').run(id,userId,kind,now,now+7*86400000);return id;},
  get(id:string){return getConnection().prepare('SELECT * FROM auth_sessions WHERE id=? AND revoked=0 AND expires_at>?').get(id,Date.now()) as {id:string;user_id:number;kind:string;expires_at:number}|undefined;},
  list(userId:number){return getConnection().prepare('SELECT id,kind,created_at,expires_at FROM auth_sessions WHERE user_id=? AND revoked=0 AND expires_at>? ORDER BY created_at DESC').all(userId,Date.now());},
  revoke(userId:number,id:string){return Boolean(getConnection().prepare('UPDATE auth_sessions SET revoked=1 WHERE user_id=? AND id=?').run(userId,id).changes);},
  remote(){return getConnection().prepare('SELECT * FROM remote_identity LIMIT 1').get() as {user_id:number;username:string;password_hash:string;totp_secret:string;last_totp_step:number}|undefined;},
  configure(userId:number,username:string,passwordHash:string,secret:string){getConnection().prepare('INSERT INTO remote_identity(user_id,username,password_hash,totp_secret) VALUES(?,?,?,?)').run(userId,username,passwordHash,secret);},
  acceptOtp(userId:number,step:number){return Boolean(getConnection().prepare('UPDATE remote_identity SET last_totp_step=? WHERE user_id=? AND last_totp_step<?').run(step,userId,step).changes);},
};
