import { withUserContext } from '@/modules/auth/index.js';
import { getSessionOwnerId, sessionsDb, sideChatsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { broadcastSessionUpserted } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';
import type { SideChatRecord } from '@/shared/types.js';

const inFlight = new Map<string, Promise<SideChatRecord>>();
const invalid = (message: string) => new AppError(message,{code:'INVALID_SIDE_CHAT',statusCode:400});

/** Routes and lifecycle tests use this factory; only the provider fork operation is injectable. */
export function createSideChatsService(
  fork = sessionsService.forkSessionById.bind(sessionsService),
  completedAnchor = sessionsService.getCompletedForkAnchorById.bind(sessionsService),
) {
  return {
    list(userId: number, parentId: string) {
      if (getSessionOwnerId(parentId)!==userId) throw new AppError('Conversation belongs to another user or is unavailable.',{statusCode:403});
      return sideChatsDb.list(userId,parentId).filter(row=>getSessionOwnerId(row.child_session_id)===userId || (getSessionOwnerId(row.child_session_id)===null && (row.status==='creating' || row.status==='failed')));
    },
    async create(userId: number, input: Record<string,unknown>): Promise<SideChatRecord> {
      const parentId=typeof input.parentSessionId==='string'?input.parentSessionId:'';
      const requestId=typeof input.requestId==='string'?input.requestId:'';
      const title=typeof input.title==='string'?input.title.trim():'Side conversation';
      if (!/^[\w:-]{1,128}$/.test(requestId) || !title || title.length>120) throw invalid('A request ID and a title up to 120 characters are required.');
      if (getSessionOwnerId(parentId)!==userId) throw new AppError('Conversation belongs to another user or is unavailable.',{statusCode:403});
      const parent=withUserContext(userId,()=>sessionsDb.getSessionById(parentId));
      if (!parent || parent.isArchived) throw invalid('Choose an existing, unarchived parent conversation.');
      if (input.ensureDefault===true) {
        const active=this.list(userId,parentId).find(candidate=>candidate.status==='active' || candidate.status==='creating');
        if (active) return inFlight.get(active.id) ?? active;
      }
      let row=sideChatsDb.byRequest(userId,requestId);
      if (row) {
        const childOwner=getSessionOwnerId(row.child_session_id);
        if (getSessionOwnerId(row.parent_session_id)!==userId || (childOwner!==null && childOwner!==userId)) throw new AppError('Conversation belongs to another user or is unavailable.',{statusCode:403});
        if (row.parent_session_id!==parentId || row.request_title!==title) throw new AppError('Request ID was already used for different input.',{code:'REQUEST_CONFLICT',statusCode:409});
        if (inFlight.has(row.id)) return inFlight.get(row.id)!;
        if (row.status==='creating') throw new AppError('Creation is still pending. Refresh its status before retrying.',{code:'SIDE_CHAT_PENDING',statusCode:409});
        return row;
      }
      row=sideChatsDb.reserve(userId,parentId,requestId,title);
      const reserved=row;
      const operation=(async () => {
        try {
          const upToAnchorId=await withUserContext(userId,()=>completedAnchor(parentId));
          await withUserContext(userId,()=>fork(parentId,{title,upToAnchorId},reserved.child_session_id));
          // The SDK can rewrite the copied final reply's timestamp while forking.
          // Capture the display boundary after copying, before the child is exposed.
          return sideChatsDb.update(userId,reserved.id,'active',title,null,new Date().toISOString());
        } catch (reason) {
          const child=getSessionOwnerId(reserved.child_session_id)===userId ? withUserContext(userId,()=>sessionsDb.getSessionById(reserved.child_session_id)) : null;
          if (child?.forked_from_session_id===parentId) {
            return sideChatsDb.update(userId,reserved.id,'active',title,null,new Date().toISOString());
          }
          sideChatsDb.update(userId,reserved.id,'failed',title,(reason instanceof Error?reason.message:String(reason)).slice(0,1000));
          throw reason;
        } finally { inFlight.delete(reserved.id); }
      })();
      inFlight.set(reserved.id,operation);
      return operation;
    },
    adopt(userId: number, parentId: string, childId: string): SideChatRecord {
      if (getSessionOwnerId(parentId)!==userId || getSessionOwnerId(childId)!==userId) throw new AppError('Conversation belongs to another user or is unavailable.',{statusCode:403});
      const child=withUserContext(userId,()=>sessionsDb.getSessionById(childId));
      if (!child || child.forked_from_session_id!==parentId) throw invalid('Only a verified fork of this parent can be imported.');
      const existing=sideChatsDb.list(userId,parentId).find(row=>row.child_session_id===childId);
      if (existing) return existing;
      const title=child.custom_name || 'Side conversation';
      try {
        const created=String(child.created_at||'').replace(' ','T');
        const time=Date.parse(created.endsWith('Z')?created:`${created}Z`);
        const row=sideChatsDb.reserve(userId,parentId,`legacy:${childId}`,title,childId,Number.isFinite(time)?new Date(time).toISOString():undefined);
        return sideChatsDb.update(userId,row.id,child.isArchived?'archived':'active',title);
      } catch {
        throw new AppError('This conversation is already managed by another owner.',{code:'SIDE_CHAT_CONFLICT',statusCode:409});
      }
    },
    async update(userId: number, id: string, input: Record<string,unknown>): Promise<SideChatRecord> {
      const row=sideChatsDb.get(userId,id);
      if (!row) throw new AppError('Side conversation was not found.',{code:'SIDE_CHAT_NOT_FOUND',statusCode:404});
      if (getSessionOwnerId(row.parent_session_id)!==userId || (getSessionOwnerId(row.child_session_id)!==null && getSessionOwnerId(row.child_session_id)!==userId)) throw new AppError('Conversation belongs to another user or is unavailable.',{statusCode:403});
      if (row.status==='creating') throw new AppError('Creation is still pending.',{code:'SIDE_CHAT_PENDING',statusCode:409});
      const title=typeof input.title==='string'?input.title.trim():row.title;
      if (!title || title.length>120) throw invalid('Title must contain 1–120 characters.');
      const status=input.action===undefined?row.status:
        input.action==='archive'?'archived':input.action==='restore'?'active':input.action==='promote'?'promoted':null;
      if (!status) throw invalid('Unknown side conversation action.');
      if (row.status==='promoted' && input.action) throw new AppError('This is now a main conversation; manage it from the main sidebar.',{statusCode:409});
      if (row.status==='failed' && (status==='active' || status==='promoted')) throw invalid('This creation failed; create a new side conversation.');
      // Archiving is organization only. No runtime stop, transcript deletion or parent mutation.
      const next=sideChatsDb.update(userId,id,status,title,row.error);
      if (getSessionOwnerId(row.child_session_id)===userId) withUserContext(userId,()=>sessionsService.renameSessionById(row.child_session_id,title));
      if (status==='promoted') await broadcastSessionUpserted(row.child_session_id);
      return next;
    },
  };
}

/** Side-chat HTTP routes share the production service instance. */
export const sideChatsService=createSideChatsService();
