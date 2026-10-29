#!/usr/bin/env node
import { requireSharedResourceAdministrator } from '@/modules/auth/index.js';
import { initializeTaskIntelligence,closeTaskIntelligence,initializeInfohubTaskSync,closeInfohubTaskSync,taskmasterInboxService,infohubEmbedScript } from '@/modules/taskmaster/index.js';
// Load environment variables before other imports execute.
import './load-env.js';


import fs, { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';

import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { projectOrganizationRoutes } from '@/modules/project-organization/index.js';

import { monitorsRoutes, initializeMonitors, closeMonitors } from '@/modules/monitors/index.js';
import { accessBoundaryMiddleware, initializeLocalIdentity, withUserContext } from '@/modules/auth/index.js';
import { sideChatsRoutes } from '@/modules/side-chats/index.js';
import { messageQueueRoutes, initializeMessageQueue, closeMessageQueue } from '@/modules/message-queue/index.js';
import { sessionWorkspaceRoutes } from '@/modules/session-workspace/index.js';
import { workspaceSectionsRoutes } from '@/modules/workspace-sections/index.js';
import { sessionBridgeRoutes } from '@/modules/session-bridge/index.js';
import { sideChatsDb } from '@/modules/database/index.js';
import { getCloudCliHomeDir } from '@/shared/index.js';
import { AppError, findApplicationRoot, getModuleDirectory, IS_PLATFORM, terminalTextStyles } from '@/shared/utils.js';
import {
    closeSessionsWatcher,
    initializeSessionsWatcher,
    providerRuntimeService,
    recoverProviderSupervision,
    sessionTitlesService,
} from '@/modules/providers/index.js';
import { chatRunRegistry, createWebSocketServer } from '@/modules/websocket/index.js';

import { getConnectableHost } from '../shared/networkHosts.js';

import { createGitModule } from './modules/git/index.js';
import {
    authenticateToken,
    authenticateWebSocket,
    authRoutes,
    validateApiKey,
} from './modules/auth/index.js';
import { taskmasterRoutes, taskmasterAutoService } from './modules/taskmaster/index.js';
import { commandsRoutes } from './modules/commands/index.js';
import { settingsRoutes } from './modules/settings/index.js';
import { usageRoutes, initializeUsage, closeUsage } from './modules/usage/index.js';
import { quotaRoutes, initializeQuota, closeQuota } from './modules/quota/index.js';
import { remoteAccessRoutes, initializeRemoteAccess, closeRemoteAccess } from './modules/remote-access/index.js';
import { sessionsService, initializeAgentDiscovery } from './modules/providers/index.js';
import { createSystemModule } from './modules/system/index.js';
import { createAgentModule } from './modules/agent/index.js';
import projectModuleRoutes from './modules/projects/projects.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import { userRoutes } from './modules/user/index.js';
import {
    getPluginPort,
    pluginsRoutes,
    startEnabledPluginServers,
    stopAllPlugins,
} from './modules/plugins/index.js';
import providerRoutes from './modules/providers/provider.routes.js';
import { voiceRoutes } from './modules/voice/index.js';
import {
    closeScheduledMessageDispatcher,
    initializeScheduledMessageDispatcher,
    scheduledMessagesRoutes,
} from './modules/scheduled-messages/index.js';
import browserUseRoutes from './modules/browser-use/browser-use.routes.js';
import { assetsRoutes } from './modules/assets/index.js';
import { fileTreeRoutes } from './modules/file-tree/index.js';
import { worktreesRoutes } from './modules/worktrees/index.js';
import browserUseMcpRoutes from './modules/browser-use/browser-use-mcp.routes.js';
import { browserUseService } from './modules/browser-use/browser-use.service.js';
import { initializeDatabase, sessionsDb, monitorsDb } from './modules/database/index.js';
import { configureWebPush } from './modules/notifications/index.js';

const __dirname = getModuleDirectory(import.meta.url);
// The server source runs from /server, while the compiled output runs from /dist-server/server.
// Resolving the app root once keeps every repo-level lookup below aligned across both layouts.
const APP_ROOT = findApplicationRoot(__dirname);
const installMode = fs.existsSync(path.join(APP_ROOT, '.git')) ? 'git' : 'npm';
// Version of the code that is actually running, captured once at process
// startup. This intentionally does NOT re-read package.json per request: after
// an update replaces the files on disk, package.json reflects the NEW version
// while this long-lived process still runs the OLD code. The frontend bundle is
// rebuilt on update, so a mismatch between this value and the frontend's
// build-time version means the server was updated but not restarted.
const RUNNING_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || null;
    } catch {
        return null;
    }
})();
const systemRoutes = createSystemModule({
    appRoot: APP_ROOT,
    installMode,
    isPlatform: IS_PLATFORM,
});
console.log('SERVER_PORT from env:', process.env.SERVER_PORT);

