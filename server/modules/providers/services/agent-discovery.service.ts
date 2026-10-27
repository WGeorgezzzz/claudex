import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveDeepSeekHarnessInstallation } from '@/modules/providers/list/deepseek-harness/deepseek-harness-installation.provider.js';
import { appConfigDb, userDb } from '@/modules/database/index.js';
import { getCurrentUserContext, withUserContext } from '@/modules/auth/index.js';
import { AppError, getCloudCliHomeDir } from '@/shared/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { probeAgent, countAgentSessions } from './agent-probe.js';

const AGENTS = [
  { id: 'claude', name: 'Claude Code', commands: ['claude'], config: '.claude', sessions: 'projects', install: 'npm install -g @anthropic-ai/claude-code', supported: true },
  { id: 'codex', name: 'Codex', commands: ['codex'], config: '.codex', sessions: 'sessions', install: 'npm install -g @openai/codex', supported: true },
  { id: 'cursor', name: 'Cursor', commands: ['cursor-agent', 'agent'], config: '.cursor', sessions: 'chats', install: 'curl https://cursor.com/install -fsS | bash', supported: true },
  { id: 'opencode', name: 'OpenCode', commands: ['opencode'], config: '.local/share/opencode', sessions: 'storage/session', install: 'npm install -g opencode-ai', supported: true },
  { id: 'deepseek-harness', name: 'DeepSeek Harness', commands: ['dsh'], config: '.dsh', sessions: 'sessions', install: 'https://deepseek.com/harness/', supported: true },
  { id: 'workbuddy', name: 'WorkBuddy', commands: ['workbuddy'], config: '.workbuddy', sessions: 'transcripts', install: 'https://www.codebuddy.cn/work/', supported: true },
  { id: 'gemini', name: 'Gemini CLI', commands: ['gemini'], config: '.gemini', sessions: 'tmp', install: 'npm install -g @google/gemini-cli', supported: false },
  { id: 'qwen', name: 'Qwen Code', commands: ['qwen'], config: '.qwen', sessions: 'projects', install: 'npm install -g @qwen-code/qwen-code', supported: false },
  { id: 'aider', name: 'Aider', commands: ['aider'], config: '.aider', sessions: '', install: 'python -m pip install aider-install && aider-install', supported: false },
  { id: 'copilot', name: 'GitHub Copilot CLI', commands: ['copilot'], config: '.copilot', sessions: 'session-state', install: 'npm install -g @github/copilot', supported: false },
];
type Program = { executable: string; version: string } | null;
let programs: Map<string, Program> | undefined;
let hostScan: Promise<void> | undefined;
const userScans = new Map<number, Promise<unknown>>();

async function scanHost() {
  if (!hostScan) hostScan = (async () => {
    const found = await Promise.all(AGENTS.map(async agent => {
      if (agent.id === 'deepseek-harness') {
        const install = resolveDeepSeekHarnessInstallation();
        if (!install) return [agent.id, null] as const;
        const pkg = JSON.parse(await readFile(install.packageFile, 'utf8'));
        return [agent.id, { executable: install.launcher, version: String(pkg.version) }] as const;
      }
      return [agent.id, await probeAgent(agent.commands)] as const;
    }));
    programs = new Map(found);
    // Existing runtime launchers inherit PATH, including Agents installed outside the service's original PATH.
    const directories = found.filter(([id, value]) => value && AGENTS.find(a => a.id === id)?.supported).map(([, value]) => path.dirname(value!.executable));
    process.env.PATH = [...new Set([...directories, ...(process.env.PATH ?? '').split(path.delimiter)])].join(path.delimiter);
    appConfigDb.set('agent-discovery:machine', JSON.stringify({ at: new Date().toISOString(), agents: found }));
  })().finally(() => { hostScan = undefined; });
  return hostScan;
}

