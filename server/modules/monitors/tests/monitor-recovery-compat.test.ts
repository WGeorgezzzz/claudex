import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import Database from 'better-sqlite3';

test('legacy failure/restart recovery preserves manual pause/stop and does not rewrite running claims', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE monitors(id TEXT PRIMARY KEY,status TEXT,running_id TEXT,run_count INTEGER,last_error TEXT,next_run_at TEXT,consecutive_failures INTEGER DEFAULT 0,pause_reason TEXT);
    INSERT INTO monitors VALUES('failure','active','run1',0,NULL,'2026-01-01',0,NULL),('manual','active','run2',0,NULL,'2026-01-01',0,NULL),('restart','active','run3',0,NULL,'2026-01-01',0,NULL);`);
  db.exec(readFileSync(new URL('../../../../scripts/maintenance/monitor-recovery-compat.sql', import.meta.url), 'utf8'));
  const row = (id: string) => db.prepare('SELECT * FROM monitors WHERE id=?').get(id) as Record<string, unknown>;
  assert.equal(row('failure').running_id, 'run1');
  db.exec("UPDATE monitors SET status='paused',running_id=NULL,run_count=run_count+1,last_error='network unavailable' WHERE id='failure'");
  assert.equal(row('failure').status, 'active'); assert.equal(row('failure').consecutive_failures, 1);
  assert.ok(Date.parse(String(row('failure').next_run_at)) > Date.now());
  db.exec("UPDATE monitors SET status='paused' WHERE id='manual'");
  db.exec("UPDATE monitors SET running_id=NULL,run_count=run_count+1,last_error='network unavailable' WHERE id='manual'");
  assert.equal(row('manual').status, 'paused'); assert.equal(row('manual').pause_reason, 'user');
  db.exec("UPDATE monitors SET status='paused',running_id=NULL,last_error='服务重启，结果未确认' WHERE id='restart'");
  assert.equal(row('restart').status, 'active'); assert.equal(row('restart').run_count, 1);
  db.exec("UPDATE monitors SET status='paused' WHERE id='failure'");
  assert.equal(row('failure').status, 'paused'); assert.equal(row('failure').pause_reason, 'user');
  db.exec("UPDATE monitors SET status='active',last_error=NULL WHERE id='failure'");
  assert.equal(row('failure').consecutive_failures, 0);
  db.exec("UPDATE monitors SET status='stopped',running_id='stop-run' WHERE id='restart'");
  db.exec("UPDATE monitors SET status='stopped',running_id=NULL,last_error='服务重启，结果未确认' WHERE id='restart'");
  assert.equal(row('restart').status, 'stopped'); db.close();
});
