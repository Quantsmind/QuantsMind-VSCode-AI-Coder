/**
 * Provider profiles — selectable configurations that reuse existing adapters.
 * No new adapter implementations are introduced here; profiles only carry
 * endpoint defaults, credential requirements, model-discovery info and
 * capability reporting.
 */

export type ProviderAdapterId = 'openai-compatible' | 'gemini';

export type CredentialRequirement = 'always' | 'never' | 'conditional';

export interface ProviderCapabilities {
  /** Chat completion via the adapter is supported. */
  readonly completion: boolean;
  /** SSE streaming completion is supported by the adapter AND advertised by the provider. */
  readonly streaming: boolean;
  /** Model listing endpoint is supported (path differs per adapter). */
  readonly modelDiscovery: boolean;
  /** Caller-provided cancellation token is honoured (abort support). */
  readonly cancellation: boolean;
  /**
   * Tool / function calling. The adapters in this codebase explicitly reject
   * tool-call responses (v1.0.0), so this is `false` for every profile.
   */
  readonly toolCalling: boolean;
  /** Provider-specific limitations that must be surfaced to the user/agent. */
  readonly limitations: readonly string[];
}

export interface ProviderProfile {
  /** Stable identifier stored in `quantsmind.provider.type`. */
  readonly id: string;
  readonly displayName: string;
  readonly adapter: ProviderAdapterId;
  /** Default base URL for the OpenAI-compatible adapters; undefined for Gemini (fixed host). */
  readonly defaultBaseUrl: string | undefined;
  /** Default model identifier; undefined means the user must enter one manually. */
  readonly defaultModel: string | undefined;
  /** Credential requirement for the profile (independent of loopback). */
  readonly credential: CredentialRequirement;
  /** Whether this profile is a self-hosted/local endpoint. */
  readonly local: boolean;
  readonly capabilities: ProviderCapabilities;
}

const baseOpenAiCapabilities: ProviderCapabilities = {
  completion: true,
  streaming: true,
  modelDiscovery: true,
  cancellation: true,
  toolCalling: false,
  limitations: [
    'Tool calling is not implemented by the adapter (tool-call responses are rejected).',
    'Streaming uses server-sent events; a server that returns JSON is handled as non-streaming.',
    'Endpoint must expose POST /chat/completions and GET /models.',
  ],
};

export const PROVIDER_PROFILES: readonly ProviderProfile[] = Object.freeze([
  Object.freeze({
    id: 'openai-compatible',
    displayName: 'OpenAI-compatible',
    adapter: 'openai-compatible' as const,
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    credential: 'conditional' as const,
    local: false,
    capabilities: baseOpenAiCapabilities,
  }),
  Object.freeze({
    id: 'openai',
    displayName: 'OpenAI',
    adapter: 'openai-compatible' as const,
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    credential: 'always' as const,
    local: false,
    capabilities: Object.freeze({
      ...baseOpenAiCapabilities,
      limitations: Object.freeze([
        'Model discovery requires a valid API key (401 otherwise).',
        'Tool calling is not implemented by the adapter.',
      ]),
    }),
  }),
  Object.freeze({
    id: 'groq',
    displayName: 'Groq',
    adapter: 'openai-compatible' as const,
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    credential: 'always' as const,
    local: false,
    capabilities: Object.freeze({
      ...baseOpenAiCapabilities,
      limitations: Object.freeze([
        'Model discovery requires a valid API key.',
        'Available model ids vary; use model discovery or enter an id manually.',
        'Tool calling is not implemented by the adapter despite server support.',
      ]),
    }),
  }),
  Object.freeze({
    id: 'openrouter',
    displayName: 'OpenRouter',
    adapter: 'openai-compatible' as const,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    credential: 'always' as const,
    local: false,
    capabilities: Object.freeze({
      ...baseOpenAiCapabilities,
      limitations: Object.freeze([
        'Model ids use the vendor/model format (e.g. openai/gpt-4o-mini).',
        'Discovery returns many models; filter by id in the UI.',
        'Tool calling is not implemented by the adapter.',
      ]),
    }),
  }),
  Object.freeze({
    id: 'ollama',
    displayName: 'Ollama (local)',
    adapter: 'openai-compatible' as const,
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1',
    credential: 'never' as const,
    local: true,
    capabilities: Object.freeze({
      ...baseOpenAiCapabilities,
      limitations: Object.freeze([
        'The selected model must be pulled and present on the Ollama server.',
        'Discovery lists locally pulled models via GET /v1/models (Ollama exposes /api/tags as well).',
        'Tool calling is not implemented by the adapter.',
      ]),
    }),
  }),
  Object.freeze({
    id: 'lm-studio',
    displayName: 'LM Studio (local)',
    adapter: 'openai-compatible' as const,
    defaultBaseUrl: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    credential: 'never' as const,
    local: true,
    capabilities: Object.freeze({
      ...baseOpenAiCapabilities,
      limitations: Object.freeze([
        'A model must be loaded in LM Studio before completions succeed.',
        'The default model id "local-model" is a placeholder; verify via model discovery.',
        'Tool calling is not implemented by the adapter.',
      ]),
    }),
  }),
  Object.freeze({
    id: 'llama-cpp',
    displayName: 'llama.cpp (local)',
    adapter: 'openai-compatible' as const,
    defaultBaseUrl: 'http://localhost:8080/v1',
    defaultModel: 'llama',
    credential: 'never' as const,
    local: true,
    capabilities: Object.freeze({
      ...baseOpenAiCapabilities,
      limitations: Object.freeze([
        'The server is started with a single pre-loaded model; the id may not be configurable.',
        'Discovery via GET /v1/models may be limited depending on server flags.',
        'Tool calling is not implemented by the adapter.',
      ]),
    }),
  }),
  Object.freeze({
    id: 'vllm',
    displayName: 'vLLM (self-hosted)',
    adapter: 'openai-compatible' as const,
    defaultBaseUrl: 'http://localhost:8000/v1',
    defaultModel: 'llama3',
    credential: 'never' as const,
    local: true,
    capabilities: Object.freeze({
      ...baseOpenAiCapabilities,
      limitations: Object.freeze([
        'The served model name must match --served-model-name on the server.',
        'If the server requires an API key, set one for this profile.',
        'Tool calling is not implemented by the adapter.',
      ]),
    }),
  }),
  Object.freeze({
    id: 'gemini',
    displayName: 'Google Gemini',
    adapter: 'gemini' as const,
    defaultBaseUrl: undefined,
    defaultModel: 'gemini-2.0-flash',
    credential: 'always' as const,
    local: false,
    capabilities: Object.freeze({
      completion: true,
      streaming: true,
      modelDiscovery: true,
      cancellation: true,
      toolCalling: false,
      limitations: Object.freeze([
        'Discovery uses the Gemini models endpoint (not /v1/models).',
        'Tool calling is not implemented by the adapter.',
        'The endpoint is fixed; base URL overrides are not used for Gemini.',
      ]),
    }),
  }),
] as const);

