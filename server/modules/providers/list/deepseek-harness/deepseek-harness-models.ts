import fs from 'node:fs';
import path from 'node:path';
import { resolveDeepSeekHarnessInstallation } from './deepseek-harness-installation.provider.js';

/** Read the effective TokenHub model catalog without changing the user's DSH files. */
export function readDeepSeekHarnessModels(){
  const install=resolveDeepSeekHarnessInstallation();
  let model='', models:string[]=[];
  if(install)try{const text=fs.readFileSync(path.join(install.directory,'tokenhub.patch.yml'),'utf8');
    models=[...text.matchAll(/^\s+- id:\s*([^\s#]+)\s*$/gm)].map(match=>match[1]).filter(id=>id.startsWith('deepseek-')||id.startsWith('glm-'));
    const block=text.split(/^- id:\s*agent-default-model\s*$/m)[1];
    model=(block?.match(/^\s+model:\s*['"]?([^\s'"#]+)['"]?/m)?.[1]||'').trim();
  }catch{/* Missing configuration is reported, never substituted with a shipped model list. */}
  const options=[...new Set(models)].map(value=>({value,label:value,description:'DeepSeek Harness · Tencent TokenHub'}));
  return {CUSTOM_MODELS_SUPPORTED:false,OPTIONS:options,DEFAULT:model||options[0]?.value||''};
}
