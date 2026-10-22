import { useEffect, useState } from 'react';

import { api } from '@/shared/api';

/** Chat and sidebar must not send calendar rules to legacy servers that would silently ignore them. */
export function useMonitorCapabilities(enabled:boolean):boolean {
  // Calendar controls remain unavailable until the current backend explicitly confirms support.
  const [supported,setSupported]=useState(false);
  useEffect(()=>{
    if(!enabled)return;
    const controller=new AbortController();
    void api.monitors.capabilities({signal:controller.signal}).then(async response=>{
      const body=response.ok?await response.json():null;
      if(!controller.signal.aborted)setSupported(body?.data?.calendar===true&&body?.data?.scheduleVersion===1);
    }).catch(()=>{if(!controller.signal.aborted)setSupported(false);});
    return()=>controller.abort();
  },[enabled]);
  return supported;
}
