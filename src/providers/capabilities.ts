import { getProviderCapabilities } from './profiles';
import type { ResolvedProviderSettings } from '../config/resolve';

export interface ProviderCapabilities {
  readonly nativeToolCalling: boolean;
  readonly structuredOutput: boolean;
  readonly streaming: boolean;
  readonly maxContextChars: number;
}

/**
 * Model families whose vendor documentation specifies native tool/function
 * calling. This is a static declaration, not a live probe: an unrecognised id
 * is treated as unsupported so the agent falls back to the JSON tool-call
 * protocol, which every chat model can follow. Placeholder ids such as
 * "local-model" and bare "llama"/"llama3" stay unsupported because the extension
 * cannot know which model a self-hosted server actually loaded.
 */
const TOOL_CAPABLE_MODEL_PREFIXES: readonly string[] = [
  'gpt-4o',
  'gpt-4.1',
  'gpt-4-turbo',
  'gpt-3.5-turbo',
  'gpt-5',
  'chatgpt-4o',
  'o3',
  'o4-mini',
  'llama-3.1',
  'llama-3.2',
  'llama-3.3',
  'llama-4',
  'llama3.1',
  'llama3.2',
  'llama3.3',
  'llama4',
  'qwen2.5',
  'qwen3',
  'mistral-large',
  'mistral-small',
  'mistral-nemo',
  'command-r',
];

const NON_TOOL_MODEL_MARKERS: readonly string[] = [
  'embedding',
  'whisper',
  'tts',
  'dall-e',
  'moderation',
  'davinci',
  'babbage',
  'o1-preview',
  'o1-mini',
];

function normalizeModelId(model: string): string {
  const trimmed = model.trim().toLowerCase();
  const withoutPrefix = trimmed.replace(/^models\//, '');
  // OpenRouter and Hugging Face ids are vendor-prefixed; Ollama ids carry a tag.
  const withoutVendor = withoutPrefix.slice(withoutPrefix.lastIndexOf('/') + 1);
  return withoutVendor.split(':')[0];
}

export function isToolCapableModelId(model: string): boolean {
  const normalized = normalizeModelId(model);
  if (normalized.length === 0 || normalized === 'gpt-3.5-turbo-instruct') {
    return false;
  }
  if (NON_TOOL_MODEL_MARKERS.some((marker) => normalized.includes(marker))) {
    return false;
  }
  return TOOL_CAPABLE_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Native tool calling requires both an adapter that implements it and a model
 * that documents it. Profile capability alone is not sufficient.
 */
export function modelSupportsNativeToolCalling(type: string, model: string): boolean {
  return getProviderCapabilities(type)?.toolCalling === true && isToolCapableModelId(model);
}

/**
 * "Structured output" means the prompt requests JSON and the local parser
 * validates it, so it is available for every provider. Native tool calling is
 * only advertised when the selected profile AND model support it (for example
 * Gemini does not, and neither does an unrecognised local model id).
 */
export function describeCapabilities(
  settings: ResolvedProviderSettings,
  maxContextChars = 40_000,
): ProviderCapabilities {
  return {
    nativeToolCalling: modelSupportsNativeToolCalling(settings.type, settings.model),
    structuredOutput: true,
    streaming: settings.stream,
    maxContextChars: Math.max(2_000, Math.min(maxContextChars, 400_000)),
  };
}
