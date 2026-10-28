import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { getCloudCliHomeDir } from '@/shared/index.js';
import type { ProviderModelsDefinition } from '@/shared/types.js';

const execute=promisify(execFile);
let cache:{at:number;cli:string;models:ProviderModelsDefinition}|undefined;
const availabilityFile=()=>path.join(getCloudCliHomeDir(),'gemini','availability.json');
export function rememberGeminiAvailability(error?:string){
  const reason=error&&/location.*not supported|不支持当前地区/i.test(error)?'agy CLI 的 CodeAssist 接口返回地区限制（400）。Gemini 桌面版使用独立网页链路；42314 代理另需认证（407），当前 CLI 无法执行。':error?'Gemini 调用未通过：'+error.slice(0,160):'';
  fs.mkdirSync(path.dirname(availabilityFile()),{recursive:true});fs.writeFileSync(availabilityFile(),JSON.stringify({reason,at:new Date().toISOString()}));
}
export function geminiUnavailableReason():string {
  try{return JSON.parse(fs.readFileSync(availabilityFile(),'utf8')).reason||'';}catch{/* Read old app-owned runtime receipts once after an upgrade. */}
  const dir=path.join(getCloudCliHomeDir(),'gemini','transcripts');
  try{for(const file of fs.readdirSync(dir).filter(n=>n.endsWith('.jsonl')).sort((a,b)=>fs.statSync(path.join(dir,b)).mtimeMs-fs.statSync(path.join(dir,a)).mtimeMs).slice(0,5)){
    const tail=fs.readFileSync(path.join(dir,file),'utf8').slice(-10000);
    if(/location.*not supported|不支持当前地区/i.test(tail)){rememberGeminiAvailability('location is not supported');return JSON.parse(fs.readFileSync(availabilityFile(),'utf8')).reason;}
  }}catch{/* No previous failed conversation. */}
  return '';
}
export async function readGeminiModels(cli:string|null|undefined):Promise<ProviderModelsDefinition>{
  if(!cli)return {CUSTOM_MODELS_SUPPORTED:false,OPTIONS:[],DEFAULT:''};
  if(!cache||cache.cli!==cli||Date.now()-cache.at>60000){
    const {stdout}=await execute(cli,['models'],{windowsHide:true,timeout:15000,maxBuffer:1024*1024,env:{...process.env,NODE_OPTIONS:''}});
    const options=stdout.split(/\r?\n/).flatMap(line=>{const match=line.match(/^([\w.-]+)\t(.+)$/);return match?[{value:match[1],label:match[2],effort:{default:'medium',values:['low','medium','high','xhigh','max'].map(value=>({value}))}}]:[];});
    cache={at:Date.now(),cli,models:{CUSTOM_MODELS_SUPPORTED:false,OPTIONS:options,DEFAULT:options[0]?.value||''}};
  }
  const reason=geminiUnavailableReason();return {...cache.models,OPTIONS:cache.models.OPTIONS.map(option=>({...option,...(reason?{disabled:true,unavailableReason:reason,description:reason}:{})}))};
}
