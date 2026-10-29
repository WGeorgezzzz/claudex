import { open, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createHash } from 'node:crypto';

import type { MonitorProbeEvent, MonitorProbeSpec, MonitorRecord } from '@/shared/types.js';
import { monitorsDb } from '@/modules/database/index.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 4096;
const MAX_DELTA = 8192;
const DEFAULT_INTERVAL = 3;
const DEFAULT_STALL = 45;
const DEFAULT_HEARTBEAT = 180;
const DEFAULT_PATTERNS = ['Traceback \\(most recent call last\\):?\\s*$', 'ERROR\\b', 'OOM\\b', 'CUDA error\\b', 'EXIT [1-9]', 'Killed\\b', 'FAILED\\b'];

const itemKey = (_item:Record<string,unknown>, index:number) => `p${index}`;
const fingerprint = (value:unknown) => createHash('sha256').update(JSON.stringify(value)??'').digest('hex').slice(0,24);
const commandDeltas = new Map<string,{lastModelAt:string;delta:string}>();
const agentLog = (item:Record<string,unknown>) => /(?:codex[-_]run[^/\\]*\.log|(?:claude|codex)[^/\\]*(?:transcript|session)|(?:transcript|rollout)[^/\\]*\.jsonl|[/\\](?:\.claude[/\\]projects|\.codex[/\\]sessions)[/\\])/i.test(String(item.path||item.file||'')) || item.source==='agent';
const bounded = (value:string) => {
  const bytes=Buffer.from(value,'utf8'); if(bytes.length<=MAX_DELTA)return value;
  const marker='\n…[中间增量已截断]…\n'; const half=Math.floor((MAX_DELTA-Buffer.byteLength(marker))/2);
  return bytes.subarray(0,half).toString('utf8').replace(/\uFFFD+$/,'')+marker+bytes.subarray(-half).toString('utf8').replace(/^\uFFFD+/,'');
};
const fieldAt = (value:unknown, field?:unknown):unknown => {
  if(typeof field !== 'string' || !field) return value;
  return field.split('.').reduce((current,key)=>current && typeof current === 'object' ? (current as Record<string,unknown>)[key] : undefined, value);
};
async function fileProbe(item:Record<string,unknown>, previous:Record<string,unknown>, key:string):Promise<{value:unknown;delta:string;offset:number;done:boolean;mtimeMs?:number;fields?:Record<string,unknown>}> {
  const filePath=String(item.path||item.file||'');
  try {
    const info=await stat(filePath); const oldOffset=Number(previous[`${key}:offset`]||0); const offset=info.size<oldOffset?0:oldOffset;
    const old=previous[key] as {value?:unknown;fingerprint?:string;mtimeMs?:number;offset?:number}|undefined;
    const doneFile=/(?:^|[-_])done\.json$/i.test(path.basename(filePath));
    const mode=String(item.read||(doneFile?'json':'tail'));
    if(mode==='json') {
      const json=JSON.parse((await readFile(filePath,'utf8')).replace(/^\uFEFF/,'')); const value=fieldAt(json,item.field);
      const changed=fingerprint(value)!==(old?.fingerprint||fingerprint(old?.value));
      const status=String(fieldAt(json,'status')||'');
      const complete=item.doneField?fieldAt(json,item.doneField)===true:doneFile&&(fieldAt(json,'done')===true||/^(completed|succeeded|success|failed|failure)$/.test(status));
      const fields:Record<string,unknown>={};
      if(item.field)fields[String(item.field)]=value;
      else for(const name of ['progress','status','done','error','message'])if(fieldAt(json,name)!==undefined)fields[name]=fieldAt(json,name);
      return {value,delta:changed?JSON.stringify(value):'',offset:info.size,done:Boolean(complete),mtimeMs:info.mtimeMs,fields};
    }
    const handle=await open(filePath,'r'); try {
      const available=Math.max(0,info.size-offset); let delta='';
      if(available<=MAX_DELTA){const buffer=Buffer.alloc(available);const result=await handle.read(buffer,0,available,offset);delta=buffer.subarray(0,result.bytesRead).toString('utf8');}
      else {const half=Math.floor(MAX_DELTA/2);const head=Buffer.alloc(half);const tail=Buffer.alloc(half);const first=await handle.read(head,0,half,offset);const last=await handle.read(tail,0,half,info.size-half);delta=head.subarray(0,first.bytesRead).toString('utf8')+'\n…[文件增量中间部分已截断]…\n'+tail.subarray(0,last.bytesRead).toString('utf8');}
      const done=agentLog(item)?/^EXIT\s+\d+\s*$/m.test(delta):/^\s*(?:EXIT\s+\d+|(?:status|state)\s*[:=]\s*(?:done|completed|succeeded|failed|failure)|(?:done|completed|success)\s*[:=]\s*(?:true|yes|1))\s*$/im.test(delta);
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
  return {items,suppress:Array.isArray(input.suppress)?input.suppress.filter(value=>typeof value==='string').slice(0,16).map(value=>value.slice(0,256)):[],intervalMinutes:Math.min(60,Math.max(1,Number(input.intervalMinutes)||DEFAULT_INTERVAL)),stallMinutes:Math.min(10080,Math.max(1,Number(input.stallMinutes)||DEFAULT_STALL)),heartbeatMinutes:Math.min(10080,Math.max(1,Number(input.heartbeatMinutes)||DEFAULT_HEARTBEAT))};
}

/** Isolated model rounds reconstruct file increments from durable model offsets; command text stays in bounded memory. */
export async function hydrateProbeDelta(row:MonitorRecord):Promise<string> {
  const spec=normalizeProbe(JSON.parse(row.probe_json||'null')); if(!spec)return '';
  const state=JSON.parse(row.probe_state_json||'{}'); const deltas:string[]=[];
  for(let index=0;index<spec.items.length;index++) {
    const item=spec.items[index]; if(item.type!=='file')continue;
    const key=itemKey(item,index); const old=state.items?.[key]||{};
    const result=await fileProbe(item,{[key]:{},[`${key}:offset`]:old.modelOffset??0},key);
    if(result.delta)deltas.push(`[${key}]\n${result.delta}`);
  }
  const cached=commandDeltas.get(row.id);
  if(cached&&cached.lastModelAt===String(state.lastModelAt||''))deltas.push(cached.delta);
  return bounded(deltas.join('\n'));
}

function matchesSuppression(suppress:string[],signature:string,text:string):boolean {
  return suppress.some(value=>{if(value===signature)return true;try{return new RegExp(value,'i').test(text);}catch{return text.includes(value);}});
}

export async function runProbe(row:MonitorRecord, now=new Date()):Promise<MonitorProbeEvent|null> {
  const spec=normalizeProbe(row.probe_json?JSON.parse(row.probe_json):null); if(!spec)return null;
  const previous=row.probe_state_json?JSON.parse(row.probe_state_json) as Record<string,unknown>:{}; const state:Record<string,unknown> & {items:Record<string,unknown>;lastProgressAt?:string;lastModelAt?:string;progress?:unknown;lastEventKey?:string;lastDelta?:string;lastFields?:Record<string,unknown>}={items:{},lastProgressAt:String(previous.lastProgressAt||now.toISOString()),lastModelAt:String(previous.lastModelAt||monitorsDb.lastModelRunAt(row.id)||now.toISOString())};
  const deltas:string[]=[]; const errorDeltas:string[]=[]; const fields:Record<string,unknown>={...previous.lastFields as Record<string,unknown>}; let done=false; let dead=false; let commandError=''; let thresholdEvidence=''; let staleFile='';
  for(let index=0;index<spec.items.length;index++) { const item=spec.items[index]; const key=itemKey(item,index); const type=String(item.type||'file');
    if(type==='file') {
      const previousItems=(previous.items as Record<string,unknown>)||{};
      const legacyKey=String(item.id||item.path||item.pid||item.command||`item-${index}`);
      const oldItem=(previousItems[key]||previousItems[legacyKey]||{}) as Record<string,unknown>;
      const result=await fileProbe(item,{...previousItems,[key]:oldItem,[`${key}:offset`]:oldItem.offset??previousItems[`${legacyKey}:offset`]??0},key);
      const old=(previous.items as Record<string,{mtimeMs?:number;lastChangeAt?:string}>|undefined)?.[key];
      const lastChangeAt=result.mtimeMs!==old?.mtimeMs?now.toISOString():old?.lastChangeAt||now.toISOString();
      state.items[key]={fingerprint:fingerprint(result.value),offset:result.offset,modelOffset:oldItem.modelOffset??0,mtimeMs:result.mtimeMs,lastChangeAt};
      if(result.mtimeMs!==undefined&&Date.parse(lastChangeAt)+Number(spec.stallMinutes)*60000<=now.getTime())staleFile=key;
      if(result.delta){deltas.push(`[${key}]\n${result.delta}`);if(!agentLog(item))errorDeltas.push(result.fields?Object.values(result.fields).filter(value=>value!==null&&value!==undefined).map(value=>typeof value==='object'?JSON.stringify(value):String(value)).join('\n'):result.delta);}
      if(result.delta&&!agentLog(item)&&result.fields?.error)errorDeltas.push('ERROR '+JSON.stringify(result.fields.error));
      if(!agentLog(item))Object.assign(fields,result.fields||parseProbeFields(bounded(result.delta),item.parse));
      if(item.field)fields[String(item.field)]=result.value; done ||= result.done;
    }
    else if(type==='command') { const result=await commandProbe(item); state.items[key]={fingerprint:fingerprint(result.value)}; Object.assign(fields,result.fields); if(fingerprint(result.value)!==(previous.items as Record<string,{fingerprint?:string}>|undefined)?.[key]?.fingerprint&&result.value){deltas.push(`[${key}]\n${result.value}`);errorDeltas.push(result.value);const cached=commandDeltas.get(row.id);commandDeltas.set(row.id,{lastModelAt:String(state.lastModelAt||''),delta:bounded([cached?.lastModelAt===String(state.lastModelAt||'')?cached.delta:'',result.value].join('\n'))});if(commandDeltas.size>256)commandDeltas.delete(commandDeltas.keys().next().value!);} commandError ||= result.error||''; }
    else if(type==='process') { const result=await processProbe(item); state.items[key]={value:result.value,alive:result.alive}; dead ||= !result.alive; }
    else if(type==='patterns') { state.items[key]={patterns:item.patterns||DEFAULT_PATTERNS}; }
    else if(type==='threshold') { const value=fieldAt(fields,item.field); if(thresholdHit(value,item))thresholdEvidence=`${String(item.field||'字段')}=${String(value)}`; }
  }
  const delta=bounded(deltas.join('\n')); state.lastFields=fields; state.previousFields=previous.lastFields||{};
  state.terminal=done||previous.terminal===true||/^(done|completed|success|succeeded|failed|failure)$/i.test(String(fields.status||''));
  const patterns=spec.items.filter(item=>String(item.type)==='patterns').flatMap(item=>Array.isArray(item.patterns)?item.patterns.map(String):DEFAULT_PATTERNS);
  if(!patterns.length) patterns.push(...DEFAULT_PATTERNS);
  const errorDelta=bounded(errorDeltas.join('\n'));
  const alertLines=errorDelta.split(/\r?\n/).filter(line=>!/^\s*[-+>$]/.test(line));
  const pattern=patterns.find(pattern=>alertLines.some(line=>{try{return new RegExp(`^(?:${pattern})`,'i').test(line);}catch{return line.toLowerCase().startsWith(pattern.toLowerCase());}}));
  const progress=fields.progress; const previousProgress=previous.progress; if(JSON.stringify(progress)!==JSON.stringify(previousProgress))state.lastProgressAt=now.toISOString(); state.progress=progress;
  let event:MonitorProbeEvent|null=null; const status=String(fields.status||'').toLowerCase();
  if(done || /^(done|completed|success|succeeded|failed|failure)$/.test(status)&&status!==String((previous.lastFields as Record<string,unknown>|undefined)?.status||'').toLowerCase())event={type:'done',at:now.toISOString(),evidence:'探针读取到终止状态或 EXIT 行',delta,fields};
  else if(pattern || commandError)event={type:'error',at:now.toISOString(),evidence:pattern?`新增内容命中 ${pattern}`:commandError,delta,fields};
  else if(thresholdEvidence)event={type:'threshold',at:now.toISOString(),evidence:`字段超过用户设定阈值：${thresholdEvidence}`,delta,fields};
  else if(dead && !state.terminal)event={type:'dead',at:now.toISOString(),evidence:'被监视进程或计划任务已消失',delta,fields};
  else if(!state.terminal&&Date.parse(state.lastProgressAt||now.toISOString())+Number(spec.stallMinutes)*60_000<=now.getTime() && progress!==undefined)event={type:'stall',at:now.toISOString(),evidence:`progress 已 ${spec.stallMinutes} 分钟未变化`,delta,fields};
  else if(staleFile&&!state.terminal)event={type:'stall',at:now.toISOString(),evidence:`文件已 ${spec.stallMinutes} 分钟未更新：${staleFile}`,delta,fields};
  else if(Date.parse(state.lastModelAt||now.toISOString())+Number(spec.heartbeatMinutes)*60_000<=now.getTime())event={type:'heartbeat',at:now.toISOString(),evidence:`距上次模型回合已超过 ${spec.heartbeatMinutes} 分钟`,delta,fields};
  const stalled=!state.terminal&&(Boolean(staleFile)||(progress!==undefined&&Date.parse(state.lastProgressAt||now.toISOString())+Number(spec.stallMinutes)*60000<=now.getTime()));
  state.stallNotified=stalled&&previous.stallNotified===true;
  if(event?.type==='stall') { if(state.stallNotified)event=null;else state.stallNotified=true; }
  if(!event&&Date.parse(state.lastModelAt||now.toISOString())+Number(spec.heartbeatMinutes)*60000<=now.getTime())event={type:'heartbeat',at:now.toISOString(),evidence:`距上次模型回合已超过 ${spec.heartbeatMinutes} 分钟`,delta,fields};
  if(event?.type==='dead'&&previous.dead===true)event=null;
  state.dead=dead;
  if(event?.type==='done'&&previous.terminal===true)event=null;
  if(event)event.signature=event.type+':'+fingerprint(event.evidence.replace(/\d+/g,'#'));
  const terminal=event?.type==='done'||event?.type==='dead';
  if(event&&!terminal&&matchesSuppression(spec.suppress||[],event.signature!,event.evidence+'\n'+errorDelta))event=null;
  const pending=previous.pendingEvent as MonitorProbeEvent|undefined;
  const pendingCounts={...previous.pendingCounts as Record<string,number>};
  const lastAlertAt=Math.max(Date.parse(String(previous.lastAlertAt||''))||0,row.model_round_count?Date.parse(String(previous.lastModelAt||''))||0:0);
  const cooling=lastAlertAt>0&&lastAlertAt+Math.max(1,row.interval_minutes||15)*60000>now.getTime();
  if(event&&!terminal&&cooling) {
    const signature=event.signature!; const bucket=Object.hasOwn(pendingCounts,signature)||Object.keys(pendingCounts).length<8?signature:'other';
    pendingCounts[bucket]=(pendingCounts[bucket]||0)+1; state.pendingCounts=pendingCounts;
    state.pendingEvent={type:event.type,at:event.at,evidence:event.evidence,signature:event.signature,count:(pending&&pending.signature===signature?pending.count||0:0)+1}; event=null;
  }
  else if(!event)state.pendingEvent=pending;
  if(!event&&!cooling&&pending&&!matchesSuppression(spec.suppress||[],pending.signature||'',pending.evidence))event={...pending,at:now.toISOString(),fields,delta};
  if(event) {
    if(pending&&pending.signature===event.signature)event.count=pending.count;
    if(event.count)event.evidence+=`；冷却期同签名累计 ${event.count} 次`;
    if(Object.keys(pendingCounts).length)event.evidence+=`；冷却计数 ${JSON.stringify(pendingCounts)}`;
    state.lastEventKey=event.signature; state.lastAlertAt=now.toISOString(); delete state.pendingEvent; delete state.pendingCounts;
    event.delta=await hydrateProbeDelta({...row,probe_state_json:JSON.stringify(state)});
  } else { state.lastEventKey=String(previous.lastEventKey||''); state.lastAlertAt=previous.lastAlertAt; if(!state.pendingCounts&&Object.keys(pendingCounts).length)state.pendingCounts=pendingCounts; }
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
