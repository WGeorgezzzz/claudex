import path from 'node:path';
import fs from 'node:fs/promises';
import { withUserContext } from '@/modules/auth/index.js';
import { getConnection, projectsDb } from '@/modules/database/index.js';
import { assertContextPath } from '@/modules/access-control/index.js';
import { getCloudCliHomeDir } from '@/shared/index.js';
import { taskmasterWorkspace } from './taskmaster-auto.service.js';
import { infohubRecord, infohubTopics, remoteStatus } from './taskmaster-infohub.model.js';
import type { InfohubUnit } from './taskmaster-infohub.model.js';

type SyncStatus={online:boolean;lastSyncedAt:string|null;error:string|null;imported:number;merged:unknown[];unmatchedLegacy:unknown[];tags:unknown[]};
const states=new Map<number,SyncStatus>(),pending=new Map<number,Promise<SyncStatus>>();
const details=new Map<string,InfohubUnit>();
const topology=new Map<number,string>();
let timer:ReturnType<typeof setInterval>|undefined;
export const infohubSyncStatus=(userId:number):SyncStatus=>states.get(userId)||{online:false,lastSyncedAt:null,error:'正在连接信息看板',imported:0,merged:[],unmatchedLegacy:[],tags:[]};

function baseUrl(){const base=new URL(process.env.INFOHUB_BASE_URL||'http://127.0.0.1:8765');if(base.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||base.username||base.password)throw Error('信息看板仅支持本机连接');return base;}
export async function infohubRequest(endpoint:string,body?:unknown):Promise<unknown> {
  let token=process.env.INFOHUB_API_TOKEN;
  if(!token)try{token=JSON.parse(await fs.readFile(path.join(getCloudCliHomeDir(),'secrets','infohub-tasks.json'),'utf8')).token;}catch{/* An unauthenticated local info-hub needs no additional account. */}
  const response=await fetch(new URL(endpoint,baseUrl()),{method:body?'POST':'GET',headers:{accept:'application/json',...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000),redirect:'error'});
  if(!response.ok)throw Error(response.status===401?'信息看板连接未授权':'信息看板请求失败（'+response.status+'）');
  return response.json();
}