const PROFILE_MAP: ReadonlyMap<string, ProviderProfile> = new Map(
  PROVIDER_PROFILES.map((profile) => [profile.id, profile]),
);

export function listProviderProfiles(): readonly ProviderProfile[] {
  return PROVIDER_PROFILES;
}

export function listProviderProfileIds(): readonly string[] {
  return PROVIDER_PROFILES.map((profile) => profile.id);
}

export function getProviderProfile(type: string): ProviderProfile | undefined {
  return PROFILE_MAP.get(type.trim());
}

export function providerProfileExists(type: string): boolean {
  return PROFILE_MAP.has(type.trim());
}

export function providerAdapterForType(type: string): ProviderAdapterId | undefined {
  return getProviderProfile(type)?.adapter;
}

export function providerBaseUrlDefault(type: string): string | undefined {
  return getProviderProfile(type)?.defaultBaseUrl;
}

export function providerModelDefault(type: string): string | undefined {
  return getProviderProfile(type)?.defaultModel;
}

export function isLocalProviderProfile(type: string): boolean {
  return getProviderProfile(type)?.local === true;
}

/**
 * Determines whether a credential is required for the profile.
 * Local profiles never require one; cloud/Gemini always do; the generic
 * OpenAI-compatible profile is conditional on the resolved loopback state.
 */
export function credentialRequiredForProfile(
  type: string,
  loopback: boolean,
): boolean {
  const profile = getProviderProfile(type);
  if (profile === undefined) {
    return !loopback;
  }
  if (profile.credential === 'always') {
    return true;
  }
  if (profile.credential === 'never') {
    return false;
  }
  return !loopback;
}

/** Typed capability report for a profile (no capabilities are assumed). */
export interface ProviderCapabilityReport {
  readonly profileId: string;
  readonly displayName: string;
  readonly adapter: ProviderAdapterId;
  readonly capabilities: ProviderCapabilities;
  readonly defaultBaseUrl: string | undefined;
  readonly defaultModel: string | undefined;
  readonly local: boolean;
}

export function getProviderCapabilities(type: string): ProviderCapabilities | undefined {
  return getProviderProfile(type)?.capabilities;
}

export function getProviderCapabilityReport(type: string): ProviderCapabilityReport | undefined {
  const profile = getProviderProfile(type);
  if (profile === undefined) {
    return undefined;
  }
  return {
    profileId: profile.id,
    displayName: profile.displayName,
    adapter: profile.adapter,
    capabilities: profile.capabilities,
    defaultBaseUrl: profile.defaultBaseUrl,
    defaultModel: profile.defaultModel,
    local: profile.local,
  };
}
