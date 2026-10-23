import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appConfigDb, userDb } from '@/modules/database/index.js';

function secret(): string {
  const key = 'browser_use_mcp_token';
  const existing = appConfigDb.get(key);
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  appConfigDb.set(key, token);
  return token;
}

/** Runtime workers inject this caller-bound capability into child MCP environments, never shared config files. */
export function issueBrowserMcpToken(userId: number): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Invalid MCP owner.');
  return String(userId) + '.' + createHmac('sha256', secret()).update('browser-user:' + userId).digest('hex');
}

/** Browser MCP ingress verifies the capability and resolves legacy installed tokens to the original admin only. */
export function resolveBrowserMcpToken(token: string): number | null {
  const match = /^([1-9]\d*)\.([a-f0-9]{64})$/.exec(token);
  if (match) {
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id)) return null;
    const expected = issueBrowserMcpToken(id);
    return Buffer.byteLength(expected) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(expected), Buffer.from(token)) ? id : null;
  }
  const legacy = secret();
  if (Buffer.byteLength(token) !== Buffer.byteLength(legacy) || !timingSafeEqual(Buffer.from(token), Buffer.from(legacy))) return null;
  return userDb.getFirstUser()?.id ?? null;
}
