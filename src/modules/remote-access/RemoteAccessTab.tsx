import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Download, ExternalLink, LogIn, Play, RefreshCw, Square } from 'lucide-react';
import { api } from '@/shared/api';
import { Button } from '@/shared/ui';
import { qrcodegen } from '@/modules/remote-access/qr-code-generator';

type RemoteStatus = {
  platform: string;
  phase: string; url: string | null; attempts: number; error: string | null; busy: boolean;
  config: { provider: string; public: boolean; enabled: boolean } | null;
  login: { phase: string; code: string; url: string; error: string };
  customDomain: { host: string | null; enabled: boolean };
  tools: { devtunnel: boolean; cloudflared: boolean; tailscale: boolean };
  lastAddress: { url: string; previous: string | null; changedAt: string } | null;
};
const PHASES: Record<string, string> = { stopped: '未启动', connecting: '正在连接', running: '已连接', reconnecting: '断线重连中', error: '连接失败' };

function AddressQr({ url }: { url: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const qr = qrcodegen.QrCode.encodeText(url, qrcodegen.QrCode.Ecc.MEDIUM);
    const context = canvas.current?.getContext('2d');
    if (!context || !canvas.current) return;
    const scale = 4, size = (qr.size + 8) * scale;
    canvas.current.width = size; canvas.current.height = size;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, size, size);
    context.fillStyle = '#000000';
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) context.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale);
  }, [url]);
  return <canvas ref={canvas} aria-label="远程访问二维码" role="img" className="h-40 w-40 max-w-full shrink-0" style={{imageRendering: 'pixelated'}} />;
}

