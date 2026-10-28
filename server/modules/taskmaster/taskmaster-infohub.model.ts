import { createHash } from 'node:crypto';
import type { TopicUnit } from './taskmaster-units.service.js';

export type InfohubUnit={id:number;title:string;kind:string;status:string;summary?:string;priority?:string;due_at?:number|null;updated_at:number;for_me?:number|boolean;tags?:string[];parents?:{id:number;title:string;kind?:string}[];messages?:{id:number;source:string;channel_name?:string;link?:string;text?:string}[]};
export type InfohubRecord={id:string;updatedAt:number;fingerprint:string;fieldsFingerprint:string;status:string;fields:Record<string,unknown>};
export const remoteStatus=(status:string)=>status==='done'?'done':status==='cancelled'?'dropped':'open';
export function infohubRecord(unit:InfohubUnit):InfohubRecord {
  const tags=[...new Set([...(unit.tags||[]),'source:infohub','type:todo',...(unit.for_me?['person:me']:[])])].sort();
  const link='/infohub?unit='+unit.id;
  const fields={title:unit.title,description:unit.summary||'',details:unit.summary||'',source:'infohub',sourceId:String(unit.id),
    due:unit.due_at?new Date(unit.due_at*1000).toISOString():'',priority:unit.priority==='P0'||unit.priority==='P1'?'high':unit.priority==='P3'?'low':'medium',tags,
    parentIds:[...new Set([...(unit.parents||[]).map(p=>'infohub-unit:'+p.id),...tags.filter(t=>t.startsWith('topic:')||t.startsWith('project:'))])],
    evidenceLink:link,forMe:!!unit.for_me,infohubEvidence:[{unitId:unit.id,link},...(unit.messages||[]).map(m=>({messageId:m.id,source:m.source,channel:m.channel_name,link:m.link||link,evidence:m.text?.slice(0,1500)}))]};
  return {id:String(unit.id),updatedAt:unit.updated_at*1000,status:unit.status==='done'?'done':['dropped','ignored'].includes(unit.status)?'cancelled':'pending',
    fieldsFingerprint:createHash('sha256').update(JSON.stringify(fields)).digest('hex'),
    fingerprint:createHash('sha256').update(JSON.stringify({...fields,status:unit.status,updatedAt:unit.updated_at})).digest('hex'),fields};
}
export function infohubTopics(units:InfohubUnit[]):TopicUnit[] {
  const map=new Map<string,TopicUnit>();
  const referenced=new Set(units.flatMap(unit=>(unit.parents||[]).map(parent=>parent.id)));
  for(const unit of units){
    const tags=(unit.tags||[]).filter(t=>t.startsWith('topic:')||t.startsWith('project:'));
    for(const tag of tags)map.set(tag,{id:tag,title:tag.slice(tag.indexOf(':')+1),parentIds:[]});
    if(unit.kind!=='todo'||referenced.has(unit.id))map.set('infohub-unit:'+unit.id,{id:'infohub-unit:'+unit.id,title:unit.title,parentIds:(unit.parents||[]).map(p=>'infohub-unit:'+p.id)});
    for(const parent of unit.parents||[])if(!map.has('infohub-unit:'+parent.id))map.set('infohub-unit:'+parent.id,{id:'infohub-unit:'+parent.id,title:parent.title,parentIds:[]});
  }
  return [...map.values()];
}
