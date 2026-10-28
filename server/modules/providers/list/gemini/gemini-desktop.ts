import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {getCloudCliHomeDir,createNormalizedMessage,createCompleteMessage} from '@/shared/index.js';
import type {IProviderRuntime} from '@/shared/interfaces.js';
import {getCurrentUserContext} from '@/modules/auth/index.js';
const execute=promisify(execFile),powershell=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const script=()=>path.resolve('scripts/gemini-desktop/bridge.ps1');
let cached:{at:number;value:{model:string;authenticated:boolean}}|undefined,pending:Promise<{model:string;authenticated:boolean}>|undefined;
export async function inspectGeminiDesktop(){if(cached&&Date.now()-cached.at<5000)return cached.value;if(pending)return pending;pending=execute(powershell,['-NoProfile','-ExecutionPolicy','Bypass','-File',script(),'-Operation','Inspect'],{windowsHide:true,timeout:20000,encoding:'utf8'}).then(r=>{const value=JSON.parse(r.stdout.trim());cached={at:Date.now(),value};return value;}).finally(()=>{pending=undefined;});return pending;}
let queue=Promise.resolve();const stops=new Map<string,()=>void>();
export const geminiDesktopRuntime:IProviderRuntime={
 async run(command,options,writer,context){
  const previous=queue;let release!:()=>void;queue=new Promise<void>(r=>{release=r;});
  const id=String(options.sessionId);let folder='',file='',cancelled=false;
  stops.set(id,()=>{cancelled=true;if(file)fs.writeFileSync(file+'.stop','stop');});
  const transcript=path.join(getCloudCliHomeDir(),'gemini/transcripts',id+'.jsonl');
  const persist=(role:string,text:string)=>{const row={id:randomUUID(),role,text,timestamp:new Date().toISOString()};fs.mkdirSync(path.dirname(transcript),{recursive:true});fs.appendFileSync(transcript,JSON.stringify(row)+'\n');writer.send(createNormalizedMessage({id:row.id,kind:role==='error'?'error':'text',role:role==='error'?'assistant':role,provider:'gemini',sessionId:id,content:text,timestamp:row.timestamp}));};
  try{
   await previous;if(cancelled)throw Error('Gemini 排队回合已取消，未发送到桌面');
   if(getCurrentUserContext()?.role==='member')throw Error('Gemini 桌面桥接仅限本机主账号');
   if(options.permissionMode&&options.permissionMode!=='default')throw Error('Gemini 桌面版权限由原生应用管理，请选择默认权限');
   const info=await inspectGeminiDesktop(),model=options.model||info.model,nativeId=context.resolveProviderSessionId(id);if(nativeId&&!/^[a-z0-9]{16}$/i.test(nativeId))throw Error('原CLI会话保留只读；请新建 Gemini 桌面会话');
   if(cancelled)throw Error('Gemini 本轮已取消，未发送到桌面');
   folder=fs.mkdtempSync(path.join(os.tmpdir(),'nexagent-gemini-'));file=path.join(folder,'request.json');
   fs.writeFileSync(file,JSON.stringify({sessionId:id,model,prompt:command,nativeId}));persist('user',command);
   const result=await new Promise<string>((resolve,reject)=>{let stdout='',stderr='';const child=spawn(powershell,['-NoProfile','-ExecutionPolicy','Bypass','-File',script(),'-Operation','Run','-InputFile',file],{windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>{stdout+=d;});child.stderr.on('data',d=>{stderr=(stderr+String(d)).slice(-2000);});child.once('error',reject);child.once('close',code=>code===0?resolve(stdout):reject(Error(stderr.trim()||'Gemini 桌面桥接失败')));});
   const response=JSON.parse(result.trim());if(!response.response||!response.nativeId)throw Error('Gemini 未返回已确认的回复和原生会话链接');writer.setSessionId?.(response.nativeId);persist('assistant',response.response);writer.send(createCompleteMessage({provider:'gemini',sessionId:id,exitCode:0}));
  }catch(error){persist('error',error instanceof Error?error.message:String(error));writer.send(createCompleteMessage({provider:'gemini',sessionId:id,exitCode:1}));throw error;}
  finally{stops.delete(id);try{if(folder&&path.dirname(path.resolve(folder))===path.resolve(os.tmpdir())&&path.basename(folder).startsWith('nexagent-gemini-'))fs.rmSync(folder,{recursive:true,force:true});}finally{release();}}
 },
 async abort(id){const stop=stops.get(id);if(!stop)return false;stop();return true;},
};
