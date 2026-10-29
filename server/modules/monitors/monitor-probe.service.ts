import { open, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import type { MonitorProbeEvent, MonitorProbeSpec, MonitorRecord } from '@/shared/types.js';
import { monitorsDb } from '@/modules/database/index.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 4096;
const MAX_DELTA = 8192;
const DEFAULT_INTERVAL = 3;
const DEFAULT_STALL = 45;
const DEFAULT_HEARTBEAT = 180;
const DEFAULT_PATTERNS = ['Traceback', 'ERROR', 'OOM', 'CUDA error', 'EXIT [1-9]', 'Killed', 'FAILED'];

const itemKey = (item:Record<string,unknown>, index:number) => String(item.id || item.path || item.pid || item.command || `item-${index}`);
const bounded = (value:string) => {
  const bytes=Buffer.from(value,'utf8'); if(bytes.length<=MAX_DELTA)return value;
  const marker='\n…[中间增量已截断]…\n'; const half=Math.floor((MAX_DELTA-Buffer.byteLength(marker))/2);
  return bytes.subarray(0,half).toString('utf8').replace(/\uFFFD+$/,'')+marker+bytes.subarray(-half).toString('utf8').replace(/^\uFFFD+/,'');
};
const fieldAt = (value:unknown, field?:unknown):unknown => {
  if(typeof field !== 'string' || !field) return value;
  return field.split('.').reduce((current,key)=>current && typeof current === 'object' ? (current as Record<string,unknown>)[key] : undefined, value);
};
async function fileProbe(item:Record<string,unknown>, previous:Record<string,unknown>):Promise<{value:unknown;delta:string;offset:number;done:boolean;mtimeMs?:number;fields?:Record<string,unknown>}> {
  const filePath=String(item.path||item.file||''); const key=String(itemKey(item,0));
  try {
    const info=await stat(filePath); const oldOffset=Number(previous[`${key}:offset`]||0); const offset=info.size<oldOffset?0:oldOffset;
    const old=previous[key] as {value?:unknown;mtimeMs?:number}|undefined;
    const doneFile=/(?:^|[-_])done\.json$/i.test(path.basename(filePath));
    const mode=String(item.read||(doneFile?'json':'tail'));
    if(mode==='json') {
      const json=JSON.parse((await readFile(filePath,'utf8')).replace(/^\uFEFF/,'')); const value=fieldAt(json,item.field);
      const changed=JSON.stringify(value)!==JSON.stringify(old?.value);
      const status=String(fieldAt(json,'status')||'');
      const complete=item.doneField?fieldAt(json,item.doneField)===true:doneFile&&(fieldAt(json,'done')===true||/^(completed|succeeded|success|failed|failure)$/.test(status));
      const fields:Record<string,unknown>={};
      if(item.field)fields[String(item.field)]=value;
      else for(const name of ['progress','status','done'])if(fieldAt(json,name)!==undefined)fields[name]=fieldAt(json,name);
      return {value,delta:changed?JSON.stringify(value):'',offset:info.size,done:Boolean(complete),mtimeMs:info.mtimeMs,fields};
    }
    const handle=await open(filePath,'r'); try {
      const available=Math.max(0,info.size-offset); let delta='';
      if(available<=MAX_DELTA){const buffer=Buffer.alloc(available);const result=await handle.read(buffer,0,available,offset);delta=buffer.subarray(0,result.bytesRead).toString('utf8');}
      else {const half=Math.floor(MAX_DELTA/2);const head=Buffer.alloc(half);const tail=Buffer.alloc(half);const first=await handle.read(head,0,half,offset);const last=await handle.read(tail,0,half,info.size-half);delta=head.subarray(0,first.bytesRead).toString('utf8')+'\n…[文件增量中间部分已截断]…\n'+tail.subarray(0,last.bytesRead).toString('utf8');}
      const done=/^\s*(?:EXIT\s+\d+|(?:status|state)\s*[:=]\s*(?:done|completed|succeeded|failed|failure)|(?:done|completed|success)\s*[:=]\s*(?:true|yes|1))\s*$/im.test(delta);
      return {value:delta,delta,offset:info.size,done,mtimeMs:info.mtimeMs};
    } finally {await handle.close();}
  } catch(error) { const value=`${filePath}: ${error instanceof Error?error.message:'missing'}`; return {value,delta:(previous[key] as {value?:unknown}|undefined)?.value===value?'':value,offset:0,done:false}; }
}
async function commandProbe(item:Record<string,unknown>):Promise<{value:string;fields:Record<string,unknown>;error?:string}> {
  let command=String(item.command||'').trim(); if(!command)return {value:'',fields:{},error:'command is empty'};
  if(/^ssh\s+/i.test(command) && !/\s-o\s+BatchMode=/i.test(command)) command=command.replace(/^ssh\s+/i,'ssh -o BatchMode=yes ');
  try { const result=await execFileAsync('cmd.exe',['/d','/s','/c',command],{timeout:Math.min(30_000,Math.max(1000,Number(item.timeoutMs)||30_000)),windowsHide:true,maxBuffer:MAX_OUTPUT}); const value=String(result.stdout||'').slice(0,MAX_OUTPUT); return {value,fields:parseProbeFields(value,item.parse)}; }
  catch(error) { const e=error as {stdout?:string;message?:string}; const value=String(e.stdout||'').slice(0,MAX_OUTPUT); return {value,fields:parseProbeFields(value,item.parse),error:String(e.message||error).slice(0,500)}; }
}
/** Parses common progress/status fields from command or incremental file output. */
export function parseProbeFields(output:string, parse:unknown):Record<string,unknown> {
  let json:unknown; try { json=JSON.parse(output); } catch { /* regex parser below */ }
  const fields:Record<string,unknown>={}; if(json && typeof json==='object')Object.assign(fields,json);
  const config=parse&&typeof parse==='object'?parse as Record<string,unknown>:{ };
  if(!json||typeof json!=='object') {
    const progress=[...output.matchAll(/(\d+)\s*\/\s*(\d+)/g)].at(-1); if(progress)fields.progress={current:Number(progress[1]),total:Number(progress[2])};
    const status=[...output.matchAll(/(?:status|state)\s*[:=]\s*["']?([A-Za-z_-]+)/ig)].at(-1); if(status)fields.status=status[1];
  }
  if(typeof config.progressRegex==='string') { const match=output.match(new RegExp(config.progressRegex)); if(match)fields.progress=match[1]??match[0]; }
  if(typeof config.statusRegex==='string') { const match=output.match(new RegExp(config.statusRegex)); if(match)fields.status=match[1]??match[0]; }
  return fields;
}
async function processProbe(item:Record<string,unknown>):Promise<{alive:boolean;value:string}> {
  if(Number.isInteger(Number(item.pid))) { try { process.kill(Number(item.pid),0); return {alive:true,value:`pid ${item.pid} alive`}; } catch { return {alive:false,value:`pid ${item.pid} dead`}; } }
  if(item.processName) { const result=await execFileAsync('tasklist.exe',['/FI',`IMAGENAME eq ${String(item.processName)}`],{windowsHide:true,timeout:3000}).catch(()=>({stdout:''})); return {alive:new RegExp(String(item.processName),'i').test(String(result.stdout)),value:String(result.stdout).slice(0,500)}; }
  if(item.scheduledTask) { const result=await execFileAsync('schtasks.exe',['/Query','/TN',String(item.scheduledTask),'/FO','CSV','/NH'],{windowsHide:true,timeout:3000}).catch(()=>({stdout:''})); return {alive:String(result.stdout).trim().length>0,value:String(result.stdout).slice(0,500)}; }
  return {alive:false,value:'no process selector'};
}
function thresholdHit(value:unknown,item:Record<string,unknown>):boolean { const number=Number(value); if(!Number.isFinite(number))return false; return (item.above!==undefined&&number>Number(item.above))||(item.below!==undefined&&number<Number(item.below)); }

export function normalizeProbe(value:unknown):MonitorProbeSpec|null {
  if(!value || typeof value!=='object' || Array.isArray(value))return null;
  const input=value as Record<string,unknown>; if(!Array.isArray(input.items)||!input.items.length)return null;
  const items=input.items.filter(item=>item&&typeof item==='object'&&!Array.isArray(item)).map(item=>{
    const source={...(item as Record<string,unknown>)};
    if(!source.type) {
      if(source.path!==undefined || source.file!==undefined) source.type='file';
      else if(source.pid!==undefined || source.processName!==undefined || source.scheduledTask!==undefined) source.type='process';
      else if(source.command!==undefined) source.type='command';
      else if(Array.isArray(source.patterns)) source.type='patterns';
      else if(source.field!==undefined && (source.above!==undefined || source.below!==undefined)) source.type='threshold';
    }
    if(source.path===undefined && source.file!==undefined) source.path=source.file;
    return source;
  }) as Array<Record<string,unknown>>;
  if(!items.length)return null;
  return {items,intervalMinutes:Math.min(60,Math.max(1,Number(input.intervalMinutes)||DEFAULT_INTERVAL)),stallMinutes:Math.min(10080,Math.max(1,Number(input.stallMinutes)||DEFAULT_STALL)),heartbeatMinutes:Math.min(10080,Math.max(1,Number(input.heartbeatMinutes)||DEFAULT_HEARTBEAT))};
}

export async function runProbe(row:MonitorRecord, now=new Date()):Promise<MonitorProbeEvent|null> {
  const spec=normalizeProbe(row.probe_json?JSON.parse(row.probe_json):null); if(!spec)return null;
  const previous=row.probe_state_json?JSON.parse(row.probe_state_json) as Record<string,unknown>:{}; const state:Record<string,unknown> & {items:Record<string,unknown>;lastProgressAt?:string;lastModelAt?:string;progress?:unknown;lastEventKey?:string;lastDelta?:string;lastFields?:Record<string,unknown>}={items:{},lastProgressAt:String(previous.lastProgressAt||now.toISOString()),lastModelAt:String(previous.lastModelAt||monitorsDb.lastModelRunAt(row.id)||now.toISOString())};
  const deltas:string[]=[]; const fields:Record<string,unknown>={...previous.lastFields as Record<string,unknown>}; let done=false; let dead=false; let commandError=''; let thresholdEvidence=''; let staleFile='';
  for(let index=0;index<spec.items.length;index++) { const item=spec.items[index]; const key=itemKey(item,index); const type=String(item.type||'file');
    if(type==='file') {
      const result=await fileProbe(item,(previous.items as Record<string,unknown>)||{});
      const old=(previous.items as Record<string,{mtimeMs?:number;lastChangeAt?:string}>|undefined)?.[key];
      const lastChangeAt=result.mtimeMs!==old?.mtimeMs?now.toISOString():old?.lastChangeAt||now.toISOString();
      state.items[key]={value:result.value,offset:result.offset,mtimeMs:result.mtimeMs,lastChangeAt}; state.items[`${key}:offset`]=result.offset;
      if(result.mtimeMs!==undefined&&Date.parse(lastChangeAt)+Number(spec.stallMinutes)*60000<=now.getTime())staleFile=key;
      if(result.delta)deltas.push(`[${key}]\n${result.delta}`);
      Object.assign(fields,result.fields||parseProbeFields(bounded(result.delta),item.parse));
      if(item.field)fields[String(item.field)]=result.value; done ||= result.done;
    }
    else if(type==='command') { const result=await commandProbe(item); state.items[key]={value:result.value}; Object.assign(fields,result.fields); if(result.value!==(previous.items as Record<string,{value?:unknown}>|undefined)?.[key]?.value&&result.value)deltas.push(`[${key}]\n${result.value}`); commandError ||= result.error||''; }
    else if(type==='process') { const result=await processProbe(item); state.items[key]={value:result.value,alive:result.alive}; dead ||= !result.alive; }
    else if(type==='patterns') { state.items[key]={patterns:item.patterns||DEFAULT_PATTERNS}; }
    else if(type==='threshold') { const value=fieldAt(fields,item.field); if(thresholdHit(value,item))thresholdEvidence=`${String(item.field||'字段')}=${String(value)}`; }
  }
  const newDelta=bounded(deltas.join('\n')); const delta=bounded([String(previous.pendingDelta||''),newDelta].filter(Boolean).join('\n')); state.lastDelta=newDelta; state.pendingDelta=delta; state.lastFields=fields; state.previousFields=previous.lastFields||{};
  state.terminal=done||previous.terminal===true;
  const patterns=spec.items.filter(item=>String(item.type)==='patterns').flatMap(item=>Array.isArray(item.patterns)?item.patterns.map(String):DEFAULT_PATTERNS);
  if(!patterns.length) patterns.push(...DEFAULT_PATTERNS);
  const pattern=patterns.find(pattern=>{try{return new RegExp(pattern,'i').test(newDelta);}catch{return newDelta.toLowerCase().includes(pattern.toLowerCase());}});
  const progress=fields.progress; const previousProgress=previous.progress; if(JSON.stringify(progress)!==JSON.stringify(previousProgress))state.lastProgressAt=now.toISOString(); state.progress=progress;
  let event:MonitorProbeEvent|null=null; const status=String(fields.status||'').toLowerCase();
  if(done || /^(done|completed|success|succeeded|failed|failure)$/.test(status)&&status!==String((previous.lastFields as Record<string,unknown>|undefined)?.status||'').toLowerCase())event={type:'done',at:now.toISOString(),evidence:'探针读取到终止状态或 EXIT 行',delta,fields};
  else if(pattern || commandError)event={type:'error',at:now.toISOString(),evidence:pattern?`新增内容命中 ${pattern}`:commandError,delta,fields};
  else if(thresholdEvidence)event={type:'threshold',at:now.toISOString(),evidence:`字段超过用户设定阈值：${thresholdEvidence}`,delta,fields};
  else if(dead && !state.terminal)event={type:'dead',at:now.toISOString(),evidence:'被监视进程或计划任务已消失',delta,fields};
  else if(!state.terminal&&Date.parse(state.lastProgressAt||now.toISOString())+Number(spec.stallMinutes)*60_000<=now.getTime() && progress!==undefined)event={type:'stall',at:now.toISOString(),evidence:`progress 已 ${spec.stallMinutes} 分钟未变化`,delta,fields};
  else if(staleFile&&!state.terminal)event={type:'stall',at:now.toISOString(),evidence:`文件已 ${spec.stallMinutes} 分钟未更新：${staleFile}`,delta,fields};
  else if(Date.parse(state.lastModelAt||now.toISOString())+Number(spec.heartbeatMinutes)*60_000<=now.getTime())event={type:'heartbeat',at:now.toISOString(),evidence:`距上次模型回合已超过 ${spec.heartbeatMinutes} 分钟`,delta,fields};
  if(event?.type==='dead'&&previous.dead===true)event=null;
  state.dead=dead;
  const eventKey=event?JSON.stringify({type:event.type,evidence:event.evidence,fields:event.type==='dead'?{}:event.fields,delta:event.type==='error'?event.delta:''}):'';
  if(eventKey && eventKey===String(previous.lastEventKey||'')) event=null;
  state.lastEventKey=eventKey || (progress!==undefined && JSON.stringify(progress)!==JSON.stringify(previousProgress) ? '' : String(previous.lastEventKey||''));
  monitorsDb.saveProbeObservation(row.id,state,event,new Date(now.getTime()+Number(spec.intervalMinutes)*60_000),commandError||null,now);
  if(!event)monitorsDb.recordHeartbeat(row.id,now,`进度 ${JSON.stringify(previousProgress)??'未知'}→${JSON.stringify(progress)??'未知'}，无新事件，未调用模型。`);
  return event;
}


let probePollInFlight:Promise<number>|null=null;
export async function pollMonitorProbes(now=new Date()):Promise<number> {
  if(probePollInFlight)return probePollInFlight;
  probePollInFlight=pollDueProbes(now).finally(()=>{probePollInFlight=null;});
  return probePollInFlight;
}
async function pollDueProbes(now:Date):Promise<number> {
  const rows=monitorsDb.probeDue(now); let count=0;
  for(let index=0;index<rows.length;index+=4){const batch=rows.slice(index,index+4);await Promise.all(batch.map(async row=>{await runProbe(row,now);count++;}));}
  return count;
}
