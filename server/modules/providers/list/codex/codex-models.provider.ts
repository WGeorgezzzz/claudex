import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import { getCurrentUserContext } from '@/modules/auth/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

/** Curated Codex catalog shipped as immutable AgentHub defaults. */
export const CODEX_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      description: 'Our most capable model for complex, demanding work.',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-6-sol',
      label: 'GPT-6 Sol',
      description: 'Workhorse model for coding and everyday work.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-6-luna',
      label: 'GPT-6 Luna',
      description: 'Fast and affordable model for easier tasks.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      description: 'Latest frontier agentic coding model.',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      description: 'Balanced agentic coding model for everyday work.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      description: 'Fast and affordable agentic coding model.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'gpt-5.5',
      label: 'GPT-5.5',
      description: 'Frontier model for complex coding, research, and real-world work.',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4',
      label: 'GPT-5.4',
      description: 'Strong model for everyday coding.',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4-mini',
      label: 'GPT-5.4 Mini',
      description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
  ],
  DEFAULT: 'gpt-5.6-sol',
};

const getCodexConfigPath = () => path.join(getCurrentUserContext()?.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml');

/** Provider registry model adapter for Codex predefined models and active config. */
export class CodexProviderModels implements IProviderModels {
  constructor(private readonly configHomeOverride?: string) {}

  /** Per-user CODEX_HOME when a member is active; tests may pin a folder. */
  private get configHome(): string {
    return this.configHomeOverride ?? path.dirname(getCodexConfigPath());
  }

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const config = readObjectRecord(TOML.parse(await readFile(path.join(this.configHome, 'config.toml'), 'utf8')));
    const selectedProvider = readOptionalString(config?.model_provider);
    const providers = readObjectRecord(config?.model_providers);
    const connection = readObjectRecord(providers?.[selectedProvider ?? '']);
    const baseUrl = readOptionalString(connection?.base_url);
    let rows: unknown[];
    if (baseUrl) {
      const envKey = readOptionalString(connection?.env_key);
      const auth = JSON.parse(await readFile(path.join(this.configHome, 'auth.json'), 'utf8').catch(() => '{}'));
      const key = envKey ? process.env[envKey] : auth.OPENAI_API_KEY;
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Connected Codex provider model list failed (${response.status}).`);
      const body = await response.json() as { data?: unknown[] };
      rows = body.data ?? [];
    } else {
      // Codex itself refreshes this account-scoped catalog; never mix it with
      // a different gateway's models or a source-controlled release list.
      const cache = JSON.parse(await readFile(path.join(this.configHome, 'models_cache.json'), 'utf8'));
      rows = Array.isArray(cache.models) ? cache.models : [];
    }
    const options: ProviderModelOption[] = rows.flatMap((raw) => {
      const row = readObjectRecord(raw);
      const value = readOptionalString(row?.slug) || readOptionalString(row?.id);
      if (!row || !value || row.visibility === 'hide') return [];
      const efforts = Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels : [];
      const values = efforts.flatMap((entry) => {
        const value = readOptionalString(readObjectRecord(entry)?.effort);
        return value ? [{ value }] : [];
      });
      return [{ value, label: value, description: readOptionalString(row.description) ?? undefined,
        ...(values.length ? { effort: { values } } : {}) }];
    });
    if (!options.length) throw new Error('The connected Codex provider returned no models.');
    const configured = readOptionalString(config?.model);
    return { OPTIONS: options, DEFAULT: options.find(m => m.value === configured)?.value ?? options[0].value };
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    try {
      const raw = await readFile(getCodexConfigPath(), 'utf8');
      const parsed = readObjectRecord(TOML.parse(raw));
      const model = readOptionalString(parsed?.model);
      if (!model) {
        return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
      }

      return {
        model,
      };
    } catch {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }
  }
}
