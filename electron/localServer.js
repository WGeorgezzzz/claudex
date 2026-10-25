import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { mkdirSync, openSync, closeSync, existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { ServerInstaller } from './serverInstaller.js';
import { buildWorkbenchServerEnvironment, ensureWorkbenchIdentity } from './workbenchProfile.js';
import { localIdentityUrl } from './localIdentity.js';

const DEFAULT_PORT = 3001;
const HOST = '127.0.0.1';
const DISPLAY_HOST = 'localhost';
const HEALTH_TIMEOUT_MS = 1000;
const SERVER_START_TIMEOUT_MS = 30000;
const MAX_STARTUP_LOG_LINES = 300;
const SERVER_MARKER_PATH = path.join(os.homedir(), '.cloudcli', 'local-server.json');
const LOCAL_SERVER_URL_ENV_KEYS = [
  'CLOUDCLI_DESKTOP_LOCAL_SERVER_URL',
  'CLOUDCLI_LOCAL_SERVER_URL',
  'ELECTRON_LOCAL_SERVER_URL',
];
const LOCAL_SERVER_PORT_ENV_KEYS = [
  'CLOUDCLI_DESKTOP_LOCAL_SERVER_PORT',
  'CLOUDCLI_SERVER_PORT',
  'SERVER_PORT',
  'PORT',
];

function requestJson(url, timeoutMs = HEALTH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            json: JSON.parse(body),
          });
        } catch {
          resolve({ ok: false, json: null });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, json: null });
    });
    req.on('error', () => resolve({ ok: false, json: null }));
  });
}

async function isCloudCliServer(baseUrl) {
  const response = await requestJson(`${baseUrl}/health`);
  return response.ok
    && response.json?.status === 'ok'
    && typeof response.json?.installMode === 'string';
}

function isPortAvailable(port, host = HOST) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : DEFAULT_PORT;
      server.close(() => resolve(port));
    });
    server.listen(0, HOST);
  });
}

async function chooseServerPort(host, preferredPort = DEFAULT_PORT) {
  if (await isPortAvailable(preferredPort, host)) {
    return preferredPort;
  }

  return getFreePort();
}

function getDesktopPath() {
  const currentPath = process.env.PATH || '';
  const commonPaths = process.platform === 'win32'
    ? []
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

  return [...commonPaths, currentPath].filter(Boolean).join(path.delimiter);
}

function getNodeRuntime(usePackagedElectronRuntime) {
  if (process.env.ELECTRON_NODE_PATH) {
    return { command: process.env.ELECTRON_NODE_PATH, env: {}, label: 'ELECTRON_NODE_PATH' };
  }

  if (usePackagedElectronRuntime && process.versions.electron) {
    return {
      command: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      label: `Electron ${process.versions.electron} Node ${process.versions.node}`,
    };
  }

  if (process.env.npm_node_execpath) {
    return { command: process.env.npm_node_execpath, env: {}, label: 'npm_node_execpath' };
  }

  return { command: 'node', env: {}, label: 'PATH node' };
}

function stripTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function addCandidateUrl(urls, rawUrl) {
  if (!rawUrl) return;
  try {
    const parsed = new URL(String(rawUrl));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    parsed.hash = '';
    parsed.search = '';
    const normalized = stripTrailingSlash(parsed.toString());
    if (!urls.includes(normalized)) urls.push(normalized);
  } catch {
    // Ignore invalid user-provided discovery values.
  }
}

function addCandidatePort(urls, rawPort) {
  const port = Number.parseInt(String(rawPort || ''), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  addCandidateUrl(urls, `http://${HOST}:${port}`);
}

function getPortFromUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.port) return Number.parseInt(parsed.port, 10);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

function getDisplayUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.hostname === HOST) {
      parsed.hostname = DISPLAY_HOST;
    }
    return stripTrailingSlash(parsed.toString());
  } catch {
    return baseUrl;
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readServerBundleConfig(appRoot) {
  try {
    const raw = await fs.readFile(path.join(appRoot, 'electron', 'server-bundle-config.json'), 'utf8');
    const config = JSON.parse(raw);
    return {
      releaseTag: typeof config.releaseTag === 'string' && config.releaseTag.trim()
        ? config.releaseTag.trim()
        : '',
    };
  } catch {
    return { releaseTag: '' };
  }
}

function getServerCwd(appRoot, serverEntry) {
  const normalizedEntry = path.resolve(serverEntry);
  const bundledEntry = path.resolve(appRoot, 'dist-server', 'server', 'index.js');
  if (normalizedEntry === bundledEntry) {
    return appRoot;
  }

  // Installed server entries are laid out as <root>/dist-server/server/index.js.
  return path.resolve(path.dirname(normalizedEntry), '..', '..');
}

async function readServerMarkerUrl() {
  try {
    const raw = await fs.readFile(SERVER_MARKER_PATH, 'utf8');
    const marker = JSON.parse(raw);
    return marker.url || (marker.port ? `http://${marker.host || HOST}:${marker.port}` : null);
  } catch {
    return null;
  }
}

async function getExistingServerCandidateUrls(defaultUrl) {
  const urls = [];

  for (const key of LOCAL_SERVER_URL_ENV_KEYS) {
    addCandidateUrl(urls, process.env[key]);
  }

  addCandidateUrl(urls, await readServerMarkerUrl());

  for (const key of LOCAL_SERVER_PORT_ENV_KEYS) {
    addCandidatePort(urls, process.env[key]);
  }

  addCandidateUrl(urls, defaultUrl);
  return urls;
}

async function waitForCloudCliServer(baseUrl, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await isCloudCliServer(baseUrl)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return false;
}

export class LocalServerController {
  constructor({ appRoot, settingsPath, isPackaged = false, appVersion, onChange, workbenchProfile = null, userDataPath = null }) {
    this.appRoot = appRoot;
    this.settingsPath = settingsPath;
    this.isPackaged = isPackaged;
    this.appVersion = appVersion;
    this.onChange = onChange;
    this.workbenchProfile = workbenchProfile;
    this.userDataPath = userDataPath || path.dirname(settingsPath);
    this.instanceId = null;
    this.localServerUrl = null;
    this.localServerPort = null;
    this.ownedServerProcess = null;
    this.startupLogs = [];
    this.desktopSettings = {
      keepLocalServerRunning: Boolean(workbenchProfile),
      exposeLocalServerOnNetwork: false,
      themeMode: 'system',
      claudeConfigDir: '',
      claudeCliPath: '',
    };
  }

  getSettings() {
    return this.desktopSettings;
  }

  getLocalServerUrl() {
    return this.localServerUrl;
  }

  getHealthCheckUrl() {
    if (!this.localServerPort) return this.localServerUrl;
    return `http://${HOST}:${this.localServerPort}`;
  }

  appendStartupLog(line) {
    const text = String(line || '').trimEnd();
    if (!text) return;
    const timestamp = new Date().toLocaleTimeString();
    this.startupLogs.push(`[${timestamp}] ${text}`);
    if (this.startupLogs.length > MAX_STARTUP_LOG_LINES) {
      this.startupLogs.splice(0, this.startupLogs.length - MAX_STARTUP_LOG_LINES);
    }
    this.onChange?.();
  }

  getStartupLogs() {
    return [...this.startupLogs];
  }

  getPendingTarget() {
    return {
      kind: 'local',
      name: this.workbenchProfile ? 'Local Workbench' : 'Local Nexagent',
      url: this.localServerUrl || `http://${DISPLAY_HOST}:${this.localServerPort || this.workbenchProfile?.defaultPort || DEFAULT_PORT}`,
    };
  }

  getLanAddress() {
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      for (const entry of entries || []) {
        if (entry.family === 'IPv4' && !entry.internal) {
          return entry.address;
        }
      }
    }
    return null;
  }

  getShareableWebUrl() {
    if (!this.localServerUrl || !this.localServerPort) return null;
    if (this.desktopSettings.exposeLocalServerOnNetwork) {
      const lanAddress = this.getLanAddress();
      if (lanAddress) {
        return `http://${lanAddress}:${this.localServerPort}`;
      }
    }
    return this.getLocalServerUrl();
  }

  getServerBindHost() {
    return this.desktopSettings.exposeLocalServerOnNetwork ? '0.0.0.0' : HOST;
  }

  async loadDesktopSettings() {
    if (this.workbenchProfile) this.instanceId=await ensureWorkbenchIdentity(this.userDataPath);
    try {
      const raw = await fs.readFile(this.settingsPath, 'utf8');
      const stored = JSON.parse(raw);
      this.desktopSettings = {
        keepLocalServerRunning: Boolean(stored.keepLocalServerRunning),
        exposeLocalServerOnNetwork: Boolean(stored.exposeLocalServerOnNetwork),
        themeMode: stored.themeMode === 'light' || stored.themeMode === 'dark' ? stored.themeMode : 'system',
        claudeConfigDir: typeof stored.claudeConfigDir==='string' && path.isAbsolute(stored.claudeConfigDir) ? stored.claudeConfigDir : '',
        claudeCliPath: typeof stored.claudeCliPath==='string' && path.isAbsolute(stored.claudeCliPath) ? stored.claudeCliPath : '',
      };
    } catch {
      this.desktopSettings = {
        keepLocalServerRunning: Boolean(this.workbenchProfile),
        exposeLocalServerOnNetwork: false,
        themeMode: 'system',
        claudeConfigDir: '',
        claudeCliPath: '',
      };
    }
  }

  async saveDesktopSettings(nextSettings = this.desktopSettings) {
    this.desktopSettings = {
      keepLocalServerRunning: Boolean(nextSettings.keepLocalServerRunning),
      exposeLocalServerOnNetwork: Boolean(nextSettings.exposeLocalServerOnNetwork),
      themeMode: nextSettings.themeMode === 'light' || nextSettings.themeMode === 'dark' ? nextSettings.themeMode : 'system',
      claudeConfigDir: nextSettings.claudeConfigDir || '',
      claudeCliPath: nextSettings.claudeCliPath || '',
    };
    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
    await fs.writeFile(this.settingsPath, JSON.stringify(this.desktopSettings, null, 2), 'utf8');
    this.onChange?.();
  }

  async updateDesktopSetting(key, value) {
    if (!Object.prototype.hasOwnProperty.call(this.desktopSettings, key)) {
      throw new Error(`Unknown desktop setting: ${key}`);
    }

    const isProviderPath = key==='claudeConfigDir' || key==='claudeCliPath';
    if (isProviderPath && value && (typeof value!=='string' || !path.isAbsolute(value))) throw new Error('Provider paths must be absolute.');
    const wasExposeSetting = key === 'exposeLocalServerOnNetwork' || isProviderPath;
    const wasLocalRunning = Boolean(this.localServerUrl);
    const nextValue = key === 'themeMode' || isProviderPath ? value : Boolean(value);
    await this.saveDesktopSettings({ ...this.desktopSettings, [key]: nextValue });

    return {
      desktopSettings: this.desktopSettings,
      requiresRestartNotice: wasExposeSetting && wasLocalRunning,
    };
  }

  /** Resolves the local server entry, installing the matching runtime if needed. */
  async resolveServerEntry() {
    if (this.workbenchProfile) {
      const bundled=path.join(this.appRoot,'server','dist-server','server','index.js');
      const development=path.join(this.appRoot,'dist-server','server','index.js');
      if (await pathExists(bundled)) return bundled;
      if (!this.isPackaged && await pathExists(development)) return development;
      throw new Error('The Workbench server bundle is missing. Reinstall the Workbench package; upstream runtimes are not substituted.');
    }
    if (process.env.ELECTRON_SERVER_ENTRY) {
      return process.env.ELECTRON_SERVER_ENTRY;
    }

    const bundledEntry = path.join(this.appRoot, 'dist-server', 'server', 'index.js');
    if (process.env.CLOUDCLI_USE_INSTALLED_SERVER !== '1' && await pathExists(bundledEntry)) {
      return bundledEntry;
    }

    if (!this.appVersion) {
      throw new Error('Cannot install local server: app version is unknown.');
    }
    const bundleConfig = await readServerBundleConfig(this.appRoot);
    const installer = new ServerInstaller({
      version: this.appVersion,
      bundleReleaseTag: bundleConfig.releaseTag,
      onLog: (line) => this.appendStartupLog(line),
    });
    return installer.ensureInstalled();
  }

  startBundledServer(port, serverEntry) {
    const bindHost = this.getServerBindHost();
    const runtime = this.workbenchProfile
      ? {command:this.isPackaged?path.join(this.appRoot,'runtime',process.platform==='win32'?'node.exe':'node'):(process.env.npm_node_execpath||'node'),env:{},label:'Workbench isolated Node runtime'}
      : getNodeRuntime(this.isPackaged);
    const serverCwd = getServerCwd(this.appRoot, serverEntry);
    const nativeClaude=path.join(this.appRoot,'node_modules','@anthropic-ai',
      `claude-agent-sdk-${process.platform}-${process.arch}`,process.platform==='win32'?'claude.exe':'claude');
    if (this.workbenchProfile && this.isPackaged && !existsSync(nativeClaude)) throw new Error('Bundled Claude runtime is missing. Reinstall Workbench.');

    const command = `${runtime.command} ${serverEntry}`;
    this.appendStartupLog(`$ ${command}`);
    this.appendStartupLog(`runtime: ${runtime.label}`);
    this.appendStartupLog(`cwd: ${serverCwd}`);
    this.appendStartupLog(`HOST=${bindHost} SERVER_PORT=${port}`);
    // A detached Workbench server must not depend on the GUI's stdout pipes.
    // Its owned log files remain writable after the desktop app exits.
    const logHandles=[];
    if (this.workbenchProfile) {
      const directory=path.join(this.userDataPath,'logs');
      mkdirSync(directory,{recursive:true});
      logHandles.push(openSync(path.join(directory,'server.log'),'a'),openSync(path.join(directory,'server-error.log'),'a'));
    }

    this.ownedServerProcess = spawn(runtime.command, [serverEntry], {
      cwd: serverCwd,
      detached: true,
      env: this.workbenchProfile ? buildWorkbenchServerEnvironment({
        userDataPath:this.userDataPath,instanceId:this.instanceId,port,settings:this.desktopSettings,
        version:this.workbenchProfile.version,
        bundledClaudePath:existsSync(nativeClaude)?nativeClaude:undefined,
        runtimeDirectory:this.isPackaged?path.join(this.appRoot,'runtime'):undefined,
      }) : {
        ...process.env,
        ...runtime.env,
        HOST: bindHost,
        SERVER_PORT: String(port),
        PATH: getDesktopPath(),
      },
      stdio: this.workbenchProfile?['ignore',...logHandles]:['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    for (const handle of logHandles) closeSync(handle);

    this.ownedServerProcess.once('error', (error) => {
      this.appendStartupLog(`failed to start process: ${error.message}`);
      this.ownedServerProcess = null;
    });

    this.ownedServerProcess.stdout?.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        this.appendStartupLog(line);
      }
    });

    this.ownedServerProcess.stderr?.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        this.appendStartupLog(`stderr: ${line}`);
      }
    });

    this.ownedServerProcess.once('exit', (code, signal) => {
      this.appendStartupLog(`process exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}`);
      if (this.ownedServerProcess) {
        console.error(`Nexagent desktop server exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}`);
      }
      this.ownedServerProcess = null;
    });
  }

  async resolveLocalServerUrl() {
    if (this.workbenchProfile) return this.resolveWorkbenchServerUrl();
    const defaultUrl = `http://${HOST}:${DEFAULT_PORT}`;
    const defaultDisplayUrl = `http://${DISPLAY_HOST}:${DEFAULT_PORT}`;
    const devUrl = process.env.ELECTRON_DEV_URL;
    const forceOwnServer = process.env.ELECTRON_FORCE_OWN_SERVER === '1';

    if (devUrl) {
      const ready = await waitForCloudCliServer(defaultUrl, SERVER_START_TIMEOUT_MS);
      if (!ready) {
        throw new Error(`Development backend did not become ready at ${defaultDisplayUrl}`);
      }
      this.localServerPort = DEFAULT_PORT;
      return devUrl;
    }

    if (!forceOwnServer) {
      const candidateUrls = await getExistingServerCandidateUrls(defaultUrl);
      for (const candidateUrl of candidateUrls) {
        if (await isCloudCliServer(candidateUrl)) {
          const displayUrl = getDisplayUrl(candidateUrl);
          this.localServerPort = getPortFromUrl(candidateUrl);
          this.appendStartupLog(`Using existing Local Nexagent at ${displayUrl}`);
          return displayUrl;
        }
      }
    }

    const serverEntry = await this.resolveServerEntry();

    const port = await chooseServerPort(this.getServerBindHost());
    const serverUrl = `http://${HOST}:${port}`;
    const displayUrl = `http://${DISPLAY_HOST}:${port}`;
    this.localServerPort = port;
    this.startBundledServer(port, serverEntry);

    const ready = await waitForCloudCliServer(serverUrl, SERVER_START_TIMEOUT_MS);
    if (!ready) {
      const recentLogs = this.getStartupLogs().slice(-20).join('\n');
      await this.shutdownOwnedServer();
      this.localServerPort = null;
      throw new Error([
        `Bundled backend did not become ready at ${displayUrl}.`,
        recentLogs ? `Recent startup output:\n${recentLogs}` : 'No startup output was captured.',
      ].join('\n\n'));
    }

    this.appendStartupLog(`Local Nexagent ready at ${displayUrl}`);
    this.localServerUrl = displayUrl;
    return displayUrl;
  }

  async ensureLocalServer() {
    if (this.startupPromise) return this.startupPromise;
    this.startupPromise = (async () => {
      if (!this.localServerUrl || !(this.workbenchProfile ? await this.isWorkbenchServer(this.localServerUrl) : await isCloudCliServer(this.localServerUrl))) {
        this.localServerUrl = await this.resolveLocalServerUrl();
      }
      return this.localServerUrl;
    })();
    try { return await this.startupPromise; }
    finally { this.startupPromise = null; }
  }

  async isWorkbenchServer(url) {
    try {
      const parsed=new URL(url);
      if (!['127.0.0.1','localhost'].includes(parsed.hostname) || parsed.protocol!=='http:') return false;
      const health=await requestJson(`${url}/health`);
      return health.ok && health.json?.status==='ok' && health.json?.distribution==='workbench'
        && health.json?.instanceId===this.instanceId && health.json?.workbenchVersion===this.workbenchProfile.version;
    } catch { return false; }
  }

  async resolveWorkbenchServerUrl() {
    this.instanceId ||= await ensureWorkbenchIdentity(this.userDataPath);
    // Only this installation's marker can nominate an existing service.
    const marker=path.join(this.userDataPath,'server','local-server.json');
    let stored;
    try { stored=JSON.parse(await fs.readFile(marker,'utf8')); }
    catch { /* A missing or malformed owned marker cannot nominate another service. */ }
    if (stored) {
      const url=`http://${HOST}:${Number(stored.port)}`;
      const health=await requestJson(`${url}/health`);
      if (health.ok && health.json?.status==='ok' && health.json?.distribution==='workbench' && health.json?.instanceId===this.instanceId) {
        if (health.json.workbenchVersion!==this.workbenchProfile.version) {
          throw new Error('A different Workbench version still owns this profile. Finish its tasks and stop its service before upgrading. No running work was stopped.');
        }
        this.localServerPort=Number(stored.port);
        this.appendStartupLog(`Reusing this Workbench installation at ${url}`);
        return url;
      }
    }
    const entry=await this.resolveServerEntry();
    const port=await chooseServerPort(this.getServerBindHost(),this.workbenchProfile.defaultPort);
    this.localServerPort=port;
    const url=`http://${HOST}:${port}`;
    this.startBundledServer(port,entry);
    const started=Date.now();
    while (Date.now()-started<SERVER_START_TIMEOUT_MS) {
      if (await this.isWorkbenchServer(url)) {
        this.appendStartupLog(`Workbench ready at ${url}`);
        return url;
      }
      await new Promise(resolve=>setTimeout(resolve,300));
    }
    await this.shutdownOwnedServer();
    throw new Error('Workbench did not become ready. Check its local startup log.');
  }

  async getResolvedTarget() {
    await this.ensureLocalServer();
    return {
      kind: 'local',
      name: this.workbenchProfile ? 'Local Workbench' : 'Local Nexagent',
      url: this.workbenchProfile ? await localIdentityUrl(this.localServerUrl,process.env.CLAUDEX_LOCAL_IDENTITY_HOME || path.join(this.userDataPath,'server')) : this.localServerUrl,
    };
  }

  async loadLocalTarget() {
    return {
      pendingTarget: this.getPendingTarget(),
      target: await this.getResolvedTarget(),
    };
  }

  hasOwnedServer() {
    return Boolean(this.ownedServerProcess);
  }

  detachOwnedServer() {
    if (!this.ownedServerProcess) return;
    this.ownedServerProcess.unref();
    this.ownedServerProcess = null;
  }

  async shutdownOwnedServer() {
    if (!this.ownedServerProcess) return;

    const child = this.ownedServerProcess;
    this.ownedServerProcess = null;
    child.kill('SIGTERM');

    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 3000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

export { DEFAULT_PORT, HOST };