/** One serial HTTP reconciliation per account; task rendering never waits for this connection. */
export function syncInfohubTasks(userId:number):Promise<SyncStatus> {
  const current=pending.get(userId);if(current)return current;
  const job=withUserContext(userId,async()=>{
    const previous=infohubSyncStatus(userId);
    try{
      const units=await infohubRequest('/api/units?limit=10000&order=activity') as InfohubUnit[];
      if(!Array.isArray(units)||units.length>=10000)throw Error('信息看板单元超出单次范围，请缩小同步范围后重试');
      const tags=await infohubRequest('/api/tags') as unknown[];
      const selected=units.filter(u=>(u.for_me||u.tags?.includes('type:deadline'))&&(u.kind==='todo'||!!u.due_at&&u.tags?.includes('type:deadline')));
      const root=path.resolve(process.env.TASKMASTER_INBOX_ROOT||'D:/embodied/inbox-todos');
      assertContextPath(root);assertContextPath(path.join(root,'.taskmaster'));
      const project=projectsDb.createProjectPath(root,'收件箱待办').project;if(!project)throw Error('无法注册任务项目');
      const existing=(await taskmasterWorkspace.list(root,userId)).tasks;
      const linked=new Map(existing.filter(t=>t.source==='infohub').map(t=>[String(t.sourceId),t]));
      const all:InfohubUnit[]=[];
      const graphVersion=JSON.stringify(units.map(u=>[u.id,(u as InfohubUnit&{n_children?:number}).n_children||0]).sort((a,b)=>Number(a[0])-Number(b[0])));
      const graphChanged=topology.get(userId)!==graphVersion;
      const load=async(unit:InfohubUnit):Promise<InfohubUnit>=>{
        const key=userId+':'+baseUrl().href+':'+unit.id,cached=details.get(key);
        const hasLocalEdit=linked.has(String(unit.id))&&((linked.get(String(unit.id))!.infohub as {lastSyncedStatus?:string}|undefined)?.lastSyncedStatus!==linked.get(String(unit.id))!.status);
        const changed=!cached||JSON.stringify([cached.updated_at,cached.status,cached.tags,cached.title,cached.summary,cached.due_at,cached.priority,cached.for_me])!==JSON.stringify([unit.updated_at,unit.status,unit.tags,unit.title,unit.summary,unit.due_at,unit.priority,unit.for_me]);
        if(changed||hasLocalEdit||graphChanged){const next=await infohubRequest('/api/unit/'+unit.id+'?depth=2') as InfohubUnit;details.set(key,next);return next;}
        return cached;
      };
      for(const unit of selected)all.push(await load(unit));
      // Reconcile already linked records even if they lose their "for me" flag or drop out of the todo view.
      for(const id of linked.keys())if(!all.some(u=>String(u.id)===id)){
        const listed=units.find(u=>String(u.id)===id);if(listed)all.push(await load(listed));
      }
      const parents:InfohubUnit[]=[];const visited=new Set(all.map(u=>u.id));
      const addParents=async(unit:InfohubUnit,depth=0)=>{if(depth>20)throw Error('信息看板主题层级过深');for(const parent of unit.parents||[]){if(visited.has(parent.id))continue;visited.add(parent.id);const full=await infohubRequest('/api/unit/'+parent.id+'?depth=2') as InfohubUnit;parents.push(full);await addParents(full,depth+1);}};
      for(const unit of all)await addParents(unit);
      let result=await taskmasterWorkspace.reconcileInfohub(root,userId,all.map(infohubRecord),infohubTopics([...parents,...all]));
      const merges=[...result.merges];
      for(const write of result.writes){
        const latest=await infohubRequest('/api/unit/'+write.unitId+'?depth=2') as InfohubUnit;
        if(latest.updated_at*1000>write.expectedUpdatedAt)continue; // Another editor changed the unit after our read.
        await infohubRequest('/api/unit/'+write.unitId,{status:remoteStatus(write.status)});
        const confirmed=await infohubRequest('/api/unit/'+write.unitId+'?depth=2') as InfohubUnit;
        if(confirmed.status!==remoteStatus(write.status))throw Error('信息看板状态写回未确认，稍后重试');
        details.set(userId+':'+baseUrl().href+':'+confirmed.id,confirmed);
        const index=all.findIndex(u=>u.id===confirmed.id);if(index>=0)all[index]=confirmed;
      }
      if(result.writes.length)result=await taskmasterWorkspace.reconcileInfohub(root,userId,all.map(infohubRecord),infohubTopics([...parents,...all]));
      const next={online:true,lastSyncedAt:new Date().toISOString(),error:null,imported:result.imported,merged:[...previous.merged,...merges],unmatchedLegacy:result.unmatchedLegacy,tags};
      topology.set(userId,graphVersion);states.set(userId,next);return next;
    }catch(error){const next={...previous,online:false,error:error instanceof Error?error.message:'信息看板离线，稍后同步'};states.set(userId,next);return next;}
  }).finally(()=>pending.delete(userId));
  pending.set(userId,job);return job;
}

/** The personal local info-hub belongs to the primary administrator, never member accounts. */
export function initializeInfohubTaskSync(){
  if(timer)return;
  const poll=()=>{const admin=getConnection().prepare("SELECT id FROM users WHERE role='admin' AND deleted_at IS NULL ORDER BY id LIMIT 1").get() as {id:number}|undefined;if(admin)void syncInfohubTasks(admin.id).catch(error=>console.warn('[InfoHub tasks]',String(error)));};
  timer=setInterval(poll,30000);timer.unref();poll();
}
export function closeInfohubTaskSync(){clearInterval(timer);timer=undefined;}
