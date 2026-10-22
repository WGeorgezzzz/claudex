import { sessionWorkspaceDb, sessionsDb } from '@/modules/database/index.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/index.js';

/** Routes expose organization and attention state without mutating provider sessions or interrupting a run. */
export const sessionWorkspaceService={
  list(userId:number) {
    const rows=new Map(sessionWorkspaceDb.list(userId).map(row=>[row.sessionId,row]));
    for(const sessionId of chatRunRegistry.listOwnedSessionIds(userId)) {
      const approvals=providerRuntimeService.getPendingApprovalsForSession(sessionId).length;
      if(!approvals)continue;
      const entry=rows.get(sessionId)??sessionWorkspaceDb.get(userId,sessionId);
      if(entry)rows.set(sessionId,{...entry,approvalCount:approvals});
    }
    return [...rows.values()];
  },
  get(userId:number,sessionId:string) {
    const entry=sessionWorkspaceDb.get(userId,sessionId);
    if(!entry)throw new AppError('Conversation was not found.',{statusCode:404});
    return entry;
  },
  update(userId:number,sessionId:string,input:Record<string,unknown>) {
    const session=sessionsDb.getSessionById(sessionId);
    if(!session)throw new AppError('Conversation was not found.',{statusCode:404});
    const changes:{pinned?:boolean;unread?:boolean;queuePaused?:boolean;readThrough?:string|null}={};
    for(const key of ['pinned','unread','queuePaused'] as const) {
      if(input[key]!==undefined) {
        if(typeof input[key]!=='boolean')throw new AppError(`${key} must be a boolean.`,{statusCode:400});
        changes[key]=input[key];
      }
    }
    if(!Object.keys(changes).length)throw new AppError('No supported change was supplied.',{statusCode:400});
    if(input.readThrough!==undefined) {
      if(input.readThrough!==null && (typeof input.readThrough!=='string'||!Number.isFinite(Date.parse(input.readThrough))))throw new AppError('Invalid read timestamp.',{statusCode:400});
      changes.readThrough=input.readThrough===null?null:new Date(String(input.readThrough)).toISOString();
    }
    if(session.isArchived && changes.pinned)throw new AppError('Restore this conversation before pinning it.',{statusCode:409});
    return sessionWorkspaceDb.update(userId,sessionId,changes);
  },
};
