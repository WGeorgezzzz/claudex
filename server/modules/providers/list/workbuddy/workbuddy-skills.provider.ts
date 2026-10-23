import path from 'node:path';
import os from 'node:os';
import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import { resolveWorkBuddyInstallation } from '@/modules/providers/list/workbuddy/workbuddy-auth.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

/** WorkBuddy's settings tab manages the same user skills the native CLI loads. */
export class WorkBuddySkillsProvider extends SkillsProvider {
  constructor() { super('workbuddy'); }
  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    if (!resolveWorkBuddyInstallation()) return [];
    return [await this.getGlobalSkillSource(), { scope: 'project', rootDir: path.join(workspacePath, '.workbuddy-ai', 'skills'), commandPrefix: '/' }];
  }
  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    if (!resolveWorkBuddyInstallation()) throw new Error('WorkBuddy local account is unavailable for this user.');
    return { scope: 'user', rootDir: path.join(os.homedir(), '.workbuddy-ai', 'skills'), commandPrefix: '/' };
  }
}
