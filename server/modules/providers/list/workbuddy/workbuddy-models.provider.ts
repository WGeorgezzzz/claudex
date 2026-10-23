import type { IProviderModels } from '@/shared/index.js';
import type { ProviderModelsDefinition } from '@/shared/index.js';
import { buildDefaultProviderCurrentActiveModel } from '@/shared/index.js';

/** WorkBuddy's documented model modes. Catalog membership does not imply account entitlement. */
export const WORKBUDDY_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'fast-model', label: 'WorkBuddy Fast', description: 'Local WorkBuddy login. Availability depends on your account.' },
    { value: 'balanced-model', label: 'WorkBuddy Balanced' },
    { value: 'primary-model', label: 'WorkBuddy Powerful' },
    { value: 'deep-model', label: 'WorkBuddy Deep' },
  ],
  DEFAULT: 'fast-model',
};

/** Provider registry exposes WorkBuddy modes without claiming unrestricted access to named upstream models. */
export class WorkBuddyProviderModels implements IProviderModels {
  async getSupportedModels() { return WORKBUDDY_PREDEFINED_MODELS; }
  async getCurrentActiveModel() { return buildDefaultProviderCurrentActiveModel(WORKBUDDY_PREDEFINED_MODELS); }
}