/** Providers routes and lifecycle discover programs once per host and credentials separately inside each user's runtime context. */
export const agentDiscoveryService = {
  async scan(force = false) {
    const identity = getCurrentUserContext();
    if (!identity) throw new AppError('Authentication required', { statusCode: 401 });
    const existing = userScans.get(identity.userId);
    if (existing) return existing;
    const task = (async () => {
      if (force || !programs) await scanHost();
      const disabled = JSON.parse(appConfigDb.get('agent-discovery:disabled') ?? '[]') as string[];
      const agents = await Promise.all(AGENTS.map(async agent => {
        if (identity.role === 'member' && (!agent.supported || !['claude', 'codex'].includes(agent.id))) return null;
        const program = programs?.get(agent.id);
        let authenticated = false;
        if (program && agent.supported) {
          try { authenticated = Boolean((await providerRegistry.resolveProvider(agent.id).auth.getStatus()).authenticated); } catch { /* Report unavailable auth without exposing raw paths or credentials. */ }
        }
        const configDirectory = agent.id === 'claude' ? identity.claudeConfigDir : agent.id === 'codex' ? identity.codexHome
          : agent.id === 'workbuddy' ? path.join(getCloudCliHomeDir(), 'workbuddy')
          : agent.id === 'deepseek-harness' ? path.join(resolveDeepSeekHarnessInstallation()?.directory || '', 'home') : path.join(os.homedir(), agent.config);
        const sessionCount = await countAgentSessions(path.join(configDirectory, agent.sessions),
          agent.id === 'opencode' ? path.join(configDirectory, 'opencode.db') : undefined,
          agent.id === 'deepseek-harness' ? /\.jsonl\.zstd$/ : ['opencode', 'gemini'].includes(agent.id) ? /\.json$/ : undefined);
        return { id: agent.id, name: agent.name, installed: Boolean(program), version: program?.version ?? null,
          supported: agent.supported, authenticated, enabled: Boolean(program && authenticated && !disabled.includes(agent.id)),
          disabled: disabled.includes(agent.id), installCommand: agent.install,
          ...(identity.role === 'admin' ? { executable: program?.executable ?? null, configDirectory, sessionCount } : {}) };
      }));
      const result = { scannedAt: new Date().toISOString(), agents: agents.filter(a => a !== null) };
      appConfigDb.set(`agent-discovery:user:${identity.userId}`, JSON.stringify(result));
      return result;
    })().finally(() => userScans.delete(identity.userId));
    userScans.set(identity.userId, task);
    return task;
  },
  async read() {
    const identity = getCurrentUserContext();
    if (!identity) throw new AppError('Authentication required', { statusCode: 401 });
    const cached = appConfigDb.get(`agent-discovery:user:${identity.userId}`);
    if (!cached) return this.scan();
    const data = JSON.parse(cached);
    if (!data.scannedAt || Date.now() - Date.parse(data.scannedAt) > 120000) return this.scan();
    const disabled = JSON.parse(appConfigDb.get('agent-discovery:disabled') ?? '[]') as string[];
    data.agents = data.agents.filter((a: {id: string}) => identity.role === 'admin' || ['claude', 'codex'].includes(a.id))
      .map((a: Record<string, unknown>) => {
        const enabled = Boolean(a.installed && a.authenticated && !disabled.includes(String(a.id)));
        if (identity.role === 'member') {
          const { executable: _executable, configDirectory: _configDirectory, sessionCount: _sessionCount, ...safe } = a;
          return { ...safe, enabled, disabled: disabled.includes(String(a.id)) };
        }
        return { ...a, enabled, disabled: disabled.includes(String(a.id)) };
      });
    return data;
  },
  setEnabled(id: string, enabled: boolean) {
    if (getCurrentUserContext()?.role !== 'admin') throw new AppError('Administrator required', { statusCode: 403 });
    if (!AGENTS.some(a => a.id === id && a.supported)) throw new AppError('Invalid provider', { statusCode: 400 });
    const disabled = new Set<string>(JSON.parse(appConfigDb.get('agent-discovery:disabled') ?? '[]'));
    if (enabled) disabled.delete(id); else disabled.add(id);
    appConfigDb.set('agent-discovery:disabled', JSON.stringify([...disabled]));
  },
  assertEnabled(id: string) {
    const disabled = JSON.parse(appConfigDb.get('agent-discovery:disabled') ?? '[]') as string[];
    if (disabled.includes(id)) throw new AppError('Provider disabled by administrator', { statusCode: 403 });
    if (getCurrentUserContext()?.role === 'member' && !['claude', 'codex'].includes(id)) throw new AppError('Provider unavailable for this account', { statusCode: 403 });
  },
};

/** Server starts discovery asynchronously after database initialization without delaying its listener. */
export function initializeAgentDiscovery() {
  setImmediate(() => {
    const owner = userDb.getFirstUser();
    if (owner) void withUserContext(owner.id, () => agentDiscoveryService.scan(true)).catch(() => console.warn('[Discovery] Initial scan failed'));
    else void scanHost().catch(() => console.warn('[Discovery] Initial scan failed'));
  });
}
