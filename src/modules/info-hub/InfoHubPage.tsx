import { useEffect, useState } from 'react';
import { ExternalLink, Menu, PanelTop } from 'lucide-react';
import { infoHubApi } from '@/shared/api';

/** Embeds the authenticated local info-hub so its Today/Todos/Explore views keep one source of truth. */
export function InfoHubPage({ onMenuClick }: { onMenuClick: () => void }) {
  const [loaded, setLoaded] = useState(false);
  // The iframe cannot attach the app's Bearer header; establish its scoped session first.
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { let active = true; void infoHubApi.authorize().then(response => { if (!response.ok) throw new Error('请重新登录后打开信息看板'); if (active) setReady(true); }).catch(error => { if (active) setError(String(error)); }); return () => { active = false; }; }, []);
  return <section className="relative flex h-full min-h-0 flex-col bg-muted/15" aria-label="信息看板">
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4 md:px-6">
      <button type="button" title="打开侧栏" aria-label="打开侧栏" className="workspace-icon-button md:hidden" onClick={onMenuClick}><Menu size={18}/></button>
      <PanelTop size={19}/><h1 className="text-lg font-semibold">信息看板</h1><span className="text-xs text-muted-foreground">Today · Todos · Explore</span>
      <a className="workspace-icon-button ml-auto" href="/infohub/" target="_blank" rel="noreferrer" title="在新窗口打开" aria-label="在新窗口打开"><ExternalLink size={17}/></a>
    </header>
    {error && <p role="alert" className="p-6 text-sm">{error}</p>}
    {!error && !loaded && <div className="pointer-events-none absolute inset-0 flex items-center justify-center pt-14 text-sm text-muted-foreground">正在连接信息看板…</div>}
    {ready && <iframe title="信息看板" src="/infohub/" onLoad={() => setLoaded(true)} className={`min-h-0 flex-1 border-0 ${loaded ? '' : 'opacity-0'}`} />}
  </section>;
}
