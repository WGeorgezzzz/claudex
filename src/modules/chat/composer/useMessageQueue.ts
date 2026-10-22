import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiErrorMessage } from '@/shared/api';
import type { QueuedConversationMessage, QueuedMessageAttempt, QueueSubmission, QueueMessageChange, SessionWorkspaceEntry } from '@/shared/types';

async function readQueueResult<T>(response: Response): Promise<T> {
  const body=await response.json();
  if (!response.ok) throw new Error(readApiErrorMessage(body)||`HTTP ${response.status}`);
  return body.data as T;
}

/** ChatInterface uses durable server snapshots; transport retries reuse the same request ID. */
export function useMessageQueue(sessionId: string|null) {
  // A snapshot belongs only to the session that requested it.
  const [snapshot,setSnapshot]=useState<{sessionId:string|null;items:QueuedConversationMessage[];paused:boolean|null}>({sessionId,items:[],paused:null});
  // Transport errors remain visible while the composer's original input stays editable.
  const [error,setError]=useState('');
  const currentSession=useRef(sessionId);
  currentSession.current=sessionId;
  const requestSequence=useRef(0);
  const reload=useCallback(async()=>{
    if (!sessionId) return;
    const sequence=++requestSequence.current;
    const [items,state]=await Promise.all([
      api.messageQueue.list(sessionId).then(readQueueResult<QueuedConversationMessage[]>),
      api.sessionWorkspace?.get(sessionId).then(readQueueResult<SessionWorkspaceEntry>).catch(()=>null)??Promise.resolve(null),
    ]);
    if (!Array.isArray(items)) throw new Error('Invalid message queue response.');
    if (currentSession.current===sessionId && sequence===requestSequence.current) setSnapshot({sessionId,items,paused:state?.queuePaused??null});
  },[sessionId]);
  useEffect(()=>{
    if (!sessionId) return;
    let active=true;
    const poll=()=>void reload().catch(reason=>{if(active)setError(String(reason.message));});
    poll();const timer=setInterval(poll,2000);
    return()=>{active=false;clearInterval(timer);requestSequence.current++;};
  },[sessionId,reload]);
  const enqueue=useCallback(async(submission:QueueSubmission, targetSessionId: string)=>{
    const options={...submission.options,attachments:submission.attachments};
    const fingerprint=JSON.stringify([targetSessionId,submission.content,options]);
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(fingerprint))))
      .map(byte=>byte.toString(16).padStart(2,'0')).join('');
    const key=`cloudcli.queue-request:${targetSessionId}:${hash}`;
    const requestId=localStorage.getItem(key)||crypto.randomUUID();
    // Keep only the opaque ticket in browser storage. On an unknown outcome,
    // refreshing and retrying the same draft cannot create a duplicate turn.
    localStorage.setItem(key,requestId);
    try {
      await readQueueResult(await api.messageQueue.enqueue({sessionId:targetSessionId,requestId,content:submission.content,options}));
      localStorage.removeItem(key);
      setError('');
      // The POST acknowledgment is authoritative. A subsequent refresh failure
      // must not turn an accepted submission into a retry with a new ticket.
      if (currentSession.current===targetSessionId) void reload().catch(reason=>setError(String(reason.message)));
    } catch(reason) {
      setError(reason instanceof Error?reason.message:String(reason));
      throw reason;
    }
  },[reload]);
  const sendLive=useCallback(async(submission:QueueSubmission,targetSessionId:string)=>{
    if (submission.attachments.length) throw new Error('Live additions accept text; use the queue for attachments.');
    const fingerprint=JSON.stringify([targetSessionId,submission.content]);
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(fingerprint))))
      .map(byte=>byte.toString(16).padStart(2,'0')).join('');
    const key=`cloudcli.live-request:${targetSessionId}:${hash}`;
    try {
      const saved=localStorage.getItem(key);
      const ticket: {requestId:string;expectedStartedAt:number}=saved?JSON.parse(saved):{
        requestId:crypto.randomUUID(),
        expectedStartedAt:(await readQueueResult<{startedAt:number}>(await api.messageQueue.liveState(targetSessionId))).startedAt,
      };
      localStorage.setItem(key,JSON.stringify(ticket));
      const row=await readQueueResult<QueuedConversationMessage>(await api.messageQueue.sendLive({sessionId:targetSessionId,...ticket,content:submission.content,options:{}}));
      localStorage.removeItem(key);
      if (currentSession.current===targetSessionId) void reload().catch(reason=>setError(String(reason.message)));
      if (row.status==='failed'||row.status==='interrupted') throw new Error(row.error||'The addition was not confirmed. Review its receipt before retrying.');
      setError('');
    } catch(reason) {
      setError(reason instanceof Error?reason.message:String(reason));
      throw reason;
    }
  },[reload]);
  const update=useCallback(async(item:QueuedConversationMessage,body:QueueMessageChange)=>{
    try {
      await readQueueResult(await api.messageQueue.update(item.id,{revision:item.revision,...body}));
      setError('');await reload();
    } catch(reason) {setError(reason instanceof Error?reason.message:String(reason));throw reason;}
  },[reload]);
  const setPaused=useCallback(async(paused:boolean)=>{
    if(!sessionId)return;
    try {
      await readQueueResult(await api.sessionWorkspace.update(sessionId,{queuePaused:paused}));
      setError('');await reload();
    } catch(reason){setError(reason instanceof Error?reason.message:String(reason));throw reason;}
  },[sessionId,reload]);
  const attempts=useCallback(async(id:string)=>
    readQueueResult<QueuedMessageAttempt[]>(await api.messageQueue.attempts(id)),[]);
  return {items:snapshot.sessionId===sessionId?snapshot.items:[],paused:snapshot.sessionId===sessionId?snapshot.paused:null,setPaused,error,enqueue,sendLive,update,attempts};
}
