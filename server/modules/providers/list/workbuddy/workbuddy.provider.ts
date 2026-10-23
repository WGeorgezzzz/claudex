import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { WorkBuddyProviderAuth } from '@/modules/providers/list/workbuddy/workbuddy-auth.provider.js';
import { WorkBuddyProviderModels } from '@/modules/providers/list/workbuddy/workbuddy-models.provider.js';
import { WorkBuddySessionsProvider } from '@/modules/providers/list/workbuddy/workbuddy-sessions.provider.js';
import { workBuddyRuntime } from '@/modules/providers/list/workbuddy/workbuddy-runtime.provider.js';
import { WorkBuddyMcpProvider } from '@/modules/providers/list/workbuddy/workbuddy-mcp.provider.js';
import { WorkBuddySkillsProvider } from '@/modules/providers/list/workbuddy/workbuddy-skills.provider.js';

/** Registry-owned local WorkBuddy integration. Native desktop sessions are never imported or modified. */
export class WorkBuddyProvider extends AbstractProvider {
  readonly auth = new WorkBuddyProviderAuth();
  readonly models = new WorkBuddyProviderModels();
  readonly sessions = new WorkBuddySessionsProvider();
  readonly runtime = workBuddyRuntime;
  readonly sessionSynchronizer = { synchronize: async () => 0, synchronizeFile: async () => null };
  readonly skills = new WorkBuddySkillsProvider();
  readonly mcp = new WorkBuddyMcpProvider();
  constructor() { super('workbuddy'); }
}
