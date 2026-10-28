import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Only quota values are exposed; never return collector configuration or credentials. */
export function readLocalQuota() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDEX_USAGE_HOME || path.join(os.homedir(), '.cloudcli', 'provider-usage'), 'snapshot.json'), 'utf8'));
    return (Array.isArray(raw.providers) ? raw.providers : []).filter((p: {provider?:string}) => ['claude','codex','workbuddy'].includes(p.provider || '')).map((p: Record<string, any>) => ({
      provider: p.provider, status: p.status, checkedAt: p.checkedAt, note: String(p.note || '').slice(0, 300),
      windows: sanitize(p.windows), lastSuccess: p.lastSuccess ? { checkedAt: p.lastSuccess.checkedAt, windows: sanitize(p.lastSuccess.windows) } : undefined,
    }));
  } catch { return []; }
}
function sanitize(windows: unknown): {label:string;usedPercent:number|null;remainingPercent:number|null}[] {
  return (Array.isArray(windows) ? windows : []).map(w => ({ label: String(w.label || '').slice(0,80), usedPercent: Number.isFinite(w.usedPercent) ? w.usedPercent : null, remainingPercent: Number.isFinite(w.remainingPercent) ? w.remainingPercent : null }));
}
