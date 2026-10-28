import {readFile,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {getCurrentUserContext} from '@/modules/auth/index.js';
import {assertContextPath} from '@/modules/access-control/index.js';
import {sessionBridgeDb} from '@/modules/database/index.js';
import {sessionBridgeService} from '@/modules/session-bridge/index.js';
import {infohubRequest} from './taskmaster-infohub.service.js';

type Document={type:string;path:string;text:string;at:number;lower?:string;pathLower?:string};
let corpus:{at:number;docs:Document[]}|undefined;
const sessionCache=new Map<string,{at:number;doc:Document}>();
const completion=/完结|已完成|已交付|已合.{0,12}main|监测.{0,40}已停|["']?done["']?\s*[:=]\s*true/i;
function terms(title:string){const result=title.toLowerCase().match(/[a-z][a-z0-9._-]{1,}|[\p{Script=Han}]{2,}/gu)||[];return [...new Set(result.flatMap(word=>/^[a-z]/.test(word)?[word]:Array.from({length:Math.max(1,word.length-1)},(_,i)=>word.slice(i,i+2))).filter(word=>!['完成','任务','进行','记录','执行','实现','监测','结果','the','and'].includes(word)))];}
function score(doc:Document,words:string[]){const file=doc.pathLower??(doc.pathLower=doc.path.toLowerCase()),text=doc.lower??(doc.lower=doc.text.toLowerCase());return words.reduce((sum,word)=>sum+(file.includes(word)?(/^[a-z]/.test(word)?15:5):text.includes(word)?(/^[a-z]/.test(word)?3:1):0),0);}
function fragment(doc:Document,words:string[]){const lines=doc.text.split(/\r?\n/);let best=0,weight=-1;for(let i=0;i<lines.length;i++){const terminal=/完结|提前收尾|已收尾|已停止|已交付|监测.{0,40}已停|["']?done["']?\s*[:=]\s*true/i.test(lines[i]);const value=words.reduce((sum,word)=>sum+(lines[i].toLowerCase().includes(word)?3:0),0)+(terminal?40:completion.test(lines[i])?14:0);if(value>weight){weight=value;best=i;}}const line=lines[best],match=line.search(completion);const center=line.length>450&&match>=0?line.slice(Math.max(0,match-150),match+300):line.slice(0,450);return [center,lines[best-1]?.slice(-90),lines[best+1]?.slice(0,90)].filter(Boolean).join('\n');}
async function document(file:string,type:string){try{assertContextPath(file);const meta=await stat(file);if(meta.size>2000000)return null;return {type,path:file,text:(await readFile(file,'utf8')).slice(0,180000),at:meta.mtimeMs};}catch{return null;}}
async function index(){if(corpus&&Date.now()-corpus.at<300000)return corpus.docs;const docs:Document[]=[];if(getCurrentUserContext()?.role==='admin'){
 try{const dirs=(await readdir('D:/embodied',{withFileTypes:true})).filter(d=>d.isDirectory()).slice(0,3000);for(let start=0;start<dirs.length;start+=30){const found=await Promise.all(dirs.slice(start,start+30).flatMap(dir=>['STATUS.md','DONE.json','REPORT_zh.md','CONCLUSION_zh.md'].map(name=>document(path.join('D:/embodied',dir.name,name),'file'))));docs.push(...found.filter((doc):doc is Document=>doc!==null));}}catch{}
 const memory=path.join(os.homedir(),'.claude-cc/projects/D--embodied/memory');try{const found=await Promise.all((await readdir(memory)).filter(name=>name.endsWith('.md')).map(name=>document(path.join(memory,name),'memory')));docs.push(...found.filter((doc):doc is Document=>doc!==null));}catch{}
 }corpus={at:Date.now(),docs};return docs;}

/** Task intelligence reads five task-specific source passages, including completed project memories, without modifying source files. */
export async function retrieveTaskEvidence(tasks:{id:string;title:string;description?:string;project:string;root:string;sessionIds:string[]}[]){
 const base=await index(),result:{type:string;path:string;excerpt:string;taskId:string}[]=[];
 let units:Document[]=[];try{const items=await infohubRequest('/api/units?limit=300&order=activity');if(Array.isArray(items))units=items.map(item=>({type:'infohub',path:'/infohub/#unit/'+String(item.id),text:JSON.stringify(item),at:Date.now()}));}catch{}
 for(const task of tasks){const words=terms(task.title+' '+task.project+' '+String(task.description||'').slice(0,300));const own=(await Promise.all(['STATUS.md','DONE.json','REPORT_zh.md','CONCLUSION_zh.md'].map(name=>document(path.join(task.root,name),'file')))).filter((doc):doc is Document=>doc!==null);
  const candidates=[...own,...base,...units].map(doc=>({doc,score:score(doc,words)})).filter(item=>item.score>=3).sort((a,b)=>b.score-a.score||b.doc.at-a.doc.at).slice(0,12);
  const query=words.find(word=>/^[a-z]/.test(word)&&word.length>2)||words[0]||task.title.slice(0,8);let sessions:{sessionId:string;title?:string}[]=[];try{sessions=sessionBridgeDb.search(query,5,0).sessions;}catch{}
  const ids=[...new Set([...task.sessionIds,...sessions.slice(0,3).map(session=>session.sessionId)])].slice(0,4);
  for(const id of ids)try{let cached=sessionCache.get(id);if(!cached||Date.now()-cached.at>300000){const history=await sessionBridgeService.read(id,0);cached={at:Date.now(),doc:{type:'session',path:'/session/'+history.sessionId,text:history.title+'\n'+history.messages.filter(m=>m.role==='assistant').slice(-1).map(m=>m.content).join('\n'),at:Date.now()}};sessionCache.set(id,cached);}candidates.push({doc:cached.doc,score:score(cached.doc,words)});}catch{}
  const seen=new Set<string>();for(const candidate of candidates.sort((a,b)=>b.score-a.score||b.doc.at-a.doc.at)){if(seen.has(candidate.doc.path))continue;seen.add(candidate.doc.path);result.push({type:candidate.doc.type,path:candidate.doc.path,excerpt:fragment(candidate.doc,words),taskId:task.id});if(seen.size>=5)break;}
 }
 return result;
}
