import {
  createOpenAiCompatibleProvider,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  type OpenAiCompatibleConfig,
  type OpenAiCompatibleDependencies,
} from './openaiCompatible';
import { ProviderError } from './errors';
import type { AiProvider } from './types';

export type ProviderConfig = OpenAiCompatibleConfig;

interface ProviderRegistration {
  readonly displayName: string;
  readonly create: (
    config: ProviderConfig,
    dependencies: OpenAiCompatibleDependencies,
  ) => AiProvider;
}

const REGISTRY: ReadonlyMap<string, ProviderRegistration> = new Map([
  [
    OPENAI_COMPATIBLE_PROVIDER_ID,
    {
      displayName: 'OpenAI-compatible',
      create: createOpenAiCompatibleProvider,
    },
  ],
]);

export function listProviderTypes(): string[] {
  return [...REGISTRY.keys()];
}

export function providerDisplayName(type: string): string | undefined {
  return REGISTRY.get(type)?.displayName;
}

/**
 * Single extension point for provider adapters. Adding a provider means adding
 * a registration here; the chat layer only depends on AiProvider.
 */
export function createProvider(
  type: string,
  config: ProviderConfig,
  dependencies: OpenAiCompatibleDependencies = {},
): AiProvider {
  const registration = REGISTRY.get(type);
  if (registration === undefined) {
    throw new ProviderError(
      'configuration',
      `Unsupported provider type "${type}". Available providers: ${listProviderTypes().join(', ')}.`,
    );
  }
  return registration.create(config, dependencies);
}
