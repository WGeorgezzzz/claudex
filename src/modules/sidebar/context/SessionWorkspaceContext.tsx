import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, readApiErrorMessage } from '@/shared/api';
import type { SessionWorkspaceChange, SessionWorkspaceEntry } from '@/shared/types';

type WorkspaceState={entries:SessionWorkspaceEntry[];byId:ReadonlyMap<string,SessionWorkspaceEntry>;ready:boolean;error:string;
  change:(id:string,input:SessionWorkspaceChange)=>Promise<void>;refresh:()=>Promise<void>};
const Context=createContext<WorkspaceState|null>(null);
async function unwrap<T>(response:Response):Promise<T> {
  const body=await response.json();if(!response.ok)throw new Error(readApiErrorMessage(body)||`HTTP ${response.status}`);
  return body.data as T;
}

/** Sidebar mounts one polling owner for its lists and menus; rows never create their own network requests. */
export function SessionWorkspaceProvider({activeSessionId,children}:{activeSessionId:string|null;children:ReactNode}) {
  // Organization and attention are server-backed so a closed page cannot lose them.
  const [entries,setEntries]=useState<SessionWorkspaceEntry[]>([]);
  // Readiness prevents new controls being offered against an older backend.
  const [ready,setReady]=useState(false);
  // Failed reads/writes remain visible without discarding the last valid snapshot.
  const [error,setError]=useState('');
  const sequence=useRef(0),alive=useRef(true);
  const manualUnread=useRef(new Map<string,string|null>());
  const activeId=useRef(activeSessionId);activeId.current=activeSessionId;
  const refresh=useCallback(async()=>{
    const request=++sequence.current;
    try {
      const next=await unwrap<SessionWorkspaceEntry[]>(await api.sessionWorkspace.list());
      if(!Array.isArray(next))throw new Error('Invalid session workspace response.');
      if(alive.current&&request===sequence.current){setEntries(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next);setReady(true);setError('');}
    } catch(reason){if(alive.current&&request===sequence.current)setError(reason instanceof Error?reason.message:String(reason));}
  },[]);
  const change=useCallback(async(id:string,input:SessionWorkspaceChange)=>{
    try {
      const next=await unwrap<SessionWorkspaceEntry>(await api.sessionWorkspace.update(id,input));
      if(!alive.current)return;
      sequence.current++;
      if(input.unread===true&&activeId.current===id)manualUnread.current.set(id,next.lastActivityAt);
      if(input.unread===false)manualUnread.current.delete(id);
      setEntries(previous=>[...previous.filter(row=>row.sessionId!==id),{...next,approvalCount:previous.find(row=>row.sessionId===id)?.approvalCount??next.approvalCount}]);
      setError('');
    } catch(reason){if(alive.current)setError(reason instanceof Error?reason.message:String(reason));throw reason;}
  },[]);
  useEffect(()=>{
    alive.current=true;void refresh();
    const poll=()=>{if(document.visibilityState!=='hidden')void refresh();};
    const timer=setInterval(poll,3000);document.addEventListener('visibilitychange',poll);
    return()=>{alive.current=false;sequence.current++;clearInterval(timer);document.removeEventListener('visibilitychange',poll);};
  },[refresh]);
  useEffect(()=>{manualUnread.current.clear();},[activeSessionId]);
  const byId=useMemo(()=>new Map(entries.map(row=>[row.sessionId,row])),[entries]);
  const selected=byId.get(activeSessionId??'');
  useEffect(()=>{
    const markViewed=()=>{
      if(!activeSessionId||!selected?.unread||document.visibilityState==='hidden'||!document.hasFocus())return;
      if(manualUnread.current.has(activeSessionId)&&manualUnread.current.get(activeSessionId)===selected.lastActivityAt)return;
      void change(activeSessionId,{unread:false,readThrough:selected.lastActivityAt}).catch(()=>{});
    };
    markViewed();window.addEventListener('focus',markViewed);document.addEventListener('visibilitychange',markViewed);
    return()=>{window.removeEventListener('focus',markViewed);document.removeEventListener('visibilitychange',markViewed);};
  },[activeSessionId,selected?.unread,selected?.lastActivityAt,change]);
  const value=useMemo(()=>({entries,byId,ready,error,change,refresh}),[entries,byId,ready,error,change,refresh]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Sidebar menus, rows and the pinned/attention panel consume their shared snapshot through this hook. */
export function useSessionWorkspace(){return useContext(Context);}
