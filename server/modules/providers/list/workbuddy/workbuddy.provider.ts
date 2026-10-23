import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { WorkBuddyProviderAuth } from '@/modules/providers/list/workbuddy/workbuddy-auth.provider.js';
import { WorkBuddyProviderModels } from '@/modules/providers/list/workbuddy/workbuddy-models.provider.js';
import { WorkBuddySessionsProvider } from '@/modules/providers/list/workbuddy/workbuddy-sessions.provider.js';
import { workBuddyRuntime } from '@/modules/providers/list/workbuddy/workbuddy-runtime.provider.js';
import type { IProviderMcp, IProviderSkills } from '@/shared/index.js';

const unavailable = async (): Promise<never> => { throw new Error('Manage WorkBuddy tools and skills in the WorkBuddy desktop client. This integration currently supports conversations only.'); };

/** Registry-owned local WorkBuddy integration. Native desktop sessions are never imported or modified. */
export class WorkBuddyProvider extends AbstractProvider {
  readonly auth = new WorkBuddyProviderAuth();
  readonly models = new WorkBuddyProviderModels();
  readonly sessions = new WorkBuddySessionsProvider();
  readonly runtime = workBuddyRuntime;
  readonly sessionSynchronizer = { synchronize: async () => 0, synchronizeFile: async () => null };
  readonly skills: IProviderSkills = { listSkills: async () => [], addSkills: unavailable, removeSkill: unavailable };
  readonly mcp: IProviderMcp = {
    listServers: async () => ({ user: [], project: [], local: [] }), listServersForScope: async () => [],
    upsertServer: unavailable, removeServer: unavailable,
  };
  constructor() { super('workbuddy'); }
}
