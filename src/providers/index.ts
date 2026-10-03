import { anthropicProvider } from './anthropic';
import { copilotProvider } from './copilot';
import { geminiProvider } from './gemini';
import { openaiProvider } from './openai';
import { Provider, ProviderId } from './types';

export * from './types';

export const PROVIDERS: Record<ProviderId, Provider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
  copilot: copilotProvider,
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && value in PROVIDERS;
}
