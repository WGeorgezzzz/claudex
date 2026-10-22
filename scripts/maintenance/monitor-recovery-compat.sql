-- Compatibility for the pre-0.6 scheduler while its active provider processes stay alive.
-- A failure clears a running claim AND increments run_count. A manual pause does neither.
CREATE TRIGGER IF NOT EXISTS claudex_monitor_retry_failure
AFTER UPDATE ON monitors
WHEN OLD.status='active' AND NEW.status='paused' AND OLD.running_id IS NOT NULL
 AND NEW.running_id IS NULL AND NEW.run_count=OLD.run_count+1 AND NEW.last_error IS NOT NULL
BEGIN
 UPDATE monitors SET status='active',pause_reason=NULL,consecutive_failures=OLD.consecutive_failures+1,
  next_run_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+' || min(30,1 << min(5,OLD.consecutive_failures)) || ' minutes')
 WHERE id=NEW.id;
END;

-- The old restart recovery clears an active claim without incrementing its count.
CREATE TRIGGER IF NOT EXISTS claudex_monitor_retry_restart
AFTER UPDATE ON monitors
WHEN OLD.status='active' AND NEW.status='paused' AND OLD.running_id IS NOT NULL
 AND NEW.running_id IS NULL AND NEW.run_count=OLD.run_count
 AND NEW.last_error LIKE '服务重启%'
BEGIN
 UPDATE monitors SET status='active',pause_reason=NULL,run_count=run_count+1,consecutive_failures=OLD.consecutive_failures+1,
  next_run_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+' || min(30,1 << min(5,OLD.consecutive_failures)) || ' minutes')
 WHERE id=NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS claudex_monitor_manual_pause
AFTER UPDATE OF status ON monitors
WHEN NEW.status IN ('paused','stopped') AND NEW.status<>OLD.status
 AND NEW.running_id IS OLD.running_id AND NEW.run_count=OLD.run_count
BEGIN
 UPDATE monitors SET pause_reason='user' WHERE id=NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS claudex_monitor_reset_retry
AFTER UPDATE ON monitors
WHEN NEW.last_error IS NULL AND NEW.status='active'
 AND (NEW.run_count=OLD.run_count+1 OR OLD.status='paused')
BEGIN
 UPDATE monitors SET consecutive_failures=0,pause_reason=NULL WHERE id=NEW.id;
END;
