import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { IProviderModels, ProviderModelsDefinition } from '@/shared/index.js';
import { buildDefaultProviderCurrentActiveModel, readObjectRecord } from '@/shared/index.js';
import { resolveWorkBuddyInstallation } from '@/modules/providers/list/workbuddy/workbuddy-auth.provider.js';

/** Provider catalog and its tests use explicit zero-credit prices, never account tier or promotional wording. */
export function buildWorkBuddyFreeModels(product: unknown, now = Date.now()): ProviderModelsDefinition {
  const catalog = readObjectRecord(product);
  const models = catalog?.models;
  const promotions = Array.isArray(catalog?.modelPromotions) ? catalog.modelPromotions : [];
  const options: ProviderModelsDefinition['OPTIONS'] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(models) ? models : []) {
    const model = readObjectRecord(value);
    if (!model || typeof model.id !== 'string' || !model.id.trim() || seen.has(model.id)
      || model.disabled === true || model.enabled === false || model.supportsToolCall !== true) continue;
    const freePromotions = promotions.filter((value: unknown) => {
      const promotion = readObjectRecord(value);
      return Array.isArray(promotion?.modelIds) && promotion.modelIds.includes(model.id)
        && readObjectRecord(promotion.discount)?.factor === 0;
    });
    const activePromotion = freePromotions.find((promotion: Record<string, unknown>) => {
      const schedule = readObjectRecord(promotion.schedule);
      const start = typeof schedule?.validFrom === 'string' ? Date.parse(schedule.validFrom) : NaN;
      const end = typeof schedule?.validUntil === 'string' ? Date.parse(schedule.validUntil) : NaN;
      return promotion.enabled === true && Number.isFinite(start) && Number.isFinite(end) && now >= start && now < end;
    });
    const explicitlyFree = typeof model.credits === 'string' && /^x0(?:\.0+)?(?:\s+credits)?$/i.test(model.credits.trim());
    // A cached zero-credit price must not outlive the promotion that made it free.
    if (freePromotions.length ? !activePromotion : !explicitlyFree) continue;
    seen.add(model.id);
    const reasoning = readObjectRecord(model.reasoning);
    const levels = Array.isArray(reasoning?.supportedEfforts) ? reasoning.supportedEfforts.filter((v: unknown): v is string =>
      typeof v === 'string' && ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(v)) : [];
    options.push({
      value: model.id,
      label: `${typeof model.name === 'string' ? model.name : model.id} · 免费`,
      ...(levels.length ? { effort: { values: levels.map((value: string) => ({ value })),
        default: levels.includes(reasoning?.defaultEffort) ? reasoning!.defaultEffort : levels[0] } } : {}),
      description: activePromotion
        ? `WorkBuddy 限时 0 积分，截止 ${new Date(activePromotion.schedule.validUntil).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）。`
        : 'WorkBuddy 客户端目录标价 0 积分；使用本机登录。',
    });
  }
  const preferred = options.findIndex(model => model.value === 'deepseek-v4.1-flash');
  if (preferred > 0) options.unshift(...options.splice(preferred, 1));
  return { OPTIONS: options, DEFAULT: options[0]?.value || '' };
}

/** Registry and runtime read the desktop-synchronized catalog, including remote additions and promotion expiry. */
export class WorkBuddyProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const install = resolveWorkBuddyInstallation();
    if (!install) return { OPTIONS: [], DEFAULT: '' };
    try {
      const product = JSON.parse(await readFile(path.join(install.directory, 'resources/app.asar.unpacked/cli/product.json'), 'utf8'));
      const directory = product.config?.customUserDataDir;
      if (typeof directory !== 'string' || !/^\.workbuddy(?:-ai)?$/.test(directory)) return { OPTIONS: [], DEFAULT: '' };
      const current = JSON.parse(await readFile(path.join(os.homedir(), directory, 'cache/acc-product-config-v3.json'), 'utf8'));
      if (current.endpoint !== product.endpoint || current.authentication?.id !== product.authentication?.id) return { OPTIONS: [], DEFAULT: '' };
      return buildWorkBuddyFreeModels(current);
    } catch {
      return { OPTIONS: [], DEFAULT: '' };
    }
  }

  async getCurrentActiveModel() {
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
