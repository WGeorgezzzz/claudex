import type Database from 'better-sqlite3';
import { getCurrentUserContext } from '@/modules/auth/index.js';
import { getConnection } from './connection.js';

/** Repositories use the active account; legacy background jobs retain the original administrator. */
export function getOwnerUserId(): number {
  const id = Number(getCurrentUserContext()?.userId);
  if (Number.isSafeInteger(id) && id > 0) return id;
  const admin = getConnection().prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number } | undefined;
  return admin?.id ?? 0;
}

/** Repository SQL interpolates only validated numeric ids and source-controlled aliases. */
export function ownerPredicate(alias?: string): string {
  return 'COALESCE(' + (alias ? alias + '.' : '') + 'owner_id, 0) = ' + getOwnerUserId();
}

/** Initialization registers this before legacy migrations, which may write through existing ownership triggers. */
export function registerOwnershipContext(db: Database.Database): void {
  // SQLite UDFs must never prepare another query on their executing connection.
  db.function('claudex_current_owner', () => getCurrentUserContext()?.userId ?? null);
}

/** Database initialization runs this additive migration after legacy table repairs. */
export function initializeOwnership(db: Database.Database): void {
  registerOwnershipContext(db);
  db.transaction(() => {
    for (const table of ['projects', 'sessions']) {
      const columns = db.prepare('PRAGMA table_info(' + table + ')').all() as Array<{name: string}>;
      if (!columns.some(column => column.name === 'owner_id')) db.exec('ALTER TABLE ' + table + ' ADD COLUMN owner_id INTEGER REFERENCES users(id)');
      db.exec('UPDATE ' + table + ' SET owner_id = (SELECT id FROM users ORDER BY id LIMIT 1) WHERE owner_id IS NULL;'
        + 'CREATE INDEX IF NOT EXISTS idx_' + table + '_owner ON ' + table + '(owner_id);'
        + 'CREATE TRIGGER IF NOT EXISTS ' + table + '_assign_owner AFTER INSERT ON ' + table
        + ' WHEN NEW.owner_id IS NULL BEGIN UPDATE ' + table + ' SET owner_id = COALESCE(claudex_current_owner(), (SELECT MIN(id) FROM users)) WHERE rowid = NEW.rowid; END;');
    }
    // A shared authorized folder does not transfer its existing project or conversations.
    db.exec(`CREATE TRIGGER IF NOT EXISTS projects_reject_owner_collision BEFORE INSERT ON projects
      WHEN EXISTS(SELECT 1 FROM projects WHERE project_path=NEW.project_path AND owner_id<>COALESCE(claudex_current_owner(), (SELECT MIN(id) FROM users)))
      BEGIN SELECT RAISE(ABORT, 'Project belongs to another user'); END;
      CREATE TRIGGER IF NOT EXISTS sessions_reject_owner_collision BEFORE INSERT ON sessions
      WHEN EXISTS(SELECT 1 FROM sessions WHERE session_id=NEW.session_id AND owner_id<>COALESCE(claudex_current_owner(), (SELECT MIN(id) FROM users)))
      BEGIN SELECT RAISE(ABORT, 'Session belongs to another user'); END;
      CREATE TRIGGER IF NOT EXISTS sessions_reject_provider_owner_collision BEFORE UPDATE OF provider_session_id ON sessions
      WHEN NEW.provider_session_id IS NOT NULL AND EXISTS(SELECT 1 FROM sessions s WHERE s.provider_session_id=NEW.provider_session_id AND s.session_id<>NEW.session_id AND s.owner_id<>NEW.owner_id)
      BEGIN SELECT RAISE(ABORT, 'Provider session belongs to another user'); END;
      CREATE TABLE IF NOT EXISTS user_scan_state(user_id INTEGER PRIMARY KEY, last_scanned_at TEXT);
      CREATE TRIGGER IF NOT EXISTS assign_legacy_owners AFTER INSERT ON users
      WHEN NEW.id=(SELECT MIN(id) FROM users) BEGIN
        UPDATE projects SET owner_id=NEW.id WHERE owner_id IS NULL;
        UPDATE sessions SET owner_id=NEW.id WHERE owner_id IS NULL;
      END;`);
  })();
}

/** WebSocket broadcasts resolve ownership without opening another account's transcript. */
export function getSessionOwnerId(sessionId: string): number | null {
  const row = getConnection().prepare('SELECT owner_id FROM sessions WHERE session_id=? OR provider_session_id=? ORDER BY (session_id=?) DESC LIMIT 1')
    .get(sessionId, sessionId, sessionId) as {owner_id: number | null} | undefined;
  return row?.owner_id ?? null;
}
