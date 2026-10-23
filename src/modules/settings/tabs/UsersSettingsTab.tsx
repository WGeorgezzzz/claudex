import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/modules/auth';
import { api, readApiErrorMessage } from '@/shared/api';

type ManagedUser = {id:number;username:string;role:string;work_root:string|null;allowed_folders:string;access_sso_email:string|null;is_active:number};
/** Settings renders account self-service and administrator-only user access controls. */
export function UsersSettingsTab() {
  const {t}=useTranslation('settings');
  const {user,logout}=useAuth();
  const isAdmin=user?.role==='admin';
  // Retain the server account list only while the administrator edits it.
  const [users,setUsers]=useState<ManagedUser[]>([]);
  // One pending mutation prevents conflicting submissions.
  const [busy,setBusy]=useState(false);
  // Announce both server failures and successful saves without losing the form.
  const [notice,setNotice]=useState('');
  const read=useCallback(async(response:Response)=>{const body=await response.json();if(!response.ok)throw Error(readApiErrorMessage(body)||t('users.failed'));return body;},[t]);
  const load=useCallback(async()=>{if(isAdmin)setUsers((await read(await api.auth.users())).users);},[isAdmin,read]);
  useEffect(()=>{void load().catch(e=>setNotice(e.message));},[load]);
  async function run(action:()=>Promise<unknown>) {setBusy(true);setNotice('');try{await action();await load();setNotice(t('users.saved'));}catch(e){setNotice(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  const inputClass='w-full rounded-md border border-border bg-background p-2 text-foreground';
  function fields(data:FormData) {return {work_root:String(data.get('work_root')||'')||undefined,allowed_folders:String(data.get('allowed_folders')||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean),access_sso_email:String(data.get('access_sso_email')||'')};}
  return <section className="space-y-6 text-foreground"><h2 className="text-lg font-semibold">{t('mainTabs.users')}</h2>
    {notice&&<p role="status" className="rounded-md border p-3 text-sm">{notice}</p>}
    <form className="space-y-3 rounded-xl border p-4" onSubmit={e=>{e.preventDefault();const form=e.currentTarget;const data=new FormData(form);void run(async()=>{await read(await api.auth.changePassword(String(data.get('current_password')),String(data.get('password'))));form.reset();logout();});}}>
      <h3>{t('users.changePassword')}</h3><label className="block">{t('users.currentPassword')}<input className={inputClass} name="current_password" type="password" autoComplete="current-password" required/></label>
      <label className="block">{t('users.newPassword')}<input className={inputClass} name="password" type="password" autoComplete="new-password" minLength={6} required/></label><button className="rounded-md border px-3 py-2" disabled={busy}>{t('users.changePassword')}</button>
    </form>
    {isAdmin&&<><form className="space-y-3 rounded-xl border p-4" onSubmit={e=>{e.preventDefault();const form=e.currentTarget;const data=new FormData(form);void run(async()=>{await read(await api.auth.createUser({username:String(data.get('username')),password:String(data.get('password')),...fields(data)}));form.reset();});}}>
      <h3>{t('users.create')}</h3><label className="block">{t('users.username')}<input className={inputClass} name="username" autoComplete="off" required minLength={3}/></label>
      <label className="block">{t('users.initialPassword')}<input className={inputClass} name="password" type="password" autoComplete="new-password" required minLength={6}/></label>
      <label className="block">{t('users.root')}<input className={inputClass} name="work_root" placeholder={t('users.defaultRoot')}/></label>
      <label className="block">{t('users.folders')}<textarea className={inputClass} name="allowed_folders"/></label>
      <label className="block">{t('users.email')}<input className={inputClass} name="access_sso_email" type="email"/></label><button className="rounded-md border px-3 py-2" disabled={busy}>{t('users.create')}</button>
    </form><p className="text-sm text-muted-foreground">{t('users.remoteNote')}</p>
    {users.map(account=><article key={account.id} className="space-y-3 rounded-xl border p-4"><h3 className="font-medium">{account.username} · {t(account.role==='admin'?'users.admin':'users.member')} · {t(account.is_active?'users.enabled':'users.disabled')}</h3>
      <form className="space-y-3" onSubmit={e=>{e.preventDefault();const data=new FormData(e.currentTarget);void run(async()=>{await read(await api.auth.updateUser(account.id,{...fields(data),is_active:account.role==='admin'||data.get('is_active')==='on'}));});}}>
        <label className="block">{t('users.root')}<input key={account.work_root} className={inputClass} name="work_root" defaultValue={account.work_root??''}/></label>
        <label className="block">{t('users.folders')}<textarea key={account.allowed_folders} className={inputClass} name="allowed_folders" defaultValue={JSON.parse(account.allowed_folders).join('\n')}/></label>
        <label className="block">{t('users.email')}<input key={account.access_sso_email} className={inputClass} type="email" name="access_sso_email" defaultValue={account.access_sso_email??''}/></label>
        <label className="flex gap-2"><input type="checkbox" name="is_active" defaultChecked={Boolean(account.is_active)} disabled={account.role==='admin'}/>{t('users.enabled')}</label>
        <button className="rounded-md border px-3 py-2" disabled={busy}>{t('users.save')}</button>
      </form>
      <form className="flex gap-2" onSubmit={e=>{e.preventDefault();const form=e.currentTarget;const data=new FormData(form);void run(async()=>{await read(await api.auth.resetPassword(account.id,String(data.get('password'))));form.reset();});}}><input aria-label={t('users.newPassword')} className={inputClass} name="password" type="password" autoComplete="new-password" minLength={6} required/><button className="shrink-0 rounded-md border px-3 py-2" disabled={busy}>{t('users.reset')}</button></form>
    </article>)}</>}
  </section>;
}
