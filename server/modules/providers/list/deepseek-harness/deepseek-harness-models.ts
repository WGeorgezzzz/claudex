import fs from 'node:fs';
import path from 'node:path';
import {parse} from 'yaml';
import {resolveDeepSeekHarnessInstallation} from './deepseek-harness-installation.provider.js';

type NativeModel={id:string;name?:string;contextWindow?:number;reasoningEfforts?:Record<string,unknown>};
function catalog(){const install=resolveDeepSeekHarnessInstallation();if(!install)return {install,models:[] as {provider:string;model:NativeModel}[],defaultModel:''};const models:{provider:string;model:NativeModel}[]=[];let defaultModel='';
 for(const provider of [install.selectedProvider,...(['tokenhub','rp'].filter(p=>p!==install.selectedProvider))])try{
  if(!fs.existsSync(path.join(install.directory,provider+'.dpapi')))continue;
  const rows=parse(fs.readFileSync(path.join(install.directory,provider+'.patch.yml'),'utf8').replace(/^\uFEFF+/,'')) as {id:string;config?:{providers?:Record<string,{models?:NativeModel[]}>;model?:string}}[];
  const list=rows.find(row=>row.id==='llm-pi-ai')?.config?.providers?.[provider]?.models||[];
  for(const model of list)if(model&&typeof model.id==='string'&&!models.some(item=>item.model.id===model.id))models.push({provider,model});
  if(provider===install.selectedProvider)defaultModel=list.some(model=>model.id===install.statusModel)?install.statusModel!:rows.find(row=>row.id==='agent-default-model')?.config?.model||list[0]?.id||'';
 }catch{/* Invalid local config has no selectable models; do not invent a catalog. */}
 return {install,models,defaultModel};}
/** Discovery, chat menus and task execution read the selected native provider and its entire local catalog. */
export function readDeepSeekHarnessModels(){const {models,defaultModel}=catalog();return {CUSTOM_MODELS_SUPPORTED:false,DEFAULT:defaultModel,OPTIONS:models.map(({provider,model})=>({value:model.id,label:(provider==='rp'?'RoboParty 网关 · ':'')+(model.name||model.id),contextWindow:model.contextWindow,description:(provider==='rp'?'RoboParty 网关':'Tencent TokenHub')+(model.contextWindow?' · 上下文 '+model.contextWindow.toLocaleString()+' tokens':''),...(model.reasoningEfforts?{effort:{default:'off',values:Object.keys(model.reasoningEfforts).map(key=>({value:key==='false'?'off':key,description:key==='false'?'关闭推理':key}))}}:{})}))};}
/** Runtime validates the exact model/provider pair before writing a process-local selection overlay. */
export function resolveDeepSeekHarnessModel(model:string){return catalog().models.find(item=>item.model.id===model);}
