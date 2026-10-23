import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { AppError, getCloudCliHomeDir } from '@/shared/index.js';
import { resolveWorkBuddyInstallation } from '@/modules/providers/list/workbuddy/workbuddy-auth.provider.js';

/** Model library reads host-owned quota snapshots; this never launches inference on a page refresh. */
export const providerQuotaService = {
  openLogin(provider: 'claude' | 'cursor') {
    const install = resolveWorkBuddyInstallation();
    if (!install) throw new AppError('本机 WorkBuddy 不可用。', { statusCode: 409 });
    const state = path.join(getCloudCliHomeDir(), 'provider-usage');
    mkdirSync(state, { recursive: true });
    if (existsSync(path.join(state, 'run.lock'))) throw new AppError('正在查询用量或已有登录窗口，请稍后重试。', { statusCode: 409 });
    const worker = path.resolve(path.dirname(install.launcher), '../usage-monitor/worker.cjs');
    const child = spawn(process.execPath, [worker, '--login', provider], { cwd: state, windowsHide: true,
      env: { ...process.env, CLAUDEX_USAGE_HOME: state }, stdio: 'ignore', detached: true });
    child.on('error', () => {}); child.unref();
    return { opening: true };
  },
  async read() {
    try {
      const snapshot = JSON.parse(await readFile(path.join(getCloudCliHomeDir(), 'provider-usage', 'snapshot.json'), 'utf8'));
      if (snapshot.version !== 1 || !Array.isArray(snapshot.providers) || !Number.isFinite(Date.parse(snapshot.updatedAt))) throw new Error('Invalid quota snapshot');
      return { ...snapshot, stale: Date.now() - Date.parse(snapshot.updatedAt) > 45 * 60000 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { updatedAt: null, stale: true, providers: [], intervalMinutes: 30, reporter: null };
      throw error;
    }
  },
};
