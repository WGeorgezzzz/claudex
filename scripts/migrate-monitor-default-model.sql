-- 2026-10-29 monitor default model migration. Run in a transaction.
BEGIN;
CREATE TABLE IF NOT EXISTS monitor_model_migration_backup_20261029 (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  options TEXT NOT NULL
);
INSERT OR IGNORE INTO monitor_model_migration_backup_20261029(id,user_id,options)
SELECT id,user_id,options FROM monitors
WHERE status IN ('active','paused') AND COALESCE(json_extract(options,'$.modelExplicit'),0)=0 AND session_id IN (SELECT session_id FROM sessions WHERE provider='claude')
  AND lower(COALESCE(json_extract(options,'$.model'),'')) IN
    ('opus','opus[1m]','claude-opus-5-5','claude-opus-5-5[1m]');
UPDATE monitors SET options=json_set(options,'$.model','claude-sonnet-5-5','$.effort','medium')
WHERE status IN ('active','paused') AND COALESCE(json_extract(options,'$.modelExplicit'),0)=0 AND session_id IN (SELECT session_id FROM sessions WHERE provider='claude')
  AND lower(COALESCE(json_extract(options,'$.model'),'')) IN
    ('opus','opus[1m]','claude-opus-5-5','claude-opus-5-5[1m]');
COMMIT;

-- Rollback, if required:
-- UPDATE monitors SET options=(SELECT options FROM monitor_model_migration_backup_20261029 b WHERE b.id=monitors.id)
-- WHERE id IN (SELECT id FROM monitor_model_migration_backup_20261029);
