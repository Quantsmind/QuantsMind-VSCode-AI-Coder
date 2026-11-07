import type { ResolvedProviderSettings } from '../config/resolve';

export interface ProviderCapabilities {
  readonly nativeToolCalling: boolean;
  readonly structuredOutput: boolean;
  readonly streaming: boolean;
  readonly maxContextChars: number;
}

/**
 * v0.3.0 never exposes executable tool definitions. "Structured output" means
 * the prompt requests JSON and the local parser validates it, so it is
 * available for every OpenAI-compatible provider.
 */
export function describeCapabilities(
  settings: ResolvedProviderSettings,
  maxContextChars = 40_000,
): ProviderCapabilities {
  return {
    nativeToolCalling: true,
    structuredOutput: true,
    streaming: settings.stream,
    maxContextChars: Math.max(2_000, Math.min(maxContextChars, 400_000)),
  };
}
