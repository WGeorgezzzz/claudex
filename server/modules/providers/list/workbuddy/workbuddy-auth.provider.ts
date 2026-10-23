import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import type { IProviderAuth } from '@/shared/index.js';
import { getCurrentUserContext } from '@/modules/auth/index.js';
import type { ProviderAuthStatus } from '@/shared/index.js';

const execute = promisify(execFile);

/** WorkBuddy runtime and auth probes use the installed official executable and its bundled CLI. */
export function resolveWorkBuddyInstallation(): { executable: string; directory: string; launcher: string } | null {
  if (getCurrentUserContext()?.role === 'member') return null;
  if (process.platform !== 'win32') return null;
  const roots = [process.env.WORKBUDDY_INSTALL_DIR,
    ...['C:', 'D:', 'E:'].flatMap(drive => ['WorkBuddyAI', 'WorkBuddy'].map(name => `${drive}/Program Files/${name}`)),
    ...['WorkBuddyAI', 'WorkBuddy'].map(name => path.join(process.env.LOCALAPPDATA || os.homedir(), 'Programs', name)),
  ].filter((value): value is string => Boolean(value));
  let current = path.dirname(fileURLToPath(import.meta.url));
  let launcher = '';
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = path.join(current, 'scripts/workbuddy/local-login.cjs');
    if (existsSync(candidate)) { launcher = candidate; break; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!launcher) return null;
  for (const directory of roots) {
    for (const name of ['WorkBuddyAI.exe', 'WorkBuddy.exe']) {
      const executable = path.join(directory, name);
      if (existsSync(executable) && existsSync(path.join(directory, 'resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs'))) {
        return { executable, directory, launcher };
      }
    }
  }
  return null;
}

/** Provider registry reports only credential availability, never the token or a model-entitlement claim. */
export class WorkBuddyProviderAuth implements IProviderAuth {
  async getStatus(): Promise<ProviderAuthStatus> {
    const install = resolveWorkBuddyInstallation();
    const base = { provider: 'workbuddy' as const, installed: Boolean(install), authenticated: false, email: null, method: null };
    if (!install) return { ...base, error: 'Install WorkBuddy on this Windows host to use its local login.' };
    try {
      const { stdout } = await execute(install.executable, [install.launcher, '--status'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDEX_WORKBUDDY_INSTALL: install.directory, NODE_OPTIONS: '' },
        windowsHide: true, timeout: 10000, maxBuffer: 4096,
      });
      const status = JSON.parse(stdout);
      if (status.authenticated !== true) throw new Error('No local login');
      return { ...base, authenticated: true, email: status.product || 'WorkBuddy local account', method: 'local_login' };
    } catch {
      return { ...base, error: 'Open WorkBuddy and sign in again, then refresh this status.' };
    }
  }
}