const app = express();
const server = http.createServer(app);
const queryClaude = providerRuntimeService.getRunner('claude');
const queryCursor = providerRuntimeService.getRunner('cursor');
const queryCodex = providerRuntimeService.getRunner('codex');
const queryOpenCode = providerRuntimeService.getRunner('opencode');
const gitRoutes = createGitModule({
    queryClaude,
    queryCursor,
});
const agentRoutes = createAgentModule({
    queryClaude,
    queryCursor,
    queryCodex,
    queryOpenCode,
});

// Single WebSocket server that handles chat, shell, and plugin proxy paths.
// A completed run stays subscribable while its session's background work
// (agents, workflows, backgrounded commands) is still reporting through it.
chatRunRegistry.setRetentionGuard((sessionId) => providerRuntimeService.hasBackgroundWork(sessionId));
chatRunRegistry.setCompletionListener((sessionId, userId) => {
    if (userId === null || monitorsDb.isMonitorSession(Number(userId),sessionId)) return;
    taskmasterAutoService.schedule(sessionId, Number(userId));
    try { withUserContext(userId, () => sessionTitlesService.automatic(sessionId, 'completed')); }
    catch (error) { console.warn('[SessionTitles] Owner context unavailable:', String(error)); }
});

createWebSocketServer(server, {
    verifyClient: {
        isPlatform: IS_PLATFORM,
        authenticateWebSocket,
    },
    chat: {
        runtime: providerRuntimeService,
    },
    shell: {
        resolveProviderSessionId: (sessionId, provider) => {
            const dbSession = sessionsDb.getSessionById(sessionId);
            if (dbSession) {
                return dbSession.provider_session_id ?? null;
            }

            return null;
        },
    },
    getPluginPort,
});

app.use(accessBoundaryMiddleware);
app.use(cors({ exposedHeaders: ['X-Refreshed-Token', 'X-Auth-Error'] }));
app.use(express.json({
    limit: '50mb',
    type: (req) => {
        // Skip multipart/form-data requests (for file uploads like images)
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return false;
        }
        return contentType.includes('json');
    }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Public health check endpoint (no authentication required)
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        installMode,
        version: RUNNING_VERSION,
        distribution: process.env.CLOUDCLI_DISTRIBUTION || 'cloudcli',
        workbenchVersion: process.env.CLOUDCLI_WORKBENCH_VERSION || null,
        instanceId: process.env.CLOUDCLI_INSTANCE_ID || null
    });
});

// Optional API key validation (if configured)
app.use('/api', validateApiKey);

// Authentication routes (public)
app.use('/api/auth', authRoutes);
app.use('/api/usage', authenticateToken, usageRoutes);
app.use('/api/quota', authenticateToken, quotaRoutes);
app.use('/api/remote-access', authenticateToken, remoteAccessRoutes);

// File Tree API Routes (protected)
app.use('/api/file-tree', authenticateToken, fileTreeRoutes);

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, projectModuleRoutes);

// Chat attachment upload/serving (global ~/.cloudcli/assets store, protected)
app.use('/api/assets', authenticateToken, assetsRoutes);

// Git API Routes (protected)
app.use('/api/git', authenticateToken, gitRoutes);

// Git worktree management (protected)
app.use('/api/worktrees', authenticateToken, worktreesRoutes);

// TaskMaster API Routes (protected)
app.use('/api/taskmaster', authenticateToken, taskmasterRoutes);

// Commands API Routes (protected)
app.use('/api/commands', authenticateToken, commandsRoutes);

// Settings API Routes (protected)
app.use('/api/settings', authenticateToken, settingsRoutes);

app.use('/api/system', authenticateToken, systemRoutes);

app.use('/api/notifications', authenticateToken, notificationRoutes);

// User API Routes (protected)
app.use('/api/user', authenticateToken, userRoutes);

// Plugins API Routes (protected)
app.use('/api/plugins', authenticateToken, pluginsRoutes);

// Browser MCP bridge API (local token protected)
app.use('/api/browser-use-mcp', browserUseMcpRoutes);

// Browser API Routes (protected)
app.use('/api/browser-use', authenticateToken, browserUseRoutes);

