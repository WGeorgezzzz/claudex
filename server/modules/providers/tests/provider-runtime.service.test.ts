import assert from 'node:assert/strict';
import test from 'node:test';
import { installAuthorizationFixture, testUserId } from '@/test-support/authorization-fixture.js';
import { userPreferencesDb } from '@/modules/database/index.js';
import { getCurrentUserContext, withUserContext } from '@/modules/auth/index.js';

installAuthorizationFixture();

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { createProviderRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import type { IProvider, IProviderRuntime } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';

function createRuntime(overrides: Partial<IProviderRuntime> = {}): IProviderRuntime {
  return {
    async run() {
      return undefined;
    },
    abort() {
      return false;
    },
    ...overrides,
  };
}

function createProvider(id: LLMProvider, runtime: IProviderRuntime): IProvider {
  return {
    id,
    runtime,
    auth: {
      async getStatus() {
        return {
          provider: id,
          installed: true,
          authenticated: true,
          method: 'test',
          details: {},
        };
      },
    },
    sessions: {
      normalizeMessage(raw: unknown, sessionId: string | null) {
        return [{ kind: 'assistant', content: String(raw), sessionId, provider: id }];
      },
      async fetchHistory() {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      },
    },
  } as unknown as IProvider;
}

function createService(providers: IProvider[]) {
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  return createProviderRuntimeService({
    listProviders: () => providers,
    resolveProvider(providerName) {
      const provider = providerMap.get(providerName as LLMProvider);
      if (!provider) {
        throw new Error(`Missing provider: ${providerName}`);
      }
      return provider;
    },
    resolveProviderSessionId: (sessionId) => sessionId ? `native-${sessionId}` : null,
    async resolveResumeModel(_provider, _sessionId, requestedModel) {
      return requestedModel?.trim() || undefined;
    },
    async getProviderModels() {
      return {
        OPTIONS: [],
        DEFAULT: 'default-model',
      };
    },
  });
}

test('providerRegistry owns one runtime for every registered provider', () => {
  const providers = providerRegistry.listProviders();

  assert.deepEqual(providers.map((provider) => provider.id), [
    'claude',
    'codex',
    'cursor',
    'opencode',
    'workbuddy',
  ]);
  assert.equal(providers.every((provider) => typeof provider.runtime.run === 'function'), true);
  assert.equal(providers.every((provider) => typeof provider.runtime.abort === 'function'), true);
});

test('TaskMaster Codex sessions use their relay home while ordinary sessions keep the account home', async () => {
  const userId = testUserId(), seen: string[] = [];
  const runtime = createRuntime({ async run() { seen.push(getCurrentUserContext()!.env.CODEX_HOME!); } });
  const service = createService([createProvider('codex', runtime)]), writer = { userId, send() {} };
  const original = process.env.TASKMASTER_CODEX_HOME;
  process.env.TASKMASTER_CODEX_HOME = 'D:/test-taskmaster-relay';
  try {
    withUserContext(userId, () => userPreferencesDb.savePreferences(userId, { 'taskmasterCodexSession:relay-task-session': true }));
    await service.getRunner('codex')('task', { sessionId: 'relay-task-session' }, writer);
    await service.getRunner('codex')('ordinary', { sessionId: 'ordinary-session' }, writer);
    assert.equal(seen[0], 'D:/test-taskmaster-relay'); assert.notEqual(seen[1], seen[0]);
  } finally { if (original === undefined) delete process.env.TASKMASTER_CODEX_HOME; else process.env.TASKMASTER_CODEX_HOME = original; }
});

test('dispatches runs and aborts through the runtime owned by providerRegistry', async () => {
  const calls: unknown[][] = [];
  const runtime = createRuntime({
    async run(command, options, writer, context) {
      calls.push(['run', command, options, writer]);
      assert.equal(context.resolveProviderSessionId('session-1'), 'native-session-1');
      assert.equal(await context.resolveResumeModel('session-1', 'sonnet'), 'sonnet');
      assert.deepEqual(await context.getProviderModels(), { OPTIONS: [], DEFAULT: 'default-model' });
      assert.equal(context.normalizeMessage('hello', 'session-1')[0]?.provider, 'claude');
      assert.equal(await context.isProviderInstalled(), true);
      return 'complete';
    },
    async abort(sessionId) {
      calls.push(['abort', sessionId]);
      return true;
    },
  });
  const service = createService([createProvider('claude', runtime)]);
  const writer = { send() {} };

  assert.equal(service.hasRuntime('claude'), true);
  assert.equal(service.hasRuntime('unknown'), false);
  assert.equal(await service.getRunner('claude')('hello', { model: 'sonnet' }, writer), 'complete');
  assert.equal(await service.abort('claude', 'session-1'), true);
  assert.deepEqual(calls, [
    ['run', 'hello', { model: 'sonnet' }, writer],
    ['abort', 'session-1'],
  ]);
});

test('routes permission decisions through provider-owned runtime capabilities', () => {
  const decisions: unknown[][] = [];
  const claudeRuntime = createRuntime({
    permissions: {
      resolve(requestId, decision) {
        decisions.push([requestId, decision]);
      },
      listPending(sessionId) {
        return [{ requestId: 'request-1', sessionId }];
      },
    },
  });
  const service = createService([
    createProvider('claude', claudeRuntime),
    createProvider('cursor', createRuntime()),
  ]);
  const decision = { allow: true, message: 'approved' };

  service.resolveToolApproval('request-1', decision);

  assert.deepEqual(decisions, [['request-1', decision]]);
  assert.deepEqual(service.getPendingApprovalsForSession('session-1'), [
    { requestId: 'request-1', sessionId: 'session-1' },
  ]);
});

test('queued Claude allow/deny lists reach the SDK settings without enabling bypass', async () => {
  let actual: Record<string, unknown> | undefined;
  const service=createService([createProvider('claude',createRuntime({async run(_command,options){actual=options;}}))]);
  await service.run('claude','inspect',{allowedTools:['mcp__claudex_sessions__session'],disallowedTools:['Bash'],permissionMode:'default'},{send(){}});
  assert.deepEqual(actual?.toolsSettings,{allowedTools:['mcp__claudex_sessions__session'],disallowedTools:['Bash'],skipPermissions:false});
  assert.equal(actual?.permissionMode,'default');
});

test('only authenticated Claude sessions receive the monitor query factory', async () => {
  const seen: boolean[]=[];
  const runtime=createRuntime({async run(_command,_options,_writer,context){seen.push(typeof context.createQuery==='function');}});
  const service=createService([createProvider('claude',runtime),createProvider('codex',runtime)]);
  await service.run('claude','hello',{sessionId:'a'},{send(){},userId:1});
  await service.run('claude','hello',{sessionId:'a'},{send(){}});
  await service.run('codex','hello',{sessionId:'a'},{send(){},userId:1});
  assert.deepEqual(seen,[true,false,false]);
});
