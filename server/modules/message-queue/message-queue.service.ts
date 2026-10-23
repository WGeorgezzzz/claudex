import { createHash } from 'node:crypto';

import { withUserContext } from '@/modules/auth/index.js';
import { getSessionOwnerId, messageQueueDb, sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

const conflict=()=>new AppError('The queued message changed or has already started. Refresh before editing.',{code:'QUEUE_CONFLICT',statusCode:409});

/** Queue routes validate ownership and immutable request identity through this service. */
export const messageQueueService = {
  enqueue(userId: number, input: Record<string,unknown>, delivery: 'queued'|'live'='queued', bridgeSourceSessionId?: string) {
    const sessionId=typeof input.sessionId==='string'?input.sessionId:'';
    const requestId=typeof input.requestId==='string'?input.requestId:'';
    const content=typeof input.content==='string'?input.content:'';
    if (getSessionOwnerId(sessionId)!==userId) throw new AppError('Conversation belongs to another user or is unavailable.',{statusCode:403});
    if (bridgeSourceSessionId && getSessionOwnerId(bridgeSourceSessionId)!==userId) throw new AppError('Conversation belongs to another user or is unavailable.',{statusCode:403});
    const session=withUserContext(userId,()=>sessionsDb.getSessionById(sessionId));
    if (!session || session.isArchived || !/^[\w:-]{1,128}$/.test(requestId) || content.length>200_000) {
      throw new AppError('Choose an active conversation and supply a request ID and a bounded message.',{code:'INVALID_QUEUE_MESSAGE',statusCode:400});
    }
    const raw=input.options && typeof input.options==='object' && !Array.isArray(input.options)?input.options as Record<string,unknown>:{};
    if (delivery==='live' && ['images','files','attachments'].some(key=>Array.isArray(raw[key]) && (raw[key] as unknown[]).length)) {
      throw new AppError('Live additions currently accept text. Add attachments to the next-turn queue.',{statusCode:400});
    }
    const options: Record<string,unknown>={};
    for (const key of ['model','effort','sessionSummary']) if (typeof raw[key]==='string') options[key]=String(raw[key]).slice(0,1000);
    const mode=raw.permissionMode??'default';
    if (!['default','acceptEdits','plan','bypassPermissions','auto'].includes(String(mode))) throw new AppError('Invalid permission mode.',{statusCode:400});
    options.permissionMode=mode;
    // Only the internal bridge service supplies provenance; HTTP payloads cannot forge it.
    if (bridgeSourceSessionId) options.cloudcliBridgeSourceSessionId = bridgeSourceSessionId;
    for (const key of ['allowedTools','disallowedTools']) {
      if (Array.isArray(raw[key])) options[key]=(raw[key] as unknown[]).filter(value=>typeof value==='string').slice(0,100);
    }
    // The runtime gateway revalidates every attachment against the upload store.
    for (const key of ['attachments','images','files']) if (Array.isArray(raw[key])) options[key]=(raw[key] as unknown[]).slice(0,40);
    if (!content.trim() && !['attachments','images','files'].some(key=>Array.isArray(options[key]) && (options[key] as unknown[]).length)) {
      throw new AppError('The message is empty.',{statusCode:400});
    }
    const serialized=JSON.stringify(options);
    if (serialized.length>1_000_000) throw new AppError('Attachment metadata is too large.',{statusCode:400});
    const hash=createHash('sha256').update(JSON.stringify(delivery==='live'?[sessionId,content,options,'live']:[sessionId,content,options])).digest('hex');
    const existing=messageQueueDb.byRequest(userId,requestId);
    if (existing) {
      if (existing.payload_hash!==hash) throw new AppError('Request ID was already used for different input.',{code:'REQUEST_CONFLICT',statusCode:409});
      return existing;
    }
    if (messageQueueDb.list(userId,sessionId).filter(row=>row.status==='queued').length>=100) {
      throw new AppError('This conversation already has 100 queued messages.',{statusCode:409});
    }
    return messageQueueDb.create(userId,sessionId,requestId,hash,content,serialized,delivery);
  },
  list(userId: number, sessionId: string) {
    if (!sessionId) throw new AppError('A session ID is required.',{statusCode:400});
    if (getSessionOwnerId(sessionId)!==userId) throw new AppError('Conversation belongs to another user or is unavailable.',{statusCode:403});
    return messageQueueDb.list(userId,sessionId);
  },
  update(userId: number, id: string, input: Record<string,unknown>) {
    const row=messageQueueDb.get(userId,id);
    if (!row) throw new AppError('Queued message was not found.',{code:'QUEUE_NOT_FOUND',statusCode:404});
    if (getSessionOwnerId(row.session_id)!==userId) throw new AppError('Conversation belongs to another user or is unavailable.',{statusCode:403});
    if (!Number.isSafeInteger(input.revision)) throw conflict();
    if (input.action==='move-up'||input.action==='move-down') {
      if(!messageQueueDb.move(userId,id,Number(input.revision),input.action==='move-up'?'up':'down'))throw conflict();
      return messageQueueDb.get(userId,id)!;
    }
    if (input.action==='retry' && row.delivery_mode==='live') {
      if (row.revision!==input.revision || !['failed','interrupted'].includes(row.status)) throw conflict();
      // Explicit recovery creates a normal queued turn; the uncertain live receipt stays intact.
      return this.enqueue(userId,{sessionId:row.session_id,requestId:`live-retry:${row.id}:${row.revision}`,content:row.content,options:JSON.parse(row.options)});
    }
    if (input.action==='cancel' || input.action==='retry') {
      if (!messageQueueDb.action(userId,id,Number(input.revision),input.action)) throw conflict();
    } else {
      if (typeof input.content!=='string' || !input.content.trim() || input.content.length>200_000) throw new AppError('A bounded, non-empty message is required.',{statusCode:400});
      if (!messageQueueDb.edit(userId,id,Number(input.revision),input.content)) throw conflict();
    }
    return messageQueueDb.get(userId,id)!;
  },
  attempts(userId: number, id: string) {
    const row=messageQueueDb.get(userId,id);
    if (!row) throw new AppError('Queued message was not found.',{statusCode:404});
    if (getSessionOwnerId(row.session_id)!==userId) throw new AppError('Conversation belongs to another user or is unavailable.',{statusCode:403});
    return messageQueueDb.attempts(userId,id);
  },
};
