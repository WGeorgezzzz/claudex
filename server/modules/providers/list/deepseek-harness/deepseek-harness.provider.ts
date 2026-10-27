import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { buildDefaultProviderCurrentActiveModel } from '@/shared/index.js';
import type { IProviderAuth, IProviderModels, IProviderSkills, IProviderMcp } from '@/shared/index.js';
import { resolveDeepSeekHarnessInstallation } from '@/modules/providers/list/deepseek-harness/deepseek-harness-installation.provider.js';
import { deepSeekHarnessRuntime } from '@/modules/providers/list/deepseek-harness/deepseek-harness-runtime.provider.js';
import { DeepSeekHarnessSessions } from '@/modules/providers/list/deepseek-harness/deepseek-harness-sessions.provider.js';

const unsupported = async (): Promise<never> => { throw new Error('Manage Harness models, skills and MCP in its native local configuration.'); };

/** Registry-owned adapter to the official Harness; local configuration and credentials remain outside Nexagent. */
export class DeepSeekHarnessProvider extends AbstractProvider {
  readonly runtime = deepSeekHarnessRuntime;
  readonly sessions = new DeepSeekHarnessSessions();
  readonly sessionSynchronizer = { synchronize: async () => 0, synchronizeFile: async () => null };
  readonly auth: IProviderAuth = { async getStatus() {
    const install = resolveDeepSeekHarnessInstallation();
    return { provider: 'deepseek-harness', installed: Boolean(install), authenticated: Boolean(install?.configured),
      email: null, method: 'local_config', error: install?.configured ? undefined : 'Configure DeepSeek Harness locally before connecting.' };
  } };
  readonly models: IProviderModels = {
    async getSupportedModels() {
      return { CUSTOM_MODELS_SUPPORTED: false, OPTIONS: [{ value: 'configured', label: 'Harness 默认模型', description: '使用本机 DeepSeek Harness 已配置的模型与凭证。' }], DEFAULT: 'configured' };
    },
    async getCurrentActiveModel() { return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels()); },
  };
  readonly skills: IProviderSkills = { listSkills: async () => [], addSkills: unsupported, removeSkill: unsupported };
  readonly mcp: IProviderMcp = { listServers: async () => ({ user: [], project: [], local: [] }), listServersForScope: async () => [],
    upsertServer: unsupported, removeServer: unsupported };
  constructor() { super('deepseek-harness'); }
}
