import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, KeyRound, Pencil, Plus, Power, RefreshCw, Trash2, UserPlus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { readAuthErrorMessage, useAuth } from '@/modules/auth';
import { FolderBrowserModal } from '@/modules/project-creation-wizard';
import { api } from '@/shared/api';
import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';
import SettingsCard from '@/modules/settings/SettingsCard';
import { settingsInputClass } from '@/modules/settings/tabs/UsersSettingsTab';

type Role = 'admin' | 'member';
type ManagedUser = {
  id: number; username: string; role: Role; work_root: string | null; allowed_folders: string;
  access_sso_email: string | null; is_active: number; created_at?: string | null; last_login?: string | null;
};
type Draft = { username: string; password: string; role: Role; work_root: string; allowed_folders: string[]; access_sso_email: string; is_active: boolean };
type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; user: ManagedUser }
  | { kind: 'password'; user: ManagedUser }
  | { kind: 'confirm'; action: 'delete' | 'disable'; user: ManagedUser };

const folderList = (value: string) => { try { const parsed: unknown = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; } };
// SQLite CURRENT_TIMESTAMP is UTC without a zone marker.
const formatTime = (value?: string | null) => {
  if (!value) return '—';
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : value.replace(' ', 'T') + 'Z');
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

/** Overlay used by the user management dialogs; it sits above the Settings dialog's z-[9999]. */
function ModalShell({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div data-escape-layer className="fixed inset-0 z-[10000] flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label={title}
        className="flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-background text-foreground shadow-2xl sm:max-w-lg sm:rounded-xl">
        <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <h3 className="text-base font-semibold">{title}</h3>
          <button type="button" className="workspace-icon-button" aria-label="close" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer>
      </section>
    </div>,
    document.body,
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block space-y-1.5">
    <span className="text-sm font-medium text-foreground">{label}</span>
    {children}
    {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
  </label>;
}

/** Settings renders this administrator-only section to list, create and manage member accounts. */
export function UserManagementTab() {
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  const currentId = Number((user as { id?: number } | null)?.id);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogError, setDialogError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newPassword, setNewPassword] = useState('');
  // Which field the folder browser fills: the root, or a new granted folder.
  const [picker, setPicker] = useState<'root' | 'folder' | null>(null);

  const read = useCallback(async (response: Response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(readAuthErrorMessage(body) || t('users.failed'));
    return body;
  }, [t]);
  const load = useCallback(async () => {
    setLoading(true);
    try { setUsers((await read(await api.auth.users())).users); }
    catch (error) { setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) }); }
    finally { setLoading(false); }
  }, [read]);
  useEffect(() => { void load(); }, [load]);

  const close = useCallback(() => { setDialog(null); setDraft(null); setDialogError(''); setNewPassword(''); setPicker(null); }, []);
  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true); setDialogError('');
    try { await action(); close(); setNotice({ tone: 'ok', text: success }); await load(); }
    catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (dialog) setDialogError(text); else setNotice({ tone: 'error', text });
    } finally { setBusy(false); }
  }

  const openCreate = () => { setDraft({ username: '', password: '', role: 'member', work_root: '', allowed_folders: [], access_sso_email: '', is_active: true }); setDialog({ kind: 'create' }); };
  const openEdit = (account: ManagedUser) => {
    setDraft({ username: account.username, password: '', role: account.role, work_root: account.work_root ?? '', allowed_folders: folderList(account.allowed_folders), access_sso_email: account.access_sso_email ?? '', is_active: Boolean(account.is_active) });
    setDialog({ kind: 'edit', user: account });
  };
  const access = (value: Draft) => ({ work_root: value.work_root.trim() || undefined, allowed_folders: value.allowed_folders, access_sso_email: value.access_sso_email.trim() });

  const submitDraft = () => {
    if (!draft || !dialog) return;
    if (dialog.kind === 'create') {
      void run(async () => {
        const created = await read(await api.auth.createUser({ username: draft.username.trim(), password: draft.password, ...access(draft) }));
        // Creation always yields a member; promote in a second step when asked.
        if (draft.role === 'admin' && created?.user?.id) await read(await api.auth.updateUser(Number(created.user.id), { role: 'admin' }));
      }, t('users.created', { name: draft.username.trim() }));
    } else if (dialog.kind === 'edit') {
      const target = dialog.user;
      void run(async () => {
        await read(await api.auth.updateUser(target.id, { ...access(draft), ...(draft.role !== target.role ? { role: draft.role } : {}), ...(draft.role === 'member' ? { is_active: draft.is_active } : {}) }));
      }, t('users.saved'));
    }
  };

  const toggleActive = (account: ManagedUser) => {
    if (account.is_active) { setDialog({ kind: 'confirm', action: 'disable', user: account }); return; }
    void run(async () => { await read(await api.auth.updateUser(account.id, { is_active: true })); }, t('users.enabledNotice', { name: account.username }));
  };

  const confirmAction = () => {
    if (dialog?.kind !== 'confirm') return;
    const target = dialog.user;
    if (dialog.action === 'delete') void run(async () => { await read(await api.auth.deleteUser(target.id)); }, t('users.deletedNotice', { name: target.username }));
    else void run(async () => { await read(await api.auth.updateUser(target.id, { is_active: false })); }, t('users.disabledNotice', { name: target.username }));
  };

  const draftValid = draft && (dialog?.kind !== 'create' || (/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,63}$/.test(draft.username.trim()) && draft.password.length >= 6));

  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1 basis-60">
        <h2 className="text-lg font-semibold text-foreground">{t('mainTabs.users')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('users.description')}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" className="h-9 w-9 px-0" onClick={() => void load()} disabled={loading} aria-label={t('users.refresh')} title={t('users.refresh')}>
          <RefreshCw className={cn(loading && 'animate-spin')} />
        </Button>
        <Button size="sm" onClick={openCreate}><UserPlus />{t('users.create')}</Button>
      </div>
    </div>

    {notice && <div role="status" className={cn('flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm',
      notice.tone === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-destructive/30 bg-destructive/10 text-destructive')}>
      <span className="min-w-0 break-words">{notice.text}</span>
      <button type="button" className="shrink-0 opacity-70 hover:opacity-100" aria-label="dismiss" onClick={() => setNotice(null)}><X size={14} /></button>
    </div>}

    <SettingsCard divided className="overflow-hidden">
      {loading && users.length === 0 && <div className="px-4 py-8 text-center text-sm text-muted-foreground">{t('users.loading')}</div>}
      {!loading && users.length === 0 && <div className="px-4 py-8 text-center text-sm text-muted-foreground">{t('users.empty')}</div>}
      {users.map(account => {
        const folders = folderList(account.allowed_folders);
        const isSelf = account.id === currentId;
        return <div key={account.id} data-testid={`managed-user-${account.username}`} className={cn('space-y-2 px-4 py-3', !account.is_active && 'bg-muted/30')}>
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
            <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold uppercase', account.role === 'admin' ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground')}>{account.username.slice(0, 1)}</div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="truncate text-sm font-medium text-foreground" title={account.username}>{account.username}</span>
                {isSelf && <span className="text-xs text-muted-foreground">{t('users.you')}</span>}
                <span className={cn('inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium', account.role === 'admin' ? 'bg-primary/10 text-primary dark:bg-primary/20' : 'bg-muted text-muted-foreground')}>{t(account.role === 'admin' ? 'users.admin' : 'users.member')}</span>
                <span className={cn('inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium', account.is_active ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300')}>
                  <span className={cn('h-1.5 w-1.5 rounded-full', account.is_active ? 'bg-emerald-500' : 'bg-amber-500')} />{t(account.is_active ? 'users.enabled' : 'users.disabled')}
                </span>
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">{t('users.createdAt')} {formatTime(account.created_at)}</div>
            </div>
            <div className="flex flex-wrap items-center gap-0.5">
              <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => openEdit(account)} title={t('users.edit')}><Pencil />{t('users.edit')}</Button>
              <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => setDialog({ kind: 'password', user: account })} title={t('users.reset')}><KeyRound />{t('users.reset')}</Button>
              {account.role !== 'admin' && <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" disabled={busy} onClick={() => toggleActive(account)}><Power />{t(account.is_active ? 'users.disable' : 'users.enable')}</Button>}
              {!isSelf && <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300" onClick={() => setDialog({ kind: 'confirm', action: 'delete', user: account })}><Trash2 />{t('users.delete')}</Button>}
            </div>
          </div>
          <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md bg-muted/40 px-3 py-2 text-xs sm:ml-11">
            <dt className="text-muted-foreground">{t('users.root')}</dt>
            <dd className="truncate font-mono text-[11px] text-foreground" title={account.work_root ?? ''}>{account.work_root || t('users.defaultRootShort')}</dd>
            <dt className="text-muted-foreground">{t('users.foldersShort')}</dt>
            <dd className="min-w-0">{folders.length ? folders.map(folder => <div key={folder} className="truncate font-mono text-[11px] text-foreground" title={folder}>{folder}</div>) : <span className="text-muted-foreground">—</span>}</dd>
            <dt className="text-muted-foreground">{t('users.email')}</dt>
            <dd className="truncate text-foreground">{account.access_sso_email || <span className="text-muted-foreground">—</span>}</dd>
          </dl>
        </div>;
      })}
    </SettingsCard>
    <p className="text-xs leading-relaxed text-muted-foreground">{t('users.remoteNote')}</p>

    {draft && (dialog?.kind === 'create' || dialog?.kind === 'edit') && <ModalShell
      title={dialog.kind === 'create' ? t('users.create') : t('users.editTitle', { name: dialog.user.username })}
      onClose={close}
      footer={<><Button variant="outline" size="sm" onClick={close}>{t('users.cancel')}</Button>
        <Button size="sm" disabled={busy || !draftValid} onClick={submitDraft}>{dialog.kind === 'create' ? t('users.create') : t('users.save')}</Button></>}>
      {dialog.kind === 'create' && <>
        <Field label={t('users.username')} hint={t('users.usernameHint')}><input className={settingsInputClass} name="username" autoComplete="off" value={draft.username} onChange={e => setDraft({ ...draft, username: e.target.value })} /></Field>
        <Field label={t('users.initialPassword')} hint={t('users.passwordHint')}><input className={settingsInputClass} name="password" type="password" autoComplete="new-password" value={draft.password} onChange={e => setDraft({ ...draft, password: e.target.value })} /></Field>
      </>}
      <Field label={t('users.role')}>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('users.role')}>
          {(['member', 'admin'] as Role[]).map(role => {
            const locked = dialog.kind === 'edit' && dialog.user.id === currentId;
            return <button key={role} type="button" role="radio" aria-checked={draft.role === role} disabled={locked}
              onClick={() => setDraft({ ...draft, role })}
              className={cn('rounded-md border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60', draft.role === role ? 'border-primary bg-primary/5 text-foreground ring-1 ring-primary/40' : 'border-border text-muted-foreground hover:bg-muted/60')}>
              <div className="font-medium">{t(role === 'admin' ? 'users.admin' : 'users.member')}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t(role === 'admin' ? 'users.adminHint' : 'users.memberHint')}</div>
            </button>;
          })}
        </div>
      </Field>
      <Field label={t('users.root')} hint={t('users.defaultRoot')}>
        <div className="flex gap-2">
          <input className={cn(settingsInputClass, 'font-mono text-xs')} name="work_root" value={draft.work_root} onChange={e => setDraft({ ...draft, work_root: e.target.value })} placeholder={t('users.defaultRootShort')} />
          <Button type="button" variant="outline" size="sm" className="h-9 w-9 shrink-0 px-0" onClick={() => setPicker('root')} aria-label={t('users.browse')} title={t('users.browse')}><FolderOpen /></Button>
        </div>
      </Field>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">{t('users.foldersShort')}</span>
          <Button type="button" variant="outline" size="sm" className="h-8 px-2 text-xs" onClick={() => setPicker('folder')}><Plus />{t('users.addFolder')}</Button>
        </div>
        {draft.allowed_folders.length === 0 ? <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">{t('users.noFolders')}</p>
          : <ul className="space-y-1">{draft.allowed_folders.map(folder => <li key={folder} className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1">
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={folder}>{folder}</span>
            <button type="button" className="workspace-icon-button h-6 w-6" aria-label={t('users.removeFolder')} onClick={() => setDraft({ ...draft, allowed_folders: draft.allowed_folders.filter(item => item !== folder) })}><X size={13} /></button>
          </li>)}</ul>}
        <p className="text-xs text-muted-foreground">{t('users.foldersHint')}</p>
      </div>
      <Field label={t('users.email')} hint={t('users.emailHint')}><input className={settingsInputClass} name="access_sso_email" type="email" value={draft.access_sso_email} onChange={e => setDraft({ ...draft, access_sso_email: e.target.value })} /></Field>
      {dialog.kind === 'edit' && draft.role === 'member' && <label className="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" name="is_active" className="h-4 w-4 accent-[hsl(var(--primary))]" checked={draft.is_active} onChange={e => setDraft({ ...draft, is_active: e.target.checked })} />{t('users.enabled')}
      </label>}
      {dialogError && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{dialogError}</p>}
    </ModalShell>}

    {dialog?.kind === 'password' && <ModalShell title={t('users.resetTitle', { name: dialog.user.username })} onClose={close}
      footer={<><Button variant="outline" size="sm" onClick={close}>{t('users.cancel')}</Button>
        <Button size="sm" disabled={busy || newPassword.length < 6} onClick={() => { const target = dialog.user; void run(async () => { await read(await api.auth.resetPassword(target.id, newPassword)); }, t('users.resetNotice', { name: target.username })); }}>{t('users.reset')}</Button></>}>
      <Field label={t('users.newPassword')} hint={t('users.resetHint')}><input className={settingsInputClass} name="password" type="password" autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} autoFocus /></Field>
      {dialogError && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{dialogError}</p>}
    </ModalShell>}

    {dialog?.kind === 'confirm' && <ModalShell title={t(dialog.action === 'delete' ? 'users.deleteTitle' : 'users.disableTitle', { name: dialog.user.username })} onClose={close}
      footer={<><Button variant="outline" size="sm" onClick={close}>{t('users.cancel')}</Button>
        <Button variant="destructive" size="sm" disabled={busy} onClick={confirmAction}>{t(dialog.action === 'delete' ? 'users.confirmDelete' : 'users.confirmDisable')}</Button></>}>
      <p className="text-sm text-foreground">{t(dialog.action === 'delete' ? 'users.deleteBody' : 'users.disableBody', { name: dialog.user.username })}</p>
      {dialogError && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{dialogError}</p>}
    </ModalShell>}

    {picker !== null && createPortal(<FolderBrowserModal isOpen autoAdvanceOnSelect={false} overlayClassName="z-[10001]" onClose={() => setPicker(null)}
      onFolderSelected={folderPath => {
        if (draft && picker === 'root') setDraft({ ...draft, work_root: folderPath });
        if (draft && picker === 'folder' && !draft.allowed_folders.includes(folderPath)) setDraft({ ...draft, allowed_folders: [...draft.allowed_folders, folderPath] });
        setPicker(null);
      }} />, document.body)}
  </div>;
}
