import { useSyncExternalStore } from 'react';

import { api } from '@/shared/api';
import type { SessionMonitorSummary } from '@/shared/types';

const EMPTY:Record<string,SessionMonitorSummary[]>={};
let snapshot:Record<string,SessionMonitorSummary[]>=EMPTY;
let snapshotAccount='';
const account=()=>typeof localStorage==='undefined'?'':localStorage.getItem('auth-token')??'';
const listeners=new Set<()=>void>();
let timer:ReturnType<typeof setInterval>|undefined;
let generation=0;
let sequence=0;
/** Badges share one account-scoped batch request every ten seconds, regardless of the row count. */
export async function refreshMonitorSummaries() {
  const epoch=generation,request=++sequence,identity=account();
  try {
    const response=await api.monitors.summaries();
    if(!response.ok)throw new Error('Monitor summaries unavailable');
    const body=await response.json();
    if(epoch!==generation||request!==sequence||identity!==account())return;
    snapshotAccount=identity;snapshot=body.data;listeners.forEach(listener=>listener());
  } catch { /* Keep the last usable summary during transient network failures. */ }
}
function subscribe(listener:()=>void) {
  listeners.add(listener);
  if(!timer){void refreshMonitorSummaries();timer=setInterval(()=>void refreshMonitorSummaries(),10000);}
  return ()=>{
    listeners.delete(listener);
    if(!listeners.size){clearInterval(timer);timer=undefined;generation++;snapshot=EMPTY;snapshotAccount='';}
  };
}
/** Sidebar, inbox and workspace header consume the same subscription, never per-row fetches. */
export function useMonitorSummaries(){return useSyncExternalStore(subscribe,()=>snapshotAccount===account()?snapshot:EMPTY);}
