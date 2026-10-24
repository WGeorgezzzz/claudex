import type { Database } from 'better-sqlite3';

/** Database migrations and isolated Usage tests create idempotent tables without user foreign keys, preserving deleted accounts. */
export function initializeUsageTables(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS usage_scan_files (
    path TEXT PRIMARY KEY, user_id INTEGER NOT NULL, provider TEXT NOT NULL,
    size INTEGER NOT NULL, mtime_ms REAL NOT NULL, offset INTEGER NOT NULL, state_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS usage_events_daily (
    user_id INTEGER NOT NULL, day TEXT NOT NULL, hour INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0,
    source_path TEXT NOT NULL, last_active_at TEXT,
    UNIQUE(user_id, day, hour, provider, model, source_path));
    CREATE INDEX IF NOT EXISTS idx_usage_user_day ON usage_events_daily(user_id,day);
    CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_events_daily(day);`);
}
