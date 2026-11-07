import {
  createOpenAiCompatibleProvider,
  type OpenAiCompatibleConfig,
  type OpenAiCompatibleDependencies,
} from './openaiCompatible';
import { createGeminiProvider } from './geminiCompatible';
import { ProviderError } from './errors';
import type { AiProvider } from './types';
import { getProviderProfile, listProviderProfiles } from './profiles';

export type ProviderConfig = OpenAiCompatibleConfig;

interface ProviderRegistration {
  readonly displayName: string;
  readonly create: (
    config: ProviderConfig,
    dependencies: OpenAiCompatibleDependencies,
  ) => AiProvider;
}

function openAiCreate(
  config: ProviderConfig,
  dependencies: OpenAiCompatibleDependencies,
): AiProvider {
  return createOpenAiCompatibleProvider(config, dependencies);
}

function geminiCreate(
  config: ProviderConfig,
  dependencies: OpenAiCompatibleDependencies,
): AiProvider {
  return createGeminiProvider(
    {
      apiKey: config.apiKey,
      model: config.model,
      timeoutMs: config.timeoutMs,
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
      stream: config.stream,
    },
    dependencies,
  );
}

function buildRegistry(): ReadonlyMap<string, ProviderRegistration> {
  const registry = new Map<string, ProviderRegistration>();
  for (const profile of listProviderProfiles()) {
    registry.set(profile.id, {
      displayName: profile.displayName,
      create: profile.adapter === 'gemini' ? geminiCreate : openAiCreate,
    });
  }
  return registry;
}

const REGISTRY: ReadonlyMap<string, ProviderRegistration> = buildRegistry();

/**
 * All selectable provider profiles (the value stored in
 * `quantsmind.provider.type`). Adapters are shared; profiles supply endpoint
 * defaults, credential requirements and capability reporting.
 */
export function listProviderTypes(): string[] {
  return [...REGISTRY.keys()];
}

export function providerDisplayName(type: string): string | undefined {
  const direct = REGISTRY.get(type)?.displayName;
  if (direct !== undefined) {
    return direct;
  }
  return getProviderProfile(type)?.displayName;
}

export function providerAdapterId(type: string): string | undefined {
  if (!REGISTRY.has(type) && getProviderProfile(type) === undefined) {
    return undefined;
  }
  return getProviderProfile(type)?.adapter;
}

/**
 * Single extension point for provider adapters. Adding a profile means
 * adding a registration in `profiles.ts`; the chat layer only depends on
 * AiProvider.
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
