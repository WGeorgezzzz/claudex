import { getCurrentUserContext } from '@/modules/auth/index.js';
import type { ProviderModelsDefinition } from '@/shared/types.js';
const failures=new Map<string,{at:number;reason:string}>();
const key=(provider:string,model:string)=>`${getCurrentUserContext()?.userId||0}:${provider}:${model}`;
/** Only explicit account/model rejections disable a model; transient network and quota failures do not. */
export function recordModelRejection(provider:string,model:string,error:string){
  if(!model||!/(model.*(?:not supported|not available|unsupported|not found)|unsupported.*model|not supported.*(?:account|chatgpt)|模型.*(?:不可用|不支持))/i.test(error))return;
  failures.set(key(provider,model),{at:Date.now(),reason:error.replace(/(?:sk-|eyJ)[A-Za-z0-9_.-]+/g,'[redacted]').slice(0,220)});
}
export function modelHealth(provider:string,catalog:ProviderModelsDefinition):ProviderModelsDefinition {
  return {...catalog,OPTIONS:catalog.OPTIONS.map(option=>{const failed=failures.get(key(provider,option.value));return failed&&Date.now()-failed.at<30*60*1000?{...option,disabled:true,unavailableReason:'当前账号拒绝此模型：'+failed.reason}:option;})};
}