// Unified provider MCP routes (protected)
app.use('/api/providers', authenticateToken, providerRoutes);
app.use('/api/scheduled-messages', authenticateToken, scheduledMessagesRoutes);
app.use('/api/monitors', authenticateToken, monitorsRoutes);
app.use('/api/side-chats', authenticateToken, sideChatsRoutes);
app.use('/api/message-queue', authenticateToken, messageQueueRoutes);
app.use('/api/session-workspace', authenticateToken, sessionWorkspaceRoutes);
app.use('/api/workspace-sections', authenticateToken, workspaceSectionsRoutes);
app.use('/api/project-organization', authenticateToken, projectOrganizationRoutes);
app.use('/api/session-bridge', authenticateToken, sessionBridgeRoutes);

// Agent API Routes (uses API key authentication)
app.use('/api/agent', agentRoutes);

app.use('/api/voice', authenticateToken, voiceRoutes);

// The local info-hub has no account system. Keep it behind Nexagent auth and
// forward both reads and writes so remote/mobile clients use the same boundary.
app.post('/api/infohub/session', authenticateToken, requireSharedResourceAdministrator, (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer /i, '');
    if (!token) return res.status(401).json({ error: 'Login required' });
    res.cookie('nexagent_infohub', token, { httpOnly: true, sameSite: 'strict', secure: req.secure || req.headers['x-forwarded-proto'] === 'https', path: '/infohub', maxAge: 15 * 60 * 1000 });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ready: true });
});
app.use('/infohub', (req, res, next) => {
    if (req.path === '/' && !req.originalUrl.startsWith('/infohub/')) return res.redirect('/information'+(req.originalUrl.includes('?')?req.originalUrl.slice(req.originalUrl.indexOf('?')):''));
    const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('nexagent_infohub='));
    if (!req.headers.authorization && cookie) {
        try { req.headers.authorization = `Bearer ${decodeURIComponent(cookie.slice('nexagent_infohub='.length))}`; } catch { /* Invalid cookies remain unauthenticated. */ }
    }
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin && req.headers.origin !== `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`) return res.status(403).json({ error: 'Cross-origin write denied' });
    next();
}, authenticateToken, requireSharedResourceAdministrator, async (req, res) => {
    if(req.path==='/nexagent/embed.js')return res.type('application/javascript').set('Cache-Control','no-store').send(infohubEmbedScript);
    const taskLink=req.path.match(/^\/nexagent\/task\/(\d+)$/);
    if(taskLink){
      try{let snapshot=await taskmasterInboxService.global();let found=snapshot.projects.flatMap(p=>p.tasks.map(t=>({projectId:p.projectId,task:t}))).find(r=>r.task.source==='infohub'&&String(r.task.sourceId)===taskLink[1]);
        if(!found){await taskmasterInboxService.syncInfohub();snapshot=await taskmasterInboxService.global();found=snapshot.projects.flatMap(p=>p.tasks.map(t=>({projectId:p.projectId,task:t}))).find(r=>r.task.source==='infohub'&&String(r.task.sourceId)===taskLink[1]);}
        if(found)return res.redirect('/tasks?project='+encodeURIComponent(found.projectId)+'&task='+encodeURIComponent(String(found.task.id)));
        return res.status(404).type('html').send('<p>该待办尚未同步到任务，请在任务页点击同步信息看板后重试。</p><a href="/tasks">打开任务</a>');
      }catch{return res.status(503).type('html').send('<p>信息看板离线，任务数据仍可使用。</p><a href="/tasks">打开任务</a>');}
    }
    const target = new URL(`http://127.0.0.1:8765${req.path || '/'}`);
    target.search = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body ?? {});
    const proxy = http.request(target, {
        method: req.method,
        headers: {
            ...Object.fromEntries(Object.entries(req.headers).filter(([key]) => !['host', 'content-length', 'connection', 'authorization', 'cookie'].includes(key))),
            ...(req.headers.cookie ? { cookie: req.headers.cookie.split(';').filter(value => !value.trim().startsWith('nexagent_infohub=')).join(';') } : {}),
            host: '127.0.0.1:8765',
            'x-forwarded-prefix': '/infohub',
            'x-forwarded-host': req.headers.host || '127.0.0.1:3001',
            'x-forwarded-proto': String(req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')),
            'accept-encoding': 'identity',
            ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body).toString() } : {}),
        },
    }, upstream => {
        res.status(upstream.statusCode ?? 502);
        const html = String(upstream.headers['content-type']).includes('text/html');
        for (const [key, value] of Object.entries(upstream.headers)) if (value !== undefined && !['transfer-encoding', 'x-frame-options', ...(html ? ['content-length', 'content-encoding'] : [])].includes(key.toLowerCase())) res.setHeader(key, value);
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Cache-Control', 'no-store');
        if (html) {
            const chunks: Buffer[] = [];
            upstream.on('data', chunk => chunks.push(Buffer.from(chunk)));
            upstream.on('end', () => {
                // Compatibility for info-hub builds predating X-Forwarded-Prefix support.
                const bridge = '<script>const infohubFetch=window.fetch.bind(window);window.fetch=(url,options)=>infohubFetch(typeof url==="string"&&url.startsWith("/api/")?"/infohub"+url:url,options);</script>';
                res.send(Buffer.concat(chunks).toString('utf8').replace('</head>', `${bridge}</head>`).replace('</body>','<script src="/infohub/nexagent/embed.js"></script></body>'));
            });
        } else upstream.pipe(res);
    });
    proxy.setTimeout(15000, () => proxy.destroy(new Error('info-hub timeout')));
    proxy.on('error', error => {
        if (!res.headersSent) {
            if(req.accepts('html'))res.status(503).type('html').send('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>信息看板暂不可用</title><body style="font:16px system-ui;margin:0;min-height:90vh;display:grid;place-content:center;padding:20px;color:#64748b"><h1 style="font-size:20px;color:#334155">信息看板暂时不可用</h1><p>请确认本机信息看板已启动，稍后重试。</p><button style="min-height:40px;padding:8px 20px" onclick="location.reload()">重新加载</button></body></html>');
            else res.status(503).json({ error: 'INFOHUB_UNAVAILABLE', message: '信息看板暂时不可用，请稍后重试。' });
        }
        else res.end();
        console.warn('[infohub proxy]', String(error));
    });
    if (body) proxy.write(body);
    proxy.end();
});

