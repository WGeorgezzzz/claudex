import path from 'node:path';
import os from 'node:os';
import { getSessionOwnerId, userPreferencesDb } from '@/modules/database/index.js';
import { agentDiscoveryService } from './agent-discovery.service.js';
import { AppError, userContextStorage } from '@/shared/utils.js';
import { withUserContext, assertUserPath, getCurrentUserContext } from '@/modules/auth/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { findClaudeCliProcessIds } from '@/modules/providers/services/claude-cli-liveness.service.js';
import { killProcessTree } from '@/shared/process-tree.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { createMonitorQuery } from '@/modules/monitors/index.js';
import { createSessionBridgeQuery } from '@/modules/session-bridge/index.js';
import { createDotQuery } from '@/modules/dot/index.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderRunFunction,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  ProviderLiveInputResult,
} from '@/shared/types.js';

type ProviderRuntimeServiceDependencies = {
  listProviders(): IProvider[];
  resolveProvider(provider: string): IProvider;
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  findClaudeCliProcessIds(providerSessionId: string): Promise<number[]>;
  killProcessTree(pid: number): Promise<boolean>;
  resolveResumeModel(
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  getProviderModels: typeof providerModelsService.getProviderModels;
};

const defaultDependencies: ProviderRuntimeServiceDependencies = {
  listProviders: () => providerRegistry.listProviders(),
  resolveProvider: (provider) => providerRegistry.resolveProvider(provider),
  resolveProviderSessionId: (sessionId) => sessionsService.resolveProviderSessionId(sessionId),
  findClaudeCliProcessIds,
  killProcessTree,
  resolveResumeModel: (provider, sessionId, requestedModel) =>
    providerModelsService.resolveResumeModel(provider, sessionId, requestedModel),
  getProviderModels: (provider) => providerModelsService.getProviderModels(provider),
};

/**
 * Creates the application-facing provider runtime dispatcher.
 *
 * The provider registry owns each concrete runtime. This service supplies the
 * registry-backed model/session lookups at execution time so runtime adapters
 * never import services that resolve back through the registry.
 */
export function createProviderRuntimeService(
  dependencyOverrides: Partial<ProviderRuntimeServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  const createRuntimeContext = (
    provider: IProvider,
  ): ProviderRuntimeContext => ({
    resolveProviderSessionId: dependencies.resolveProviderSessionId,
    resolveResumeModel: (sessionId, requestedModel) =>
      dependencies.resolveResumeModel(provider.id, sessionId, requestedModel),
    getProviderModels: async () => dependencies.getProviderModels(provider.id),
    normalizeMessage: (raw, sessionId) => provider.sessions.normalizeMessage(raw, sessionId),
    async isProviderInstalled() {
      try {
        return (await provider.auth.getStatus()).installed;
      } catch {
        // Preserve the runtime's original error when installation probing fails.
        return true;
      }
    },
  });

  const run = (
    providerName: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown> => {
    const provider = dependencies.resolveProvider(providerName);
    const context=createRuntimeContext(provider);
    const userId=Number(writer.userId);
    if(providerName==='claude'&&writer.userId!=null&&Number.isInteger(userId)&&typeof options.sessionId==='string') {
      const monitorQuery=createMonitorQuery({userId,sessionId:options.sessionId,
        readOnly:Boolean(options.cloudcliBridgeSourceSessionId)||options.permissionMode==='plan',
        monitorId:typeof options.cloudcliMonitorId==='string'?options.cloudcliMonitorId:undefined,
        model:typeof options.model==='string'?options.model:undefined,
        effort:typeof options.effort==='string'?options.effort:undefined,
        permissionMode:typeof options.permissionMode==='string'?options.permissionMode:undefined});
      context.createQuery=createSessionBridgeQuery({userId,sessionId:options.sessionId,
        autonomous:Boolean(options.cloudcliMonitorId||options.cloudcliBridgeSourceSessionId),planMode:options.permissionMode==='plan'},monitorQuery);
      context.createQuery=createDotQuery({userId,sessionId:options.sessionId,
        autonomous:Boolean(options.cloudcliMonitorId||options.cloudcliBridgeSourceSessionId),planMode:options.permissionMode==='plan'},context.createQuery);
    }
    // Durable queue records store explicit allow/deny lists at the top level.
    // Claude's SDK adapter consumes toolsSettings; preserve those choices on queued turns.
    const runtimeOptions=providerName==='claude'&&!options.toolsSettings&&(Array.isArray(options.allowedTools)||Array.isArray(options.disallowedTools))
      ? {...options,toolsSettings:{allowedTools:options.allowedTools??[],disallowedTools:options.disallowedTools??[],skipPermissions:false}}
      : options;
    const execute = () => {
      agentDiscoveryService.assertEnabled(providerName);
      if (writer.userId != null) {
        for (const candidate of [runtimeOptions.cwd, runtimeOptions.projectPath]) {
          if (candidate != null && candidate !== '') {
            if (typeof candidate !== 'string') throw new AppError('Invalid runtime path.', { statusCode: 400 });
            assertUserPath(userId, candidate);
          }
        }
        if (!runtimeOptions.cwd && !runtimeOptions.projectPath) assertUserPath(userId, process.cwd());
        if (typeof runtimeOptions.sessionId === 'string') {
          const owner = getSessionOwnerId(runtimeOptions.sessionId);
          if (owner != null && owner !== userId) throw new AppError('Session belongs to another user.', { statusCode: 403 });
        }
      }
      const user = getCurrentUserContext();
      // TaskMaster stores this server-owned marker when creating a Codex session. Subsequent turns keep its relay profile.
      if (providerName === 'codex' && user?.role === 'admin' && typeof runtimeOptions.sessionId === 'string'
        && userPreferencesDb.getPreferences(userId)[`taskmasterCodexSession:${runtimeOptions.sessionId}`] === true) {
        const codexHome = process.env.TASKMASTER_CODEX_HOME || path.join(os.homedir(), '.codex-qz');
        return userContextStorage.run({ ...user, codexHome, env: { ...user.env, CODEX_HOME: codexHome } }, async () => {
          const startedAt = new Date(Date.now() - 1000);
          const result = await provider.runtime.run(command, runtimeOptions, writer, context);
          // The ordinary watcher follows the account home; index this relay turn before completion extraction reads it.
          await provider.sessionSynchronizer.synchronize(startedAt);
          return result;
        });
      }
      return provider.runtime.run(command, runtimeOptions, writer, context);
    };
    return writer.userId == null ? execute() : withUserContext(userId, execute);
  };

  return {
    run,
    /** Message Queue uses this for explicit live additions; unsupported runtimes fail without starting a new run. */
    submitLiveInput(providerName: LLMProvider, sessionId: string, id: string, content: string, settled: (result: ProviderLiveInputResult) => void): void {
      const submit=dependencies.resolveProvider(providerName).runtime.submitLiveInput;
      if (!submit) throw new Error('This provider does not support live additions.');
      submit(sessionId,id,content,settled);
    },

    hasRuntime(providerName: string): boolean {
      try {
        return Boolean(dependencies.resolveProvider(providerName).runtime);
      } catch {
        return false;
      }
    },

    getRunner(provider: LLMProvider): ProviderRunFunction {
      return (command, options, writer) => run(provider, command, options, writer);
    },

    async abort(providerName: LLMProvider, sessionId: string): Promise<boolean> {
      return Boolean(await dependencies.resolveProvider(providerName).runtime.abort(sessionId));
    },

    /**
     * Stops a session no matter what state its process is in: the normal abort
     * is started first (so the run loop knows the end is a cancel, not a
     * crash), then every live CLI process tied to the session is killed with
     * its whole tree — shells, sub-agents, MCP servers. Also reaches a Claude
     * CLI Nexagent did not start, which a normal stop cannot interrupt.
     */
    async forceStop(providerName: LLMProvider, sessionId: string): Promise<{ killedPids: number[] }> {
      const { runtime } = dependencies.resolveProvider(providerName);
      const abortPromise = Promise.resolve()
        .then(() => runtime.abort(sessionId))
        .catch((error) => {
          console.error(`[ForceStop] abort failed for ${sessionId}:`, error?.message || error);
          return false;
        });

      const killedPids: number[] = [];
      if (providerName === 'claude') {
        const providerSessionId = dependencies.resolveProviderSessionId(sessionId);
        const pids = providerSessionId ? await dependencies.findClaudeCliProcessIds(providerSessionId) : [];
        for (const pid of pids) {
          if (await dependencies.killProcessTree(pid)) {
            killedPids.push(pid);
          }
        }
      }

      await abortPromise;
      console.log(`[ForceStop] ${providerName} session ${sessionId} stopped; killed pids: ${killedPids.join(',') || 'none'}`);
      return { killedPids };
    },

    async stopBackgroundTask(providerName: LLMProvider, sessionId: string, taskId: string): Promise<boolean> {
      // A runtime that never holds background work has no task to stop.
      const { runtime } = dependencies.resolveProvider(providerName);
      return Boolean(await runtime.stopBackgroundTask?.(sessionId, taskId));
    },

    hasBackgroundWork(sessionId: string): boolean {
      return dependencies.listProviders().some((provider) =>
        (provider.runtime.listBackgroundWork?.() ?? []).some((entry) => entry.sessionId === sessionId));
    },

    resolveToolApproval(requestId: string, decision: ProviderPermissionDecision): void {
      for (const provider of dependencies.listProviders()) {
        provider.runtime.permissions?.resolve(requestId, decision);
      }
    },

    getPendingApprovalsForSession(sessionId: string): unknown[] {
      return dependencies.listProviders().flatMap(
        (provider) => provider.runtime.permissions?.listPending(sessionId) ?? [],
      );
    },
  };
}

export const providerRuntimeService = createProviderRuntimeService();
