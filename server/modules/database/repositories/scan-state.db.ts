import { getCurrentUserContext } from '@/modules/auth/index.js';
import { getOwnerUserId } from '../ownership.js';
import { getConnection } from '@/modules/database/connection.js';

function scanTarget(): {table: string; key: string; id: number} {
  return getCurrentUserContext()?.role === 'member'
    ? {table: 'user_scan_state', key: 'user_id', id: getOwnerUserId()}
    : {table: 'scan_state', key: 'id', id: 1};
}

type ScanStateRow = {
  last_scanned_at: string;
};

export const scanStateDb = {
    getLastScannedAt() {
        const db = getConnection();
        const target = scanTarget();

        const row = db
            .prepare(`SELECT last_scanned_at FROM ${target.table} WHERE ${target.key} = ${target.id}`)
            .get() as ScanStateRow;

        if (!row) {
            return null; // Before any scan, the row is undefined.
        }

        let lastScannedDate: Date | null = null;
        const lastScannedStr = row.last_scanned_at;

        if (lastScannedStr) {
            // SQLite CURRENT_TIMESTAMP returns UTC in "YYYY-MM-DD HH:MM:SS" format.
            // Replace space with 'T' and append 'Z' to parse reliably in JS across all platforms.
            lastScannedDate = new Date(lastScannedStr.replace(' ', 'T') + 'Z');
        }

        return lastScannedDate;
    },

    updateLastScannedAt(scannedAt: Date = new Date()) {
        const db = getConnection();
        const target = scanTarget();
        const sqliteTimestamp = scannedAt.toISOString().slice(0, 19).replace('T', ' ');

        db.prepare(`
            INSERT INTO ${target.table} (${target.key}, last_scanned_at)
            VALUES (${target.id}, ?)
            ON CONFLICT (${target.key})
            DO UPDATE SET last_scanned_at = excluded.last_scanned_at
        `).run(sqliteTimestamp);
    }
};
