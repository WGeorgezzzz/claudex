import { useEffect, useState } from 'react';
import { authenticatedFetch } from '@/shared/api';

/** Checks the running shell, whose main process can predate a frontend deployment. */
export function DesktopUpdateBanner() {
  const [updated, setUpdated] = useState(false);
  const [restart, setRestart] = useState(false);
  const bridge = (window as unknown as {cloudcliDesktopNotifications?: {getCapabilities?: () => Promise<{updated:boolean;restart:boolean}>;restart?: () => Promise<void>}}).cloudcliDesktopNotifications;
  useEffect(() => {
    if (!bridge) return;
    const check = async () => {
      const caps = await bridge.getCapabilities?.().catch(() => undefined);
      setUpdated(!caps || caps.updated); setRestart(Boolean(caps?.restart));
    };
    const show = () => setUpdated(true);
    void check(); const timer = setInterval(() => void check(), 30000);
    window.addEventListener('nexagent-desktop-update', show);
    return () => { clearInterval(timer); window.removeEventListener('nexagent-desktop-update', show); };
  }, [bridge]);
  if (!updated) return null;
  return <div role="status" className="fixed inset-x-0 top-0 z-[100] flex min-h-10 flex-wrap items-center justify-center gap-3 bg-amber-100 px-3 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100">桌面端已更新<button className="min-h-10 underline" onClick={()=>{void (restart?bridge?.restart?.():authenticatedFetch('/api/system/desktop/restart',{method:'POST'}));}}>点此重启桌面端</button></div>;
}
