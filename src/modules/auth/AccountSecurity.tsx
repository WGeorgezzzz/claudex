import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Shield, X } from 'lucide-react';

import { api, readApiErrorMessage } from '@/shared/api';
import { useAuth } from '@/modules/auth/context/AuthContext';

type Device={id:string;kind:string;created_at:number;expires_at:number};
async function read(response:Response){const b=await response.json();if(!response.ok)throw Error(readApiErrorMessage(b)||'账号操作失败');return b;}

/** Sidebar exposes device revocation and the local/remote account boundary without revealing secrets. */
export function AccountSecurity(){
  const {user,logout}=useAuth();
  // Keep security management separate from the current chat's state.
  const [open,setOpen]=useState(false);
  // Show server-owned device sessions, refreshed after each revocation.
  const [devices,setDevices]=useState<Device[]>([]);
  // Display only the remote account's configured status, never its password or OTP seed.
  const [remote,setRemote]=useState<{configured:boolean;username?:string}>({configured:false});
  // Prevent overlapping account mutations and retain any failure for the user.
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const load=async()=>{const [d,r]=await Promise.all([api.auth.devices().then(read),api.auth.remoteAccount().then(read)]);setDevices(d.devices);setRemote(r);};
  useEffect(()=>{if(!open)return;void load().catch(e=>setError(e.message));const key=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[open]);
  const revoke=async(id:string)=>{setBusy(true);setError('');try{await read(await api.auth.revokeDevice(id));if(id===user?.authSessionId){logout();setOpen(false);}else await load();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  return <><button type="button" className="workspace-icon-button" title="账号与设备" aria-label="账号与设备" onClick={()=>setOpen(true)}><Shield size={15}/></button>{open&&createPortal(<div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4" onClick={e=>{if(e.target===e.currentTarget)setOpen(false);}}><section role="dialog" aria-modal="true" aria-label="账号与设备" className="max-h-[90dvh] w-full max-w-lg overflow-auto rounded-2xl border bg-background p-5 text-foreground shadow-xl"><header className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold">账号与设备</h2><button type="button" aria-label="关闭账号与设备" onClick={()=>setOpen(false)}><X size={20}/></button></header><p className="text-sm">当前用户：{user?.username}</p><p className="mt-2 text-sm text-muted-foreground">本机桌面使用操作系统身份。远程入口使用独立账号、密码和动态验证码，并受 Cloudflare Access 保护。</p><p className="my-4 rounded-lg bg-muted p-3 text-sm">远程账号：{remote.configured?remote.username+' · 已配置':'尚未配置'}</p>{error&&<p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}<h3 className="mb-3 font-medium">登录设备</h3>{devices.map(d=><div key={d.id} className="mb-2 flex items-center gap-2 rounded-lg border p-3"><div className="min-w-0 flex-1 text-sm"><p>{d.kind==='local'?'本机身份':d.kind==='remote'?'远程账号':'密码登录'}{d.id===user?.authSessionId?' · 当前设备':''}</p><p className="text-xs text-muted-foreground">登录于 {new Date(d.created_at).toLocaleString()}</p></div><button type="button" disabled={busy} className="rounded-md border px-3 py-1 text-sm" onClick={()=>void revoke(d.id)}>撤销</button></div>)}<p className="mt-3 text-xs text-muted-foreground">撤销会立即断开该设备的连接，不中止服务器上的任务。旧版登录在本机继续兼容，但不能用于远程入口。</p></section></div>,document.body)}</>;
}
