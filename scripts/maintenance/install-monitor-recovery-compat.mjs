import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

// Explicit paths only. The online backup completes before the live schema transaction.
const [databasePath, backupPath] = process.argv.slice(2);
if (!databasePath || !backupPath || !path.isAbsolute(databasePath) || !path.isAbsolute(backupPath) || path.resolve(databasePath) === path.resolve(backupPath)) throw new Error('Provide distinct absolute database and new backup paths.');
await fs.access(databasePath);
try { await fs.access(backupPath); throw new Error('Backup already exists; choose a new path.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const db = new Database(databasePath, { fileMustExist: true, timeout: 5000 });
try {
  const columns = db.prepare('PRAGMA table_info(monitors)').all();
  for (const required of ['running_id', 'run_count', 'last_error', 'next_run_at']) if (!columns.some(column => column.name === required)) throw new Error('Unsupported monitor schema.');
  await db.backup(backupPath);
  const sql = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'monitor-recovery-compat.sql'), 'utf8');
  db.transaction(() => {
    if (!columns.some(column => column.name === 'consecutive_failures')) db.exec('ALTER TABLE monitors ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0');
    if (!columns.some(column => column.name === 'pause_reason')) db.exec('ALTER TABLE monitors ADD COLUMN pause_reason TEXT');
    db.exec(sql);
  }).immediate();
  console.log(JSON.stringify({ installed: true, backupPath, triggers: db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'claudex_monitor_%'").all() }));
} finally { db.close(); }
