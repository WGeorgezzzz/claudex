import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { getCloudCliHomeDir } from '@/shared/index.js';

/** Extraction orchestration and relay calls append metadata only, never conversation text or credentials. */
export async function recordTaskmasterMetric(metric: Record<string, unknown>) {
  try {
    const directory = path.join(getCloudCliHomeDir(), 'logs');
    await mkdir(directory, { recursive: true });
    await appendFile(path.join(directory, 'taskmaster-auto.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...metric }) + '\n');
  } catch (error) { console.warn('[TaskMaster] Cannot append metrics', String(error)); }
}
