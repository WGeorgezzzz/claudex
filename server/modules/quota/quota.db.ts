import type { Database } from 'better-sqlite3';

/** Quota service and tests initialize additive history; never delete prior observations or alerts. */
export function initializeQuotaTables(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS quota_credit_snapshots (
    id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, observed_at TEXT NOT NULL,
    balance TEXT NOT NULL, source_updated_at TEXT, consumed TEXT);
    CREATE INDEX IF NOT EXISTS idx_quota_credit_account ON quota_credit_snapshots(account_id,id);
    CREATE TABLE IF NOT EXISTS quota_credit_alerts (
    id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, account_name TEXT NOT NULL,
    observed_at TEXT NOT NULL, consumed TEXT NOT NULL);`);
}

// Use scaled integers: converting decimal credits to floating point can hide a small debit.
function decimal(value: string) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error('Invalid credit balance');
  const [whole, fraction = ''] = value.split('.');
  return { digits: BigInt(whole + fraction), scale: fraction.length };
}

/** Quota service records each successful observation transactionally and returns durable debit warnings. */
export function recordCreditSnapshot(db: Database, id: number, name: string, balance: string, at: string, sourceAt: string | null) {
  const current = decimal(balance);
  return db.transaction(() => {
    const previous = db.prepare('SELECT balance FROM quota_credit_snapshots WHERE account_id=? ORDER BY id DESC LIMIT 1').get(id) as { balance: string } | undefined;
    let consumed: string | null = null;
    let balanceChange: string | null = null;
    if (previous) {
      const old = decimal(previous.balance), scale = Math.max(old.scale, current.scale);
      const delta = old.digits * 10n ** BigInt(scale - old.scale) - current.digits * 10n ** BigInt(scale - current.scale);
      if (delta !== 0n) {
        const digits = (delta > 0n ? delta : -delta).toString().padStart(scale + 1, '0');
        const amount = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, '').replace(/\.$/, '') : digits;
        balanceChange = (delta > 0n ? '-' : '+') + amount;
        if (delta > 0n) consumed = amount;
      }
      if (consumed) {
        db.prepare('INSERT INTO quota_credit_alerts(account_id,account_name,observed_at,consumed) VALUES(?,?,?,?)').run(id, name, at, consumed);
        console.error(`[Quota] 账号 ${name} 点数被消耗 ${consumed}`);
      }
    }
    db.prepare('INSERT INTO quota_credit_snapshots(account_id,observed_at,balance,source_updated_at,consumed) VALUES(?,?,?,?,?)').run(id, at, balance, sourceAt, consumed);
    return { consumed, balanceChange, alerts: db.prepare('SELECT account_id accountId,account_name accountName,observed_at observedAt,consumed FROM quota_credit_alerts WHERE account_id=? ORDER BY id DESC LIMIT 20').all(id) as { accountId: number; accountName: string; observedAt: string; consumed: string }[] };
  })();
}
