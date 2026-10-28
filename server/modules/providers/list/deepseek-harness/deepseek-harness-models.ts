import fs from 'node:fs';
import path from 'node:path';
import { resolveDeepSeekHarnessInstallation } from './deepseek-harness-installation.provider.js';

/** The launcher applies rp.patch.yml; expose its effective default without changing the user's configuration. */
export function readDeepSeekHarnessModels(){
  const install=resolveDeepSeekHarnessInstallation();
  let model='';
  if(install)try{const text=fs.readFileSync(path.join(install.directory,'rp.patch.yml'),'utf8');
    const block=text.split(/^- id:\s*agent-default-model\s*$/m)[1];
    model=(block?.match(/^\s+model:\s*['"]?([^\s'"#]+)['"]?/m)?.[1]||'').trim();
  }catch{/* Missing configuration is reported, never substituted with a shipped model list. */}
  return {CUSTOM_MODELS_SUPPORTED:false,OPTIONS:model?[{value:model,label:model,description:'DeepSeek Harness 本机配置 · rp.patch.yml'}]:[],DEFAULT:model};
}