/** Settings renders administrator controls for domain-free HTTPS access and the existing custom domain status. */
export function RemoteAccessTab() {
  // Poll the supervised tunnel and device authorization without discarding the previous address.
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  // Keep transient button errors separate from the supervisor's connection state.
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  // Private Dev Tunnels is the default; public sharing is an explicit administrator choice.
  const [publicAccess, setPublicAccess] = useState(false);
  // Serve/Funnel are mutually exclusive modes for the managed Tailscale endpoint.
  const [tailscaleMode, setTailscaleMode] = useState('tailscale-serve');
  // Retain a read-only Serve status report when its refresh button is used.
  const [tailscaleStatus, setTailscaleStatus] = useState('');
  const refresh = useCallback(async () => {
    const r = await api.remoteAccess.status();
    if (!r.ok) throw new Error('远程访问状态不可用');
    setStatus(await r.json());
  }, []);
  useEffect(() => { void refresh().catch(() => setError('状态加载失败')); const timer = setInterval(() => void refresh().catch(() => {}), 2000); return () => clearInterval(timer); }, [refresh]);
  const action = async (operation: () => Promise<Response>) => {
    setPending(true); setError('');
    try {
      const r = await operation();
      const body = await r.json();
      if (!r.ok) throw new Error(typeof body.error === 'string' ? body.error : body.error?.message ?? '操作失败');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setPending(false); }
  };
  const start = (provider: string) => action(() => api.remoteAccess.start(provider, provider === 'devtunnel' ? publicAccess : provider !== 'tailscale-serve'));
  const disabled = pending || status?.busy;
  return <div data-testid="remote-access" className="min-w-0 space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-base font-semibold">远程访问</h2>
      <Button size="sm" variant="outline" onClick={() => void action(async () => { await refresh(); return new Response('{}'); })} disabled={disabled}><RefreshCw className="mr-2 h-4 w-4" />刷新</Button>
    </div>
    {(error || status?.error) && <p role="alert" className="break-words text-sm text-destructive">{error || status?.error}</p>}
    <div className="border-y border-border py-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-sm">{PHASES[status?.phase ?? 'stopped'] ?? status?.phase}</span>
        <Button size="sm" variant="outline" onClick={() => void action(api.remoteAccess.stop)} disabled={disabled}><Square className="mr-2 h-3.5 w-3.5" />停止</Button>
      </div>
      {status?.url && status.phase === 'running' && <div className="mt-4 flex flex-wrap items-center gap-4">
        <AddressQr url={status.url} /><div className="min-w-0 flex-1 space-y-2">
          <a href={status.url} target="_blank" rel="noreferrer" className="block break-all text-sm text-primary underline">{status.url}</a>
          <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(status.url!).catch(() => setError('复制失败'))}><Copy className="mr-2 h-4 w-4" />复制地址</Button>
          <p className="text-xs text-muted-foreground">{status.config?.provider === 'cloudflare' ? '临时地址，重启后会变化' : status.config?.public ? '任何人可访问 · 仍需 Nexagent 登录' : '私有访问 · 仍需 Nexagent 登录'}</p>
        </div>
      </div>}
      {status?.lastAddress?.previous && status.lastAddress.previous !== status.lastAddress.url && <p role="status" className="mt-3 break-all text-xs text-muted-foreground">地址已更新：{status.lastAddress.url}</p>}
    </div>
    <section className="border-b border-border pb-4">
      <h3 className="text-sm font-semibold">自定义域名</h3>
      <p className="mt-2 break-all text-sm text-muted-foreground">{status?.customDomain.enabled && status.customDomain.host ? `Cloudflare Tunnel + Access · ${status.customDomain.host}` : '未配置'}</p>
    </section>
    <section className="space-y-3 border-b border-border pb-4">
      <h3 className="text-sm font-semibold">Microsoft Dev Tunnels <span className="ml-2 text-xs font-normal text-emerald-600">推荐</span></h3>
      {!status?.tools.devtunnel && <Button size="sm" variant="outline" onClick={() => void action(api.remoteAccess.install)} disabled={disabled}><Download className="mr-2 h-4 w-4" />下载官方 CLI</Button>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={disabled || !status?.tools.devtunnel} onClick={() => void action(api.remoteAccess.login)}><LogIn className="mr-2 h-4 w-4" />GitHub 账号登录</Button>
        <Button size="sm" disabled={disabled || !status?.tools.devtunnel} onClick={() => void start('devtunnel')}><Play className="mr-2 h-4 w-4" />启动持久隧道</Button>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={publicAccess} onChange={e => setPublicAccess(e.target.checked)} />任何人可访问（仍需 Nexagent 登录）</label>
      {status?.login.phase === 'pending' && <div role="status" className="space-y-2 rounded border border-border p-3">
        <p className="text-sm">GitHub 设备授权</p><strong className="block font-mono text-xl">{status.login.code || '正在获取设备码…'}</strong>
        {status.login.url && <a href={status.login.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 break-all text-sm text-primary underline"><ExternalLink className="h-4 w-4 shrink-0" />{status.login.url}</a>}
      </div>}
      {status?.login.phase === 'authenticated' && <p className="text-sm text-emerald-600">GitHub 已授权</p>}
      {status?.login.error && <p role="alert" className="text-sm text-destructive">{status.login.error}</p>}
    </section>
    <section className="space-y-3 border-b border-border pb-4">
      <h3 className="text-sm font-semibold">Tailscale</h3>
      <div className="flex flex-wrap gap-2">
        <select aria-label="Tailscale 访问范围" value={tailscaleMode} onChange={e => setTailscaleMode(e.target.value)} className="max-w-full rounded border border-border bg-background p-2 text-sm"><option value="tailscale-serve">Serve · 仅自己的 tailnet</option><option value="tailscale-funnel">Funnel · 公网</option></select>
        <Button size="sm" variant="outline" disabled={disabled || !status?.tools.tailscale} onClick={() => void start(tailscaleMode)}><Play className="mr-2 h-4 w-4" />启动</Button>
        <Button size="sm" variant="ghost" disabled={disabled || !status?.tools.tailscale} onClick={() => void action(async () => { const r = await api.remoteAccess.tailscale(); if (r.ok) { const body = await r.clone().json(); setTailscaleStatus(JSON.stringify(body.serve, null, 2)); } return r; })}><RefreshCw className="mr-2 h-4 w-4" />检测 Serve 状态</Button>
      </div>
      {!status?.tools.tailscale && <p className="text-xs text-muted-foreground">未安装 Tailscale</p>}
      {tailscaleStatus && <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{tailscaleStatus}</pre>}
    </section>
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">Cloudflare 临时隧道 <span className="ml-2 text-xs font-normal text-muted-foreground">临时</span></h3>
      <Button size="sm" variant="outline" disabled={disabled || !status?.tools.cloudflared} onClick={() => void start('cloudflare')}><Play className="mr-2 h-4 w-4" />启动临时隧道</Button>
      {!status?.tools.cloudflared && <code className="block break-all rounded bg-muted p-2 text-xs">{status?.platform === 'win32' ? 'winget install Cloudflare.cloudflared' : status?.platform === 'darwin' ? 'brew install cloudflared' : 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/'}</code>}
    </section>
  </div>;
}
