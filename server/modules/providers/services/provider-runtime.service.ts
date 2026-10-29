import { recordModelRejection } from './provider-model-health.js';
import { supervisedRuntimeState } from './provider-supervision-state.service.js';
import path from 'node:path';
import os from 'node:os';
import { getSessionOwnerId, userPreferencesDb } from '@/modules/database/index.js';
import { agentDiscoveryService } from './agent-discovery.service.js';
import { AppError, userContextStorage } from '@/shared/utils.js';
import { withUserContext, assertUserPath, getCurrentUserContext } from '@/modules/auth/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { findResumedProviderProcesses, findClaudeCliProcessIds } from '@/modules/providers/services/claude-cli-liveness.service.js';
import { killProcessTree, listDescendants } from '@/shared/process-tree.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { createMonitorQuery } from '@/modules/monitors/index.js';
import { createSessionBridgeQuery } from '@/modules/session-bridge/index.js';
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
  killProcessTree(pid: number, capturedDescendants?: number[]): Promise<boolean>;
  listDescendants(pid: number): Promise<number[]>;
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
  listDescendants,
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
  supervision = false,
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
    if (supervision && supervisedRuntimeState.draining) return Promise.reject(new Error('Provider ingress is frozen for restart.'));
    if (supervision && ['codex', 'claude'].includes(providerName) && writer.userId != null && options.sessionId) {
      return import('./provider-supervision-controller.service.js').then(module => module.runSupervised(providerName, command, options, writer));
    }
    // Missing choices use the user's new default; explicit modes remain intact.
    options={...options,permissionMode:options.permissionMode??'bypassPermissions'};
    const provider = dependencies.resolveProvider(providerName);
    const context=createRuntimeContext(provider);
    const userId=Number(writer.userId);
    if(providerName==='claude'&&writer.userId!=null&&Number.isInteger(userId)&&typeof options.sessionId==='string') {
      const monitorQuery=createMonitorQuery({userId,sessionId:options.sessionId,
        readOnly:(Boolean(options.cloudcliBridgeSourceSessionId)&&!options.cloudcliBridgeUserAuthorization)||options.permissionMode==='plan',
        authorization:options.cloudcliBridgeUserAuthorization,
        monitorId:typeof options.cloudcliMonitorId==='string'?options.cloudcliMonitorId:undefined,
        model:typeof options.model==='string'?options.model:undefined,
        effort:typeof options.effort==='string'?options.effort:undefined,
        permissionMode:typeof options.permissionMode==='string'?options.permissionMode:undefined});
      context.createQuery=createSessionBridgeQuery({userId,sessionId:options.sessionId,
        userMessageId:options.cloudcliUserMessageId,userMessage:options.cloudcliUserMessage,autonomous:Boolean(options.cloudcliMonitorId||options.cloudcliBridgeSourceSessionId||options.bridgeCompact),planMode:options.permissionMode==='plan',permissionMode:typeof options.permissionMode==='string'?options.permissionMode:'default'},monitorQuery);
    }
    // Durable queue records store explicit allow/deny lists at the top level.
    // Claude's SDK adapter consumes toolsSettings; preserve those choices on queued turns.
    const nativeOptions=providerName==='codex'&&/^\/compact(?:\s|$)/.test(command.trim())?{...options,bridgeCompact:true}:options;
    const runtimeOptions=providerName==='claude'&&!options.toolsSettings&&(Array.isArray(options.allowedTools)||Array.isArray(options.disallowedTools))
      ? {...options,toolsSettings:{allowedTools:options.allowedTools??[],disallowedTools:options.disallowedTools??[],skipPermissions:false}}
      : nativeOptions;
    const healthWriter=providerName==='codex'?new Proxy(writer,{get(target,property){
      if(property==='send')return (data:unknown)=>{if(data&&typeof data==='object'&&(data as AnyRecord).kind==='error')recordModelRejection(providerName,String(options.model||''),String((data as AnyRecord).content||''));target.send(data as AnyRecord);};
      const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
    }}):writer;
    const execute = async () => {
      agentDiscoveryService.assertEnabled(providerName);
      if (providerName === 'claude' && process.env.NEXAGENT_PROVIDER_WORKER === '1' && process.platform === 'win32') {
        const { spawn } = await import('node:child_process');
        const baseQuery = context.createQuery || (await import('@anthropic-ai/claude-agent-sdk')).query as NonNullable<ProviderRuntimeContext['createQuery']>;
        // The SDK stays in the supervisor, while its native CLI receives a
        // separate Windows console/process group with supervisor-owned pipes.
        context.createQuery = input => baseQuery({ ...input, options: { ...input.options,
          spawnClaudeCodeProcess: (launch: { command: string; args: string[]; cwd?: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }) =>
            spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, signal: launch.signal,
              stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true }),
        } });
      }
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
          const result = await provider.runtime.run(command, runtimeOptions, healthWriter, context);
          // The ordinary watcher follows the account home; index this relay turn before completion extraction reads it.
          await provider.sessionSynchronizer.synchronize(startedAt);
          return result;
        });
      }
      return provider.runtime.run(command, runtimeOptions, healthWriter, context);
    };
    return (writer.userId == null ? execute() : withUserContext(userId, execute)).catch(error=>{recordModelRejection(providerName,String(options.model||''),String(error instanceof Error?error.message:error));throw error;});
  };

  return {
    run,
    /** Message Queue uses this for explicit live additions; unsupported runtimes fail without starting a new run. */
    submitLiveInput(providerName: LLMProvider, sessionId: string, id: string, content: string, settled: (result: ProviderLiveInputResult) => void): void {
      const owned = supervision ? supervisedRuntimeState.entries.get(sessionId) : undefined;
      if (owned?.client) { void owned.client.control({ type: 'live-input', id, content }).then(settled, error => settled({ status: 'failed', error: String(error) })); return; }
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
      const owned = supervision ? supervisedRuntimeState.entries.get(sessionId) : undefined;
      if (owned) { const client = owned.client || await owned.launching; return Boolean(await client?.control({ type: 'abort' })); }
      return Boolean(await dependencies.resolveProvider(providerName).runtime.abort(sessionId));
    },

    /**
     * Stops a session no matter what state its process is in: the normal abort
     * is started after capturing ancestry (so the run loop knows the end is a
     * cancel), then every live CLI process tied to the session is killed with
     * its whole tree — shells, sub-agents, MCP servers. Also reaches a Claude
     * CLI Nexagent did not start, which a normal stop cannot interrupt.
     */
    async forceStop(providerName: LLMProvider, sessionId: string): Promise<{ killedPids: number[] }> {
      const owned = supervision ? supervisedRuntimeState.entries.get(sessionId) : undefined;
      if (owned) { const client = owned.client || await owned.launching; return client!.control({ type: 'force-stop' }); }
      const { runtime } = dependencies.resolveProvider(providerName);
      // Snapshot before interrupt: a fast abort can remove the shell and its
      // MSYS ancestry before the forced kill gets a chance to enumerate it.
      const providerSessionId = dependencies.resolveProviderSessionId(sessionId);
      const pids = providerSessionId ? providerName === 'claude' ? await dependencies.findClaudeCliProcessIds(providerSessionId) : (await findResumedProviderProcesses(providerSessionId, providerName)).map(row => row.pid) : [];
      const trees = await Promise.all(pids.map(pid => dependencies.listDescendants(pid)));
      let abortPromise: Promise<unknown>;
      try {
        // Call synchronously so the runtime records the cancellation before
        // the captured process tree is killed. This prevents a late callback from
        // recreating state while its CLI tree is being killed.
        abortPromise = Promise.resolve(runtime.abort(sessionId));
      } catch (error) {
        abortPromise = Promise.reject(error);
      }
      abortPromise = abortPromise.catch((error) => {
          console.error(`[ForceStop] abort failed for ${sessionId}:`, error?.message || error);
          return false;
        });

      const killedPids: number[] = [];
      {
        for (const [index, pid] of pids.entries()) {
          if (await dependencies.killProcessTree(pid, trees[index])) {
            killedPids.push(pid);
          }
        }
      }

      await abortPromise;
      console.log(`[ForceStop] ${providerName} session ${sessionId} stopped; killed pids: ${killedPids.join(',') || 'none'}`);
      return { killedPids };
    },

    async stopBackgroundTask(providerName: LLMProvider, sessionId: string, taskId: string): Promise<boolean> {
      const owned = supervision ? supervisedRuntimeState.entries.get(sessionId) : undefined;
      if (owned?.client) return Boolean(await owned.client.control({ type: 'stop-background', taskId }));
      // A runtime that never holds background work has no task to stop.
      const { runtime } = dependencies.resolveProvider(providerName);
      return Boolean(await runtime.stopBackgroundTask?.(sessionId, taskId));
    },

    hasBackgroundWork(sessionId: string): boolean {
      if (supervision && supervisedRuntimeState.entries.get(sessionId)?.background) return true;
      return dependencies.listProviders().some((provider) =>
        (provider.runtime.listBackgroundWork?.() ?? []).some((entry) => entry.sessionId === sessionId));
    },

    resolveToolApproval(requestId: string, decision: ProviderPermissionDecision): void {
      if (supervision) for (const owned of supervisedRuntimeState.entries.values()) {
        if (owned.client && owned.pending.some(row => row.requestId === requestId)) {
          void owned.client.control({ type: 'approval', requestId, decision }).catch(error => console.error('[Provider approval]', String(error)));
          return;
        }
      }
      for (const provider of dependencies.listProviders()) {
        provider.runtime.permissions?.resolve(requestId, decision);
      }
    },

    getPendingApprovalsForSession(sessionId: string): unknown[] {
      const owned = supervision ? supervisedRuntimeState.entries.get(sessionId) : undefined;
      if (owned) return owned.pending;
      return dependencies.listProviders().flatMap(
        (provider) => provider.runtime.permissions?.listPending(sessionId) ?? [],
      );
    },
  };
}

export const providerRuntimeService = createProviderRuntimeService({}, process.env.NEXAGENT_PROVIDER_WORKER !== '1');
