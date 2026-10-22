import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { dotDb, projectsDb, sessionsDb, messageQueueDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { messageQueueService } from '@/modules/message-queue/index.js';
import { AppError, getCloudCliHomeDir } from '@/shared/index.js';

function requireDot(userId:number,sessionId:string) {
  if(!dotDb.owns(userId,sessionId))throw new AppError('Dot conversation not found.',{statusCode:404});
}

/** Dot routes and MCP tools share authenticated memory and cross-project delegation. */
export const dotService = {
  snapshot(userId:number) {return {threads:dotDb.threads(userId),memories:dotDb.memories(userId),tasks:dotDb.tasks(userId),projects:projectsDb.getProjectPaths()};},
  createThread(userId:number,title:string) {
    const workspace=path.join(getCloudCliHomeDir(),'dot-workspaces',String(userId));
    mkdirSync(workspace,{recursive:true});
    projectsDb.createProjectPath(workspace,'Dot · 个人助手');
    return dotDb.transaction(()=>{const session=sessionsService.createAppSession('claude',workspace,title.trim()||'Dot · 新对话');dotDb.addThread(userId,session.sessionId);return session;});
  },
  saveMemory(userId:number,content:string,id?:string,revision?:number) {
    if(!content.trim()||content.length>4000)throw new AppError('Memory must contain 1–4000 characters.',{statusCode:400});
    if(!id&&dotDb.memories(userId).length>=200)throw new AppError('Edit or remove an existing memory before adding more.',{statusCode:409});
    if(!dotDb.saveMemory(userId,content.trim(),id,revision))throw new AppError('Memory changed. Refresh before editing.',{statusCode:409});
    return dotDb.memories(userId);
  },
  forget(userId:number,id:string,revision:number) {
    if(!dotDb.forget(userId,id,revision))throw new AppError('Memory changed. Refresh before deleting.',{statusCode:409});
    return dotDb.memories(userId);
  },
  delegate(userId:number,sourceSessionId:string,projectId:string,content:string,requestId:string) {
    requireDot(userId,sourceSessionId);
    const project=projectsDb.getProjectById(projectId);
    if(!project||project.isArchived)throw new AppError('Choose an existing active project.',{statusCode:404});
    if(!content.trim()||content.length>20000||!/^[\w:-]{1,100}$/.test(requestId))throw new AppError('A bounded task and unique request ID are required.',{statusCode:400});
    const hash=createHash('sha256').update(JSON.stringify([sourceSessionId,projectId,content])).digest('hex');
    return dotDb.transaction(()=>{
      const previous=dotDb.byRequest(userId,requestId);
      if(previous){if(previous.payload_hash!==hash)throw new AppError('Request ID already used for another task.',{statusCode:409});return previous;}
      const source=sessionsDb.getSessionById(sourceSessionId)!;
      const session=sessionsService.createAppSession('claude',project.project_path,content);
      const row=messageQueueService.enqueue(userId,{sessionId:session.sessionId,requestId:`dot-delegate:${requestId}`,content,
        options:{model:source.model,effort:source.effort,permissionMode:'default'}},'queued',sourceSessionId);
      dotDb.addTask({id:randomUUID(),user_id:userId,source_session_id:sourceSessionId,target_session_id:session.sessionId,queue_id:row.id,request_id:requestId,payload_hash:hash,created_at:new Date().toISOString()});
      return dotDb.byRequest(userId,requestId)!;
    });
  },
  cancelPending(userId:number,id:string) {
    const task=dotDb.tasks(userId).find(row=>row.id===id);
    if(!task)throw new AppError('Task not found.',{statusCode:404});
    const row=messageQueueDb.get(userId,task.queue_id)!;
    if(row.status==='running')throw new AppError('Open the delegated conversation and use Stop to interrupt its running provider.',{statusCode:409});
    return messageQueueService.update(userId,row.id,{action:'cancel',revision:row.revision});
  },
};
