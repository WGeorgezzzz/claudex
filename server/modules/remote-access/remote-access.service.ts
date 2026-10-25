import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { appConfigDb } from '@/modules/database/index.js';
import { createManagedTunnelIngress, getCurrentUserContext } from '@/modules/auth/index.js';
import { AppError } from '@/shared/index.js';
import { sendDesktopNotification } from '@/modules/notifications/index.js';
import { TunnelSupervisor } from './tunnel-supervisor.js';
import { installDevTunnel, tunnelToolsDirectory } from './tool-installer.js';

const execute = promisify(execFile);
type Config = { provider: 'devtunnel' | 'cloudflare' | 'tailscale-serve' | 'tailscale-funnel'; public: boolean; enabled: boolean; owner: number; tunnelId?: string; port?: number };
let ingress: Awaited<ReturnType<typeof createManagedTunnelIngress>> | undefined;
let loginChild: ChildProcess | undefined;
let loginTimer: ReturnType<typeof setTimeout> | undefined;
let login = { phase: 'idle', code: '', url: '', error: '' };
let busy = false;
let stopping = false;
let restoreTimer: ReturnType<typeof setTimeout> | undefined;
const supervisor = new TunnelSupervisor({ onAddress(url, previous) {
  const config = readConfig();
  appConfigDb.set('remote-access:last-address', JSON.stringify({ url, previous, changedAt: new Date().toISOString() }));
  console.info('[RemoteAccess] Address:', url);
  if (config?.owner) sendDesktopNotification(config.owner, { title: 'Nexagent 远程地址', body: url, url });
} });
const readConfig = (): Config | null => JSON.parse(appConfigDb.get('remote-access:config') ?? 'null');
const requireAdmin = () => {
  const identity = getCurrentUserContext();
  if (identity?.role !== 'admin') throw new AppError('Administrator required', { statusCode: 403 });
  return identity;
};
function tool(name: 'devtunnel' | 'cloudflared' | 'tailscale') {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const candidates = [path.join(tunnelToolsDirectory(), name + suffix),
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name + suffix)),
    ...(process.platform === 'win32' ? [path.join(process.env.ProgramFiles ?? 'C:/Program Files', name === 'tailscale' ? 'Tailscale' : name, name + suffix)] : ['/opt/homebrew/bin/' + name, '/usr/local/bin/' + name])];
  return candidates.find(existsSync);
}
async function run(command: string, args: string[]) {
  return (await execute(command, args, { windowsHide: true, timeout: 30000, maxBuffer: 100000 })).stdout;
}
async function startConfig(config: Config, restoring = false) {
  if (busy) throw new AppError('远程访问正在变更，请稍后重试', { statusCode: 409 });
  busy = true; stopping = false;
  try {
    supervisor.stop(); ingress?.close(); ingress = undefined;
    const binary = tool(config.provider === 'devtunnel' ? 'devtunnel' : config.provider === 'cloudflare' ? 'cloudflared' : 'tailscale');
    if (!binary) throw new AppError('请先安装对应的官方隧道 CLI', { statusCode: 400 });
    const targetPort = Number(process.env.SERVER_PORT ?? 3001);
    let observed = false;
    ingress = await createManagedTunnelIngress(targetPort, config.provider === 'devtunnel' ? config.port : undefined, req => {
      if (observed) return; observed = true;
      const headers = Object.fromEntries(['host', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'cf-connecting-ip', 'cf-ray', 'x-tunnel-id', 'tailscale-user-login'].filter(key => req.headers[key] !== undefined).map(key => [key, req.headers[key]]));
      console.info('[RemoteAccess] Forwarding evidence:', JSON.stringify({ peer: req.socket.remoteAddress, headers }));
    });
    const target = `http://127.0.0.1:${ingress.port}`;
    let args: string[];
    if (config.provider === 'devtunnel') {
      await run(binary, ['user', 'show']);
      config.tunnelId ??= 'nexagent-' + randomBytes(6).toString('hex');
      config.port = ingress.port;
      // Persist before remote creation so interrupted preparation reuses the same owned identifier.
      appConfigDb.set('remote-access:config', JSON.stringify({ ...config, enabled: true }));
      try { await run(binary, ['show', config.tunnelId]); }
      catch { await run(binary, ['create', config.tunnelId, '--expiration', '30d']); }
      await run(binary, ['update', config.tunnelId, '--expiration', '30d']);
      try { await run(binary, ['port', 'show', config.tunnelId, '-p', String(ingress.port)]); }
      catch { await run(binary, ['port', 'create', config.tunnelId, '-p', String(ingress.port), '--protocol', 'http']); }
      if (config.port && config.port !== ingress.port) await run(binary, ['port', 'delete', config.tunnelId, '-p', String(config.port)]);
      await run(binary, ['access', 'reset', config.tunnelId]);
      if (config.public) await run(binary, ['access', 'create', config.tunnelId, '--anonymous']);
      config.port = ingress.port;
      args = ['host', config.tunnelId, '--host-header', 'unchanged', '--origin-header', 'unchanged'];
    } else if (config.provider === 'cloudflare') {
      args = ['tunnel', '--no-autoupdate', '--url', target, '--protocol', 'http2'];
    } else {
      // Foreground Serve/Funnel owns only 8443; existing host-wide Serve configuration is never reset.
      const status = JSON.parse(await run(binary, ['serve', 'status', '--json']));
      if (status.TCP?.['8443'] || Object.keys(status.Web ?? {}).some(key => key.endsWith(':8443'))) {
        throw new AppError('Tailscale 8443 已有服务，请先在本机确认端口分配', { statusCode: 409 });
      }
      args = [config.provider === 'tailscale-funnel' ? 'funnel' : 'serve', '--https=8443', target];
    }
    if (stopping) throw new Error('Remote access stopped');
    appConfigDb.set('remote-access:config', JSON.stringify({ ...config, enabled: true }));
    supervisor.start(binary, args);
    return { ...supervisor.state };
  } catch (error) {
    ingress?.close(); ingress = undefined;
    const saved = readConfig(); if (saved) appConfigDb.set('remote-access:config', JSON.stringify({ ...saved, enabled: restoring && !stopping }));
    supervisor.state.phase = 'error'; supervisor.state.error = error instanceof AppError ? error.message : '隧道启动失败，请检查官方 CLI 登录和网络';
    throw error;
  } finally { busy = false; }
}

