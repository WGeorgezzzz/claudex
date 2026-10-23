import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/modules/auth';
import { api, readApiErrorMessage } from '@/shared/api';
import { Button } from '@/shared/ui';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';

export const settingsInputClass = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-60';

/** Settings renders this account tab for every user: who is signed in and a self-service password change. */
export function UsersSettingsTab() {
  const {t}=useTranslation('settings');
  const {user,logout}=useAuth();
  // One pending request at a time keeps the form from double-submitting.
  const [busy,setBusy]=useState(false);
  // Errors stay inline next to the form; success logs the user out.
  const [error,setError]=useState('');
  const role=(user as {role?:string}|null)?.role==='admin'?'admin':'member';
  return <div className="space-y-6 md:space-y-8">
    <SettingsSection title={t('account.title')} description={t('account.description')}>
      <SettingsCard className="flex items-center gap-3 px-4 py-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold uppercase text-foreground">{user?.username?.slice(0,1)}</div>
        <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-foreground">{user?.username}</div>
          <div className="text-xs text-muted-foreground">{t(role==='admin'?'users.admin':'users.member')}</div></div>
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title={t('users.changePassword')} description={t('account.passwordHint')}>
      <SettingsCard className="p-4">
        <form className="space-y-3" onSubmit={e=>{e.preventDefault();const form=e.currentTarget;const data=new FormData(form);setBusy(true);setError('');
          void (async()=>{try{const response=await api.auth.changePassword(String(data.get('current_password')),String(data.get('password')));
            const body=await response.json().catch(()=>({}));if(!response.ok)throw Error(readApiErrorMessage(body)||t('users.failed'));form.reset();logout();}
            catch(err){setError(err instanceof Error?err.message:String(err));}finally{setBusy(false);}})();}}>
          <label className="block space-y-1.5"><span className="text-sm font-medium text-foreground">{t('users.currentPassword')}</span>
            <input className={settingsInputClass} name="current_password" type="password" autoComplete="current-password" required/></label>
          <label className="block space-y-1.5"><span className="text-sm font-medium text-foreground">{t('users.newPassword')}</span>
            <input className={settingsInputClass} name="password" type="password" autoComplete="new-password" minLength={6} required/></label>
          {error&&<p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <div className="flex justify-end"><Button type="submit" size="sm" disabled={busy}><KeyRound/>{t('users.changePassword')}</Button></div>
        </form>
      </SettingsCard>
    </SettingsSection>
  </div>;
}