// Unknown API paths must not fall through to the SPA (including removed features).
app.use('/api', (_req, res) => { res.status(404).json({ error: 'NOT_FOUND' }); });

// Serve public files (like api-docs.html)
app.use(express.static(path.join(APP_ROOT, 'public')));

// Static files served after API routes
// Add cache control: HTML files should not be cached, but assets can be cached
app.use(express.static(path.join(APP_ROOT, 'dist'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            // Prevent HTML caching to avoid service worker issues after builds
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        } else if (filePath.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
            // Cache static assets for 1 year (they have hashed names)
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));

// API Routes (protected)
// /api/config endpoint removed - no longer needed
// Frontend now uses window.location for WebSocket URLs

// Chat uploads live under /api/assets (server/modules/assets), which stores
// images and general files in the global ~/.cloudcli/assets folder.

// Serve React app for all other routes (excluding static files)
app.get('*', (req, res) => {
    // Skip requests for static assets (files with extensions)
    if (path.extname(req.path)) {
        return res.status(404).send('Not found');
    }

    // Only serve index.html for HTML routes, not for static assets
    // Static assets should already be handled by express.static middleware above
    const indexPath = path.join(APP_ROOT, 'dist', 'index.html');

    // Check if dist/index.html exists (production build available)
    if (fs.existsSync(indexPath)) {
        // Set no-cache headers for HTML to prevent service worker issues
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(indexPath);
    } else {
        // In development, redirect to Vite dev server only if dist doesn't exist
        const redirectHost = getConnectableHost(req.hostname);
        res.redirect(`${req.protocol}://${redirectHost}:${VITE_PORT}`);
    }
});

// global error middleware must be last
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  console.error(err);

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
});

const SERVER_PORT = Number.parseInt(process.env.SERVER_PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DISPLAY_HOST = getConnectableHost(HOST);
const VITE_PORT = process.env.VITE_PORT || 5173;
const LOCAL_SERVER_MARKER_PATH = path.join(getCloudCliHomeDir(), 'local-server.json');

function getErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return undefined;
    }
    return String(error.code);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function writeLocalServerMarker() {
    const marker = {
        pid: process.pid,
        host: HOST,
        port: Number.parseInt(String(SERVER_PORT), 10),
        url: `http://${DISPLAY_HOST}:${SERVER_PORT}`,
        installMode,
        appRoot: APP_ROOT,
        updatedAt: new Date().toISOString(),
    };

    await fsPromises.mkdir(path.dirname(LOCAL_SERVER_MARKER_PATH), { recursive: true });
    await fsPromises.writeFile(LOCAL_SERVER_MARKER_PATH, JSON.stringify(marker, null, 2), 'utf8');
}

