import { existsSync } from 'node:fs';
import path from 'node:path';
import { getCurrentUserContext } from '@/modules/auth/index.js';
import { findApplicationRoot, getModuleDirectory } from '@/shared/index.js';

/** Discovery and runtime share the administrator's explicitly installed Harness launcher. */
export function resolveDeepSeekHarnessInstallation() {
  if (process.platform !== 'win32' || getCurrentUserContext()?.role === 'member') return null;
  const directory = process.env.DEEPSEEK_HARNESS_INSTALL_DIR || 'D:/embodied/deepseek-harness';
  const launcher = path.join(directory, 'run.ps1');
  const packageFile = path.join(directory, 'runtime/node_modules/@deepseek-ai/dsh/package.json');
  const bridge = path.join(findApplicationRoot(getModuleDirectory(import.meta.url)), 'scripts/deepseek-harness/launch.ps1');
  if (!existsSync(launcher) || !existsSync(packageFile) || !existsSync(bridge)) return null;
  return { directory, launcher, packageFile, bridge,
    configured: existsSync(path.join(directory, 'rp.patch.yml')) && existsSync(path.join(directory, 'rp.dpapi')) };
}