/** Admin-only routes and lifecycle share persistent tunnel intent, account login and process supervision. */
export const remoteAccessService = {
  status() {
    requireAdmin();
    return { ...supervisor.state, busy, config: readConfig(), login, platform: process.platform,
      customDomain: { host: process.env.CLAUDEX_PUBLIC_HOST ?? null, enabled: process.env.CLAUDEX_PRIVATE_GATE === '1' },
      tools: { devtunnel: Boolean(tool('devtunnel')), cloudflared: Boolean(tool('cloudflared')), tailscale: Boolean(tool('tailscale')) },
      lastAddress: JSON.parse(appConfigDb.get('remote-access:last-address') ?? 'null') };
  },
  async install() { requireAdmin(); if (loginChild || busy) throw new AppError('CLI 正在使用', { statusCode: 409 }); return installDevTunnel(); },
  login() {
    requireAdmin();
    const command = tool('devtunnel');
    if (!command) throw new AppError('请先下载 Dev Tunnels CLI', { statusCode: 400 });
    if (loginChild) return login;
    login = { phase: 'pending', code: '', url: '', error: '' };
    const child = spawn(command, ['user', 'login', '-g', '-d'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    loginChild = child;
    let output = '';
    const data = (chunk: Buffer) => {
      output = (output + String(chunk)).slice(-8000).replace(/\x1b\[[0-9;]*m/g, '');
      const url = output.match(/https:\/\/(?:github\.com\/login\/device|microsoft\.com\/devicelogin)/)?.[0];
      const code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
      if (url) login.url = url;
      if (code) login.code = code;
    };
    child.stdout?.on('data', data); child.stderr?.on('data', data);
    child.once('error', () => { login = { phase: 'error', code: '', url: '', error: '设备码登录启动失败' }; loginChild = undefined; clearTimeout(loginTimer); });
    child.once('close', code => {
      clearTimeout(loginTimer); loginChild = undefined;
      if (login.phase !== 'pending') return;
      login.phase = code === 0 ? 'authenticated' : 'expired';
      if (code !== 0) login.error = '设备码已过期或登录已取消，请重新获取';
    });
    loginTimer = setTimeout(() => { login.phase = 'expired'; loginChild?.kill(); loginChild = undefined; }, 600000); loginTimer.unref();
    return login;
  },
  async tailscaleStatus() {
    requireAdmin(); const binary = tool('tailscale');
    if (!binary) return { installed: false };
    return { installed: true, serve: JSON.parse(await run(binary, ['serve', 'status', '--json'])), status: JSON.parse(await run(binary, ['status', '--json'])) };
  },
  async start(provider: Config['provider'], publicAccess: boolean) {
    const user = requireAdmin();
    clearTimeout(restoreTimer);
    const saved = readConfig();
    await startConfig({ provider, public: publicAccess, enabled: true, owner: user.userId, tunnelId: saved?.tunnelId, port: saved?.port });
    return this.status();
  },
  stop() {
    requireAdmin();
    clearTimeout(restoreTimer);
    stopping = true; supervisor.stop(); ingress?.close(); ingress = undefined;
    login.phase = 'cancelled'; loginChild?.kill(); loginChild = undefined; clearTimeout(loginTimer);
    const config = readConfig(); if (config) appConfigDb.set('remote-access:config', JSON.stringify({ ...config, enabled: false }));
    return this.status();
  },
};

/** Server restores an enabled tunnel asynchronously; passive verification instances never inherit production intent. */
export function initializeRemoteAccess() {
  if (process.env.CLAUDEX_PASSIVE_INSTANCE === '1') return;
  const restore = () => {
    const config = readConfig();
    if (config?.enabled && !stopping) void startConfig(config, true).catch(() => {
      console.warn('[RemoteAccess] Restore failed; retry in 30 seconds');
      if (!stopping) { restoreTimer = setTimeout(restore, 30000); restoreTimer.unref(); }
    });
  };
  setImmediate(restore);
}
/** Shutdown stops children while keeping persisted restart intent; explicit Settings stop clears that intent. */
export function closeRemoteAccess() {
  clearTimeout(restoreTimer);
  stopping = true; supervisor.stop(); ingress?.close(); ingress = undefined;
  loginChild?.kill(); loginChild = undefined; clearTimeout(loginTimer);
}
