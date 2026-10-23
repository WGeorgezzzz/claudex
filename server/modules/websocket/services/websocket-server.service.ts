import type { Server as HttpServer } from 'node:http';

import { WebSocket, WebSocketServer, type VerifyClientCallbackAsync } from 'ws';

import { validateAccessBoundary, isLocalRequest, authSessionEvents } from '@/modules/auth/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import { handlePluginWsProxy } from '@/modules/websocket/services/plugin-websocket-proxy.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import { handleDesktopNotificationsConnection } from '@/modules/notifications/index.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type WebSocketServerDependencies = {
  verifyClient: Parameters<typeof verifyWebSocketClient>[1];
  chat: Parameters<typeof handleChatConnection>[2];
  shell: Parameters<typeof handleShellConnection>[1];
  getPluginPort: Parameters<typeof handlePluginWsProxy>[2];
};

/**
 * Used by this module's websocket gateway to keep active transports alive and
 * close half-open connections so their route-specific clients can reconnect.
 */
export function attachWebSocketHeartbeat(
  ws: WebSocket,
  intervalMs = 30_000,
  scheduler = {
    setInterval,
    clearInterval,
  },
): () => void {
  let isAlive = true;
  let stopped = false;

  const markAlive = () => {
    isAlive = true;
  };

  const stopHeartbeat = () => {
    if (stopped) {
      return;
    }

    stopped = true;
    scheduler.clearInterval(heartbeat);
    ws.off('pong', markAlive);
    ws.off('close', stopHeartbeat);
    ws.off('error', stopHeartbeat);
  };

  ws.on('pong', markAlive);
  ws.on('close', stopHeartbeat);
  ws.on('error', stopHeartbeat);

  const heartbeat = scheduler.setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // A socket that did not answer the previous ping is half-open from the
    // server's perspective. Terminating it emits close and lets clients resume.
    if (!isAlive) {
      stopHeartbeat();
      ws.terminate();
      return;
    }

    isAlive = false;
    try {
      ws.ping();
    } catch {
      stopHeartbeat();
      ws.terminate();
    }
  }, intervalMs);

  return stopHeartbeat;
}

/**
 * Creates and wires the server-wide websocket gateway used for chat, shell, and
 * plugin proxy routes. Exported through the websocket module for server startup.
 */
export function createWebSocketServer(
  server: HttpServer,
  dependencies: WebSocketServerDependencies
): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    verifyClient: ((info, done) => {
      void validateAccessBoundary(info.req).then(ok=>{
        if(!ok||!verifyWebSocketClient(info,dependencies.verifyClient))return done(false,403,'Access denied');
        const request=info.req as AuthenticatedWebSocketRequest;
        if(process.env.CLAUDEX_PRIVATE_GATE==='1'&&!isLocalRequest(request)&&request.user?.authKind!=='remote')return done(false,403,'Remote login required');
        done(true);
      }).catch(()=>done(false,403,'Access denied'));
    }) as VerifyClientCallbackAsync<AuthenticatedWebSocketRequest>,
  });

  wss.on('connection', (ws, request) => {
    attachWebSocketHeartbeat(ws);

    const incomingRequest = request as AuthenticatedWebSocketRequest;
    const revoke=(id:string)=>{if(incomingRequest.user?.authSessionId===id)ws.close(4001,'Device session revoked');};
    authSessionEvents.on('revoked',revoke);
    ws.once('close',()=>authSessionEvents.off('revoked',revoke));
    // An already-open socket must not outlive either login; reopening repeats the complete ingress check.
    let expires=Number(incomingRequest.user?.authExpiresAt)||Infinity;
    const accessToken=incomingRequest.headers['cf-access-jwt-assertion'];
    if(process.env.CLAUDEX_PRIVATE_GATE==='1'&&typeof accessToken==='string'){
      try{expires=Math.min(expires,Number(JSON.parse(Buffer.from(accessToken.split('.')[1],'base64url').toString()).exp)*1000);}catch{ws.close(4001,'Access session invalid');}
    }
    if(Number.isFinite(expires)){
      const expiry=setTimeout(()=>ws.close(4001,'Login expired'),Math.max(1,Math.min(2147483647,expires-Date.now())));expiry.unref();ws.once('close',()=>clearTimeout(expiry));
    }
    const url = incomingRequest.url ?? '/';
    const pathname = new URL(url, 'http://localhost').pathname;

    if (pathname === '/shell') {
      if (incomingRequest.user?.id == null && incomingRequest.user?.userId == null) { ws.close(1008, 'Authentication required'); return; }
      handleShellConnection(ws, dependencies.shell, incomingRequest.user?.id ?? incomingRequest.user?.userId);
      return;
    }

    if (pathname === '/ws') {
      handleChatConnection(ws, incomingRequest, dependencies.chat);
      return;
    }

    if (pathname === '/desktop-notifications') {
      handleDesktopNotificationsConnection(ws, incomingRequest);
      return;
    }

    if (pathname.startsWith('/plugin-ws/')) {
      handlePluginWsProxy(ws, pathname, dependencies.getPluginPort);
      return;
    }

    console.log('[WARN] Unknown WebSocket path:', pathname);
    ws.close();
  });

  return wss;
}
