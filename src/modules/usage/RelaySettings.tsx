import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { useAuth } from '@/modules/auth';

/** QuotaPanel offers administrators the installation-wide relay endpoint. */
export function RelaySettings({ onSaved }: { onSaved: () => Promise<void> }) {
  const { user } = useAuth();
  // Preserve the administrator's unsaved endpoint until submission succeeds.
  const [baseUrl, setBaseUrl] = useState('');
  // An environment-owned endpoint must remain read-only in the form.
  const [source, setSource] = useState('file');
  // Report save and transport outcomes without replacing the quota data.
  const [status, setStatus] = useState('');
  // Prevent overlapping configuration submissions.
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (user?.role !== 'admin') return;
    void api.quota.relay().then(readApiJson<{ baseUrl: string; source: string }>).then(config => {
      setBaseUrl(config.baseUrl); setSource(config.source);
    }).catch(() => setStatus('无法读取中转配置'));
  }, [user?.role]);
  if (user?.role !== 'admin') return null;
  return <form className="space-y-2 border-b border-border pb-3" onSubmit={event => {
    event.preventDefault(); setBusy(true); setStatus('');
    void api.quota.saveRelay(baseUrl).then(readApiJson).then(async () => {
      setStatus('已保存'); await onSaved();
    }).catch(() => setStatus('保存失败，请检查 HTTPS 地址或环境变量')).finally(() => setBusy(false));
  }}>
    <label htmlFor="relay-base-url" className="text-sm font-medium">中转地址</label>
    <div className="flex gap-2"><input id="relay-base-url" type="url" value={baseUrl} disabled={source === 'environment'} onChange={event => setBaseUrl(event.target.value)} placeholder="https://relay.example.com" className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"/><button title="保存中转地址" aria-label="保存中转地址" disabled={busy || source === 'environment'} className="rounded-md border border-border p-2 disabled:opacity-50"><Save size={16}/></button></div>
    {source === 'environment' && <p className="text-xs text-muted-foreground">由环境变量管理</p>}
    {status && <p role="status" className="text-xs">{status}</p>}
  </form>;
}
