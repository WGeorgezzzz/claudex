import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiErrorMessage } from '@/shared/api';
import type { QueuedConversationMessage, QueuedMessageAttempt, QueueSubmission, QueueMessageChange, SessionWorkspaceEntry } from '@/shared/types';

async function readQueueResult<T>(response: Response): Promise<T> {
  const body=await response.json();
  if (!response.ok) {
    const error=new Error(readApiErrorMessage(body)||`HTTP ${response.status}`) as Error&{code?:string};
    error.code=typeof body?.error?.code==='string'?body.error.code:undefined;
    throw error;
  }
  return body.data as T;
}

/** The turn ended (or never belonged to this server) before an insertion was persisted. */
const isLiveUnavailable=(reason:unknown)=>(reason as {code?:string})?.code==='LIVE_INPUT_UNAVAILABLE';

/** ChatInterface uses durable server snapshots; transport retries reuse the same request ID. */
export function useMessageQueue(sessionId: string|null) {
  const {t}=useTranslation('chat');
  // A snapshot belongs only to the session that requested it.
  const [snapshot,setSnapshot]=useState<{sessionId:string|null;items:QueuedConversationMessage[];paused:boolean|null}>({sessionId,items:[],paused:null});
  // Transport errors remain visible while the composer's original input stays editable.
  const [failure,setFailure]=useState({sessionId,message:''});
  // The ended-turn fallback is a temporary, session-scoped notice rather than an error.
  const [notification,setNotification]=useState({sessionId,message:''});
  const currentSession=useRef(sessionId);
  const hasPendingWork=useRef(false);
  currentSession.current=sessionId;
  const setError=useCallback((message:string)=>{
    if(currentSession.current===sessionId)setFailure({sessionId,message});
  },[sessionId]);
  useEffect(()=>{
    if(!notification.message)return;
    const timer=setTimeout(()=>setNotification(value=>({...value,message:''})),6000);
    return()=>clearTimeout(timer);
  },[notification]);
  const requestSequence=useRef(0);
  const reload=useCallback(async()=>{
    if (!sessionId) return;
    const sequence=++requestSequence.current;
    const [items,state]=await Promise.all([
      api.messageQueue.list(sessionId).then(readQueueResult<QueuedConversationMessage[]>),
      api.sessionWorkspace?.get(sessionId).then(readQueueResult<SessionWorkspaceEntry>).catch(()=>null)??Promise.resolve(null),
    ]);
    if (!Array.isArray(items)) throw new Error('Invalid message queue response.');
    if (currentSession.current===sessionId && sequence===requestSequence.current) {
      hasPendingWork.current=items.some(item=>item.status==='queued'||item.status==='running');
      const paused=state?.queuePaused??null;
      setSnapshot(previous=>previous.sessionId===sessionId&&previous.paused===paused&&JSON.stringify(previous.items)===JSON.stringify(items)?previous:{sessionId,items,paused});
    }
  },[sessionId]);
  useEffect(()=>{
    if (!sessionId) return;
    let active=true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll=async()=>{
      if(!active||document.visibilityState==='hidden')return;
      try{await reload();}catch(reason){if(active)setError(reason instanceof Error?reason.message:String(reason));}
      if(active&&!document.hidden)timer=setTimeout(()=>void poll(),hasPendingWork.current?2000:15000);
    };
    const visibility=()=>{clearTimeout(timer);if(document.visibilityState!=='hidden')void poll();};
    void poll();document.addEventListener('visibilitychange',visibility);
    return()=>{active=false;clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);requestSequence.current++;};
  },[sessionId,reload,setError]);
  const enqueue=useCallback(async(submission:QueueSubmission, targetSessionId: string,recoveryId?:string)=>{
    const options={...submission.options,attachments:submission.attachments};
    const fingerprint=JSON.stringify([targetSessionId,submission.content,options]);
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(fingerprint))))
      .map(byte=>byte.toString(16).padStart(2,'0')).join('');
    const key=recoveryId?`cloudcli.queue-recovery:${recoveryId}`:`cloudcli.queue-request:${targetSessionId}:${hash}`;
    const requestId=localStorage.getItem(key)||crypto.randomUUID();
    // Keep only the opaque ticket in browser storage. On an unknown outcome,
    // refreshing and retrying the same draft cannot create a duplicate turn.
    localStorage.setItem(key,requestId);
    try {
      await readQueueResult(await api.messageQueue.enqueue({sessionId:targetSessionId,requestId,content:submission.content,options}));
      if(!recoveryId)localStorage.removeItem(key);
      setError('');
      // The POST acknowledgment is authoritative. A subsequent refresh failure
      // must not turn an accepted submission into a retry with a new ticket.
      if (currentSession.current===targetSessionId) void reload().catch(reason=>setError(String(reason.message)));
    } catch(reason) {
      setError(reason instanceof Error?reason.message:String(reason));
      throw reason;
    }
  },[reload,setError]);
  /** Inserts into the running turn; resolves 'queued' when no turn was running and the draft went to the queue instead. */
  const sendLive=useCallback(async(submission:QueueSubmission,targetSessionId:string,recoveryId?:string):Promise<'live'|'queued'>=>{
    if (submission.attachments.length) throw new Error('Live additions accept text; use the queue for attachments.');
    const fingerprint=JSON.stringify([targetSessionId,submission.content]);
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(fingerprint))))
      .map(byte=>byte.toString(16).padStart(2,'0')).join('');
    const key=recoveryId?`cloudcli.live-recovery:${recoveryId}`:`cloudcli.live-request:${targetSessionId}:${hash}`;
    try {
      const saved=localStorage.getItem(key);
      const ticket: {requestId:string;expectedStartedAt:number}=saved?JSON.parse(saved):{
        requestId:crypto.randomUUID(),
        expectedStartedAt:(await readQueueResult<{startedAt:number}>(await api.messageQueue.liveState(targetSessionId))).startedAt,
      };
      localStorage.setItem(key,JSON.stringify(ticket));
      const row=await readQueueResult<QueuedConversationMessage>(await api.messageQueue.sendLive({sessionId:targetSessionId,...ticket,content:submission.content,options:{}}));
      if(!recoveryId || row.status==='failed'||row.status==='interrupted')localStorage.removeItem(key);
      if (currentSession.current===targetSessionId) void reload().catch(reason=>setError(String(reason.message)));
      if (row.status==='failed'||row.status==='interrupted') throw new Error(row.error||'The addition was not confirmed. Review its receipt before retrying.');
      setError('');
      return 'live';
    } catch(reason) {
      if (isLiveUnavailable(reason)) {
        // Nothing was persisted for this insertion: the turn already ended, so
        // the same text goes to the ordinary next-turn queue instead.
        localStorage.removeItem(key);
        await enqueue(submission,targetSessionId,recoveryId);
        if(currentSession.current===targetSessionId)setNotification({sessionId:targetSessionId,message:t('liveInput.fallback')});
        return 'queued';
      }
      setError(reason instanceof Error?reason.message:String(reason));
      throw reason;
    }
  },[reload,enqueue,setError,t]);
  const update=useCallback(async(item:QueuedConversationMessage,body:QueueMessageChange)=>{
    try {
      await readQueueResult(await api.messageQueue.update(item.id,{revision:item.revision,...body}));
      setError('');await reload();
    } catch(reason) {
      setError((reason as {code?:string})?.code==='QUEUE_CONFLICT'?t('queue.editConflict'):reason instanceof Error?reason.message:String(reason));
      // A revision conflict can mean dispatch already began; refresh without discarding the editor's text.
      await reload().catch(()=>{});
      throw reason;
    }
  },[reload,setError,t]);
  const retryLive=useCallback(async(item:QueuedConversationMessage)=>{
    const outcome=await sendLive({content:item.content,options:{},attachments:[]},item.session_id,item.id);
    await update(item,{action:'cancel'});
    localStorage.removeItem(`cloudcli.live-recovery:${item.id}`);
    localStorage.removeItem(`cloudcli.queue-recovery:${item.id}`);
    return outcome;
  },[sendLive,update]);
  const convertLive=useCallback(async(item:QueuedConversationMessage)=>{
    // Keep the original failed receipt until replacement persistence is acknowledged.
    // Recovery tickets survive an uncertain cancel response, avoiding duplicate replacement turns.
    await enqueue({content:item.content,options:{},attachments:[]},item.session_id,item.id);
    await update(item,{action:'cancel'});
    localStorage.removeItem(`cloudcli.queue-recovery:${item.id}`);
  },[enqueue,update]);
  const setPaused=useCallback(async(paused:boolean)=>{
    if(!sessionId)return;
    try {
      await readQueueResult(await api.sessionWorkspace.update(sessionId,{queuePaused:paused}));
      setError('');await reload();
    } catch(reason){setError(reason instanceof Error?reason.message:String(reason));throw reason;}
  },[sessionId,reload,setError]);
  const attempts=useCallback(async(id:string)=>
    readQueueResult<QueuedMessageAttempt[]>(await api.messageQueue.attempts(id)),[]);
  return {items:snapshot.sessionId===sessionId?snapshot.items:[],paused:snapshot.sessionId===sessionId?snapshot.paused:null,
    setPaused,error:failure.sessionId===sessionId?failure.message:'',notice:notification.sessionId===sessionId?notification.message:'',
    enqueue,sendLive,update,attempts,retryLive,convertLive};
}
