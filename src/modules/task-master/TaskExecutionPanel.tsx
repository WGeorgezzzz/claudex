import { useEffect,useState } from 'react';
import { api,inboxTasksApi } from '@/shared/api';
import { Dialog,DialogContent,DialogTitle,LLMProviderLogo } from '@/shared/ui';
import type { LLMProvider,ProviderModelsDefinition } from '@/shared/types';

export type TaskExecutionSettings={provider:LLMProvider;model:string;effort:string;permissionMode:string;cwd:string};
const providers=[['claude','Claude'],['codex','Codex'],['gemini','Gemini'],['deepseek-harness','DeepSeek Harness']] as const;
const modes:Record<string,string>={default:'按需审批',acceptEdits:'允许编辑',plan:'只规划',bypassPermissions:'全部允许',auto:'自动审批'};
const control='min-h-10 w-full rounded-lg border bg-background px-3 text-sm';
async function value(response:Response){const body=await response.json();if(!response.ok)throw Error(body.error?.message||body.message||'无法读取执行设置');return body.data??body;}
export function TaskExecutionPanel({title,cwd,open,onClose,onConfirm,busy}:{title:string;cwd:string;open:boolean;onClose:()=>void;onConfirm:(settings:TaskExecutionSettings)=>Promise<void>;busy:boolean}){
  const [settings,setSettings]=useState<TaskExecutionSettings>({provider:'codex',model:'',effort:'',permissionMode:'default',cwd});
  const [catalogs,setCatalogs]=useState<Partial<Record<LLMProvider,ProviderModelsDefinition>>>({});
  const [agents,setAgents]=useState<{id:string;installed:boolean;enabled:boolean}[]>([]);
  const [capabilities,setCapabilities]=useState<{provider:string;permissionModes:string[];defaultPermissionMode:string}[]>([]);
  const [error,setError]=useState(''),[loading,setLoading]=useState(true);
  useEffect(()=>{if(!open)return;let active=true;setLoading(true);setError('');void Promise.all([inboxTasksApi.executionSettings().then(value),api.providers.discovery().then(value),api.providers.capabilities().then(value),Promise.all(providers.map(async([id])=>{try{return [id,(await value(await api.providers.models(id))).models] as const;}catch{return [id,{OPTIONS:[],DEFAULT:''}] as const;}}))]).then(([last,discovery,caps,models])=>{
    if(!active)return;const all=Object.fromEntries(models);setCatalogs(all);setAgents(discovery.agents||[]);setCapabilities(caps.providers||[]);const provider=providers.some(([id])=>id===last.provider)?last.provider:'codex';const model=all[provider]?.OPTIONS.find((m:{value:string;disabled?:boolean})=>m.value===last.model&&!m.disabled)?.value||all[provider]?.OPTIONS.find((m:{disabled?:boolean})=>!m.disabled)?.value||'';
    setSettings({provider,model,effort:last.effort||'',permissionMode:last.permissionMode||'default',cwd:last.cwd||cwd});
  }).catch(reason=>{if(active)setError(String(reason));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[open,cwd]);
  const selected=catalogs[settings.provider]?.OPTIONS.find(m=>m.value===settings.model),agent=agents.find(a=>a.id===settings.provider),capability=capabilities.find(c=>c.provider===settings.provider);
  const changeProvider=(provider:LLMProvider)=>{const model=catalogs[provider]?.OPTIONS.find(m=>!m.disabled);const cap=capabilities.find(c=>c.provider===provider);setSettings(old=>({...old,provider,model:model?.value||'',effort:model?.effort?.default||'',permissionMode:cap?.defaultPermissionMode||'default'}));};
  return <Dialog open={open} onOpenChange={v=>{if(!v)onClose();}}><DialogContent className="max-h-[90dvh] w-[calc(100vw-1.5rem)] max-w-xl space-y-4 overflow-auto p-4"><DialogTitle className="not-sr-only text-lg font-semibold">执行任务</DialogTitle><p className="break-words text-sm">{title}</p>
    {loading?<p role="status">正在读取 Harness 与模型…</p>:<>
      <fieldset><legend className="mb-2 text-xs text-muted-foreground">Harness</legend><div className="grid grid-cols-2 gap-2">{providers.map(([id,name])=>{const available=agents.find(a=>a.id===id)?.enabled;const reason=catalogs[id]?.OPTIONS.find(m=>m.disabled)?.unavailableReason;return <button key={id} type="button" aria-pressed={settings.provider===id} onClick={()=>changeProvider(id)} className={'min-h-14 rounded-lg border p-2 text-left text-xs '+(settings.provider===id?'border-primary bg-primary/5':'')+(!available?' text-muted-foreground':'')}><span className="flex items-center gap-2"><LLMProviderLogo provider={id} className="h-4 w-4"/>{name}</span>{!available&&<span className="mt-1 block break-words text-[11px]">{reason||'未连接或已停用'}</span>}</button>;})}</div></fieldset>
      <label className="block text-xs text-muted-foreground">模型<select aria-label="执行模型" className={control+' mt-1'} value={settings.model} onChange={e=>{const model=catalogs[settings.provider]?.OPTIONS.find(m=>m.value===e.target.value);setSettings({...settings,model:e.target.value,effort:model?.effort?.default||''});}}><option value="">请选择可用模型</option>{catalogs[settings.provider]?.OPTIONS.map(m=><option key={m.value} value={m.value} disabled={m.disabled}>{m.label}{m.disabled?' · 不可用':''}</option>)}</select></label>
      {selected?.description&&<p className="break-words text-xs text-muted-foreground">{selected.description}</p>}
      {catalogs[settings.provider]?.OPTIONS.filter(m=>m.disabled).map(m=><p key={m.value} className="break-words text-xs text-muted-foreground">{m.label}：{m.unavailableReason}</p>)}
      {!!selected?.effort?.values.length&&<label className="block text-xs text-muted-foreground">推理强度<select aria-label="执行推理强度" value={settings.effort} className={control+' mt-1'} onChange={e=>setSettings({...settings,effort:e.target.value})}><option value="">模型默认</option>{selected.effort.values.map(e=><option key={e.value} value={e.value}>{e.value}</option>)}</select></label>}
      <label className="block text-xs text-muted-foreground">权限模式<select aria-label="执行权限模式" value={settings.permissionMode} className={control+' mt-1'} onChange={e=>setSettings({...settings,permissionMode:e.target.value})}>{(capability?.permissionModes||['default']).map(mode=><option key={mode} value={mode}>{modes[mode]||mode}</option>)}</select></label>
      <label className="block text-xs text-muted-foreground">工作目录<input aria-label="执行工作目录" value={settings.cwd} className={control+' mt-1'} onChange={e=>setSettings({...settings,cwd:e.target.value})}/></label>
    </>}
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex justify-end gap-2"><button className="min-h-10 rounded-lg border px-4 text-sm" onClick={onClose}>取消</button><button disabled={loading||busy||!agent?.enabled||!selected||selected.disabled||!settings.cwd.trim()} className="min-h-10 rounded-lg bg-primary px-4 text-sm text-primary-foreground disabled:opacity-40" onClick={()=>void onConfirm(settings)}>确认执行并打开对话</button></div>
  </DialogContent></Dialog>;
}
