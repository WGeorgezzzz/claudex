import { inspectGeminiDesktop } from './gemini-desktop.js';
import type {ProviderModelsDefinition} from '@/shared/types.js';
export async function readGeminiModels(_cli?:string|null):Promise<ProviderModelsDefinition>{try{const info=await inspectGeminiDesktop();return {CUSTOM_MODELS_SUPPORTED:false,OPTIONS:[{value:info.model,label:info.model,description:'使用已登录 Gemini 桌面版；执行会切换桌面窗口'}],DEFAULT:info.model};}catch{return {CUSTOM_MODELS_SUPPORTED:false,OPTIONS:[],DEFAULT:''};}}
