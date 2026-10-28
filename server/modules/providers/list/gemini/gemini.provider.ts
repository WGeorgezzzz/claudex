import { readGeminiModels } from './gemini-models.js';
import { geminiDesktopRuntime,inspectGeminiDesktop } from './gemini-desktop.js';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { sessionsDb } from '@/modules/database/index.js';
import { getCurrentUserContext } from '@/modules/auth/index.js';
import { buildDefaultProviderCurrentActiveModel, createNormalizedMessage, getCloudCliHomeDir, sliceTailPage } from '@/shared/index.js';
import type { IProviderAuth,IProviderModels,IProviderRuntime,IProviderSessions,IProviderSkills,IProviderMcp } from '@/shared/interfaces.js';
import type { AnyRecord,FetchHistoryOptions,NormalizedMessage } from '@/shared/types.js';

export function geminiInstallation(){
  if(getCurrentUserContext()?.role==='member')return null;
  const local=process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData/Local');
  const desktop=path.join(local,'Google/Gemini/Gemini.exe'),cli=path.join(local,'agy/bin/agy.exe');
  return existsSync(desktop)||existsSync(cli)?{desktop:existsSync(desktop)?desktop:null,cli:existsSync(cli)?cli:null,home:path.join(os.homedir(),'.gemini/antigravity-cli')}:null;
}
const transcript=(id:string)=>{if(!/^[\w-]{1,120}$/.test(id))throw new Error('Invalid Gemini session');return path.join(getCloudCliHomeDir(),'gemini/transcripts',id+'.jsonl');};
const unsupported=async():Promise<never>=>{throw new Error('Gemini 登录、权限、技能与 MCP 请在原生桌面版管理，Nexagent 不修改其配置。');};

/** Only metadata is read from native SQLite; opaque protobuf steps are never guessed into messages. */
function nativeSummaries(){
  const install=geminiInstallation();if(!install)return [];
  const file=path.join(install.home,'conversation_summaries.db');if(!existsSync(file))return [];
  const db=new Database(file,{readonly:true,fileMustExist:true});
  try{return db.prepare('SELECT conversation_id,title,preview,last_modified_time,last_user_input_time,workspace_uris FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 10000').all() as {conversation_id:string;title:string;preview:string;last_modified_time:string;last_user_input_time:string;workspace_uris:string}[];}finally{db.close();}
}
class GeminiSessions implements IProviderSessions{
  normalizeMessage(raw:unknown,sessionId:string|null){const row=raw as AnyRecord;if(!row||!['user','assistant','error'].includes(row.role))return [];return [createNormalizedMessage({id:row.id,provider:'gemini',sessionId,kind:row.role==='error'?'error':'text',role:row.role==='error'?'assistant':row.role,content:row.text,timestamp:row.timestamp})];}
  async fetchHistory(sessionId:string,options:FetchHistoryOptions={}){
    let messages:NormalizedMessage[]=[];
    try{messages=readFileSync(transcript(sessionId),'utf8').split('\n').filter(Boolean).flatMap(line=>{try{return this.normalizeMessage(JSON.parse(line),sessionId);}catch{return [];}});}catch{/* Imported native sessions have no app-owned transcript. */}
    if(!messages.length){const summary=nativeSummaries().find(s=>s.conversation_id===(options.providerSessionId||sessionId));if(summary)messages=[createNormalizedMessage({id:'gemini-summary:'+summary.conversation_id,provider:'gemini',sessionId,kind:'text',role:'assistant',timestamp:summary.last_modified_time,content:'Gemini 原生会话只读摘要\n'+summary.title+'\n'+summary.preview+'\n\n完整历史保存在原生 protobuf 数据库，请在 Gemini 桌面版查看。'})];}
    const offset=options.offset||0,limit=options.limit??null,page=sliceTailPage(messages,limit,offset);return {messages:page.page,total:messages.length,hasMore:page.hasMore,offset,limit};
  }
}

const runtime=geminiDesktopRuntime;

export function openGeminiDesktop(){const install=geminiInstallation();if(!install?.desktop)throw new Error('未发现 Gemini 桌面版');const child=spawn(install.desktop,[],{windowsHide:true,detached:true,stdio:'ignore'});child.unref();return {opened:true};}

export class GeminiProvider extends AbstractProvider{
  readonly runtime=runtime;
  readonly sessions=new GeminiSessions();
  readonly auth:IProviderAuth={async getStatus(){const i=geminiInstallation();if(!i)return {provider:'gemini',installed:false,authenticated:false,email:null,method:'local_desktop'};try{const info=await inspectGeminiDesktop();return {provider:'gemini',installed:true,authenticated:info.authenticated,email:null,method:'local_desktop'};}catch(error){return {provider:'gemini',installed:true,authenticated:false,email:null,method:'local_desktop',error:error instanceof Error?error.message:String(error)};}}};
  readonly models:IProviderModels={async getSupportedModels(){return readGeminiModels(geminiInstallation()?.cli);},async getCurrentActiveModel(){return buildDefaultProviderCurrentActiveModel(await readGeminiModels(geminiInstallation()?.cli));}};
  readonly skills:IProviderSkills={listSkills:async()=>[],addSkills:unsupported,removeSkill:unsupported};
  readonly mcp:IProviderMcp={listServers:async()=>({user:[],project:[],local:[]}),listServersForScope:async()=>[],upsertServer:unsupported,removeServer:unsupported};
  readonly sessionSynchronizer={async synchronize(){let count=0;for(const s of nativeSummaries()){let workspace=os.homedir();try{const uris=JSON.parse(s.workspace_uris);const uri=Array.isArray(uris)?uris[0]:null;if(typeof uri==='string')workspace=uri.startsWith('file:')?fileURLToPath(uri):uri;}catch{/* Native projects without a workspace remain in the local home project. */}sessionsDb.createSession(s.conversation_id,'gemini',workspace,s.title||'Gemini 会话',s.last_user_input_time,s.last_modified_time,path.join(geminiInstallation()!.home,'conversations',s.conversation_id+'.db'));count++;}return count;},synchronizeFile:async()=>null};
  constructor(){super('gemini');}
}
