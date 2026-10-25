import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { getCurrentUserContext } from '@/modules/auth/index.js';
import type { LLMProvider, ProviderAuthStatus } from '@/shared/types.js';

export const providerAuthService = {
  /**
   * Resolves a provider and returns its installation/authentication status.
   */
  async getProviderAuthStatus(providerName: string): Promise<ProviderAuthStatus> {
    if (getCurrentUserContext()?.role === 'member' && !['claude', 'codex'].includes(providerName)) {
      return { provider: providerName as LLMProvider, installed: false, authenticated: false, email: null, method: null, error: 'Provider unavailable for this account' };
    }
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.auth.getStatus();
  },

  /**
   * Returns whether a provider runtime appears installed.
   * Falls back to true if status lookup itself fails so callers preserve the
   * original runtime error instead of replacing it with a status-check failure.
   */
  async isProviderInstalled(providerName: LLMProvider): Promise<boolean> {
    try {
      const status = await this.getProviderAuthStatus(providerName);
      return status.installed;
    } catch {
      return true;
    }
  },
};
