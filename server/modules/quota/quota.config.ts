import fs from 'node:fs';
import path from 'node:path';

import { getCloudCliHomeDir } from '@/shared/index.js';

/** Quota configuration and its tests share validation before credentials can be sent to a relay. */
export function normalizeRelayBaseUrl(value: unknown): string {
  if (value === '' || value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('中转地址必须是 URL');
  const url = new URL(value.trim());
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new Error('请使用不含凭据、查询参数或片段的 HTTPS 中转地址');
  }
  return url.toString().replace(/\/+$/, '');
}

/** Quota composition and admin routes read deployment overrides before the persisted, installation-owned setting. */
export function readRelayConfiguration() {
  const override = process.env.NEXAGENT_RELAY_BASE_URL;
  if (override !== undefined) return { baseUrl: normalizeRelayBaseUrl(override), source: 'environment' as const };
  let stored: { baseUrl?: unknown } = {};
  try { stored = JSON.parse(fs.readFileSync(path.join(getCloudCliHomeDir(), 'relay.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取中转配置'); }
  return { baseUrl: normalizeRelayBaseUrl(stored.baseUrl), source: 'file' as const };
}

/** Admin quota routes persist a validated URL outside the repository without touching the application database. */
export function saveRelayConfiguration(value: unknown) {
  if (process.env.NEXAGENT_RELAY_BASE_URL !== undefined) throw new Error('中转地址由环境变量管理');
  const baseUrl = normalizeRelayBaseUrl(value);
  const directory = getCloudCliHomeDir();
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'relay.json');
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ baseUrl }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
  return readRelayConfiguration();
}
