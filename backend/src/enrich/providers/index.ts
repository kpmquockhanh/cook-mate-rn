import { env } from '../../env.js';
import { anthropicProvider } from './anthropic.js';
import { deepseekProvider } from './deepseek.js';
import type { EnrichProvider } from './types.js';

export const PROVIDERS = {
  anthropic: anthropicProvider,
  deepseek: deepseekProvider,
} as const satisfies Record<string, EnrichProvider>;

export type ProviderName = keyof typeof PROVIDERS;

export function isProviderName(value: string): value is ProviderName {
  return value in PROVIDERS;
}

/** Resolved per call, so a test can flip ENRICH_PROVIDER without a fresh process. */
export function activeProvider(): EnrichProvider {
  return PROVIDERS[env.enrichProvider];
}

export type { EnrichProvider, ProviderRequest, ProviderResponse } from './types.js';
