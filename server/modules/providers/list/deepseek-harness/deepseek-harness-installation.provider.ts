import { existsSync,readFileSync } from 'node:fs';
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
  let status:{provider?:string;endpoint?:string;model?:string}={};try{status=JSON.parse(readFileSync(path.join(directory,'status.json'),'utf8').replace(/^\uFEFF+/,''));}catch{/* The launcher default remains authoritative when no status exists. */}
  const launcherText=readFileSync(launcher,'utf8');
  const selectedProvider=status.provider==='rp'||status.provider==='tokenhub'?status.provider:/tokenhub/i.test(status.endpoint||'')?'tokenhub':launcherText.match(/\$Provider\s*=\s*['"](rp|tokenhub)['"]/)?.[1]||'rp';
  return { directory, launcher, packageFile, bridge,selectedProvider,statusModel:status.model,
    configured: existsSync(path.join(directory, selectedProvider+'.patch.yml')) && existsSync(path.join(directory, selectedProvider+'.dpapi')) };
}