async function removeLocalServerMarker() {
    try {
        const raw = await fsPromises.readFile(LOCAL_SERVER_MARKER_PATH, 'utf8');
        const marker = JSON.parse(raw);
        if (marker.pid && marker.pid !== process.pid) return;
    } catch (error) {
        if (getErrorCode(error) === 'ENOENT') return;
    }

    try {
        await fsPromises.unlink(LOCAL_SERVER_MARKER_PATH);
    } catch (error) {
        if (getErrorCode(error) !== 'ENOENT') {
            console.warn('[WARN] Could not remove local server marker:', getErrorMessage(error));
        }
    }
}

// Initialize database and start server
async function startServer() {
    try {
        // Initialize authentication database
        await initializeDatabase();
        const protectedProviderSessions = process.env.CLAUDEX_PASSIVE_INSTANCE === '1' ? [] : await recoverProviderSupervision();
        initializeUsage();
        initializeQuota();
        initializeAgentDiscovery();
        initializeRemoteAccess();
        initializeLocalIdentity();

        // Configure Web Push (VAPID keys)
        configureWebPush();

        // Check if running in production mode (dist folder exists)
        const distIndexPath = path.join(APP_ROOT, 'dist', 'index.html');
        const isProduction = fs.existsSync(distIndexPath);

        // Log Claude implementation mode
        console.log(`${terminalTextStyles.info('[INFO]')} Using Claude Agents SDK for Claude integration`);
        console.log('');

        if (isProduction) {
            console.log(`${terminalTextStyles.info('[INFO]')} To run in production mode, go to http://${DISPLAY_HOST}:${SERVER_PORT}`);
        }

        console.log(`${terminalTextStyles.info('[INFO]')} To run in development mode with hot-module replacement, go to http://${DISPLAY_HOST}:${VITE_PORT}`);

        server.listen(SERVER_PORT, HOST, async () => {
            const appInstallPath = APP_ROOT;
            await writeLocalServerMarker().catch((error) => {
                console.warn('[WARN] Could not write local server marker:', error.message);
            });

            console.log('');
            console.log(terminalTextStyles.dim('═'.repeat(63)));
            console.log(`  ${terminalTextStyles.bright('Nexagent Server - Ready')}`);
            console.log(terminalTextStyles.dim('═'.repeat(63)));
            console.log('');
            console.log(`${terminalTextStyles.info('[INFO]')} Server URL:  ${terminalTextStyles.bright('http://' + DISPLAY_HOST + ':' + SERVER_PORT)}`);
            console.log(`${terminalTextStyles.info('[INFO]')} Installed at: ${terminalTextStyles.dim(appInstallPath)}`);
            console.log(`${terminalTextStyles.tip('[TIP]')}  Run "nexagent status" for full configuration details`);
            console.log('');

            // Start watching the projects folder for changes
            await initializeSessionsWatcher();
            void sessionsService.listRunningSessions().then(rows => console.log('[Recovery] Discoverable running sessions:', rows.length)).catch(error => console.warn('[Recovery]', error));
            // Sends anything that came due while the server was not running,
            // then keeps polling.
            // A backup-based verification instance must never replay production jobs
            // or compete with the production instance for plugin listening ports.
            const passiveInstance = process.env.CLAUDEX_PASSIVE_INSTANCE === '1';
            if (!passiveInstance) {
                initializeScheduledMessageDispatcher(providerRuntimeService);
                initializeMonitors(providerRuntimeService, protectedProviderSessions);
                initializeInfohubTaskSync();
                initializeTaskIntelligence();
                sideChatsDb.recover();
                initializeMessageQueue(providerRuntimeService, protectedProviderSessions);
            }

            // Start server-side plugin processes for enabled plugins
            if (!passiveInstance) startEnabledPluginServers().catch(err => {
                console.error('[Plugins] Error during startup:', err.message);
            });
        });

        await closeSessionsWatcher();
        closeScheduledMessageDispatcher();
        closeMonitors();
        closeInfohubTaskSync();closeTaskIntelligence();
        closeMessageQueue();
        // Clean up plugin processes on shutdown
        const shutdownRuntimeServices = async () => {
            closeUsage();
            closeQuota();
            closeRemoteAccess();
            try {
                await browserUseService.stopAllSessions();
            } catch (err) {
                console.error('[Browser] Error stopping sessions during shutdown:', getErrorMessage(err));
            }
            try {
                await stopAllPlugins();
            } catch (err) {
                console.error('[Plugins] Error stopping plugins during shutdown:', getErrorMessage(err));
            }
            try {
                await removeLocalServerMarker();
            } catch (err) {
                console.error('[Local Server] Error removing server marker during shutdown:', getErrorMessage(err));
            }
            process.exit(0);
        };
        process.on('SIGTERM', () => void shutdownRuntimeServices());
        process.on('SIGINT', () => void shutdownRuntimeServices());
    } catch (error) {
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
