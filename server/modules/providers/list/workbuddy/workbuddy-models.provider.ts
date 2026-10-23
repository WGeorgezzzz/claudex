import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { IProviderModels, ProviderModelsDefinition } from '@/shared/index.js';
import { buildDefaultProviderCurrentActiveModel, readObjectRecord } from '@/shared/index.js';
import { resolveWorkBuddyInstallation } from '@/modules/providers/list/workbuddy/workbuddy-auth.provider.js';

/** Provider catalog and its tests use explicit zero-credit prices, never account tier or promotional wording. */
export function buildWorkBuddyFreeModels(product: unknown): ProviderModelsDefinition {
  const models = readObjectRecord(product)?.models;
  const options: ProviderModelsDefinition['OPTIONS'] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(models) ? models : []) {
    const model = readObjectRecord(value);
    if (!model || typeof model.id !== 'string' || !model.id.trim() || seen.has(model.id)
      || model.disabled === true || model.enabled === false || model.supportsToolCall !== true
      || typeof model.credits !== 'string' || !/^x0(?:\.0+)?(?:\s+credits)?$/i.test(model.credits.trim())) continue;
    seen.add(model.id);
    options.push({
      value: model.id,
      label: `${typeof model.name === 'string' ? model.name : model.id} · 免费`,
      description: 'WorkBuddy 客户端目录标价 0 积分；使用本机登录。',
    });
  }
  const preferred = options.findIndex(model => model.value === 'deepseek-v4.1-flash');
  if (preferred > 0) options.unshift(...options.splice(preferred, 1));
  return { OPTIONS: options, DEFAULT: options[0]?.value || '' };
}

/** Registry and runtime reread the installed official catalog so paid or unknown models never become fallbacks. */
export class WorkBuddyProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const install = resolveWorkBuddyInstallation();
    if (!install) return { OPTIONS: [], DEFAULT: '' };
    try {
      const product = JSON.parse(await readFile(path.join(install.directory, 'resources/app.asar.unpacked/cli/product.json'), 'utf8'));
      return buildWorkBuddyFreeModels(product);
    } catch {
      return { OPTIONS: [], DEFAULT: '' };
    }
  }

  async getCurrentActiveModel() {
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
