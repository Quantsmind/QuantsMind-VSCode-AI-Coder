import {
  DEFAULT_ALLOW_INSECURE_LOCALHOST,
  DEFAULT_BASE_URL,
  DEFAULT_EXCLUDE_GLOBS,
  DEFAULT_MAX_FILE_SIZE_KB,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_TOTAL_CHARS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_TYPE,
  DEFAULT_STREAM,
  DEFAULT_TEMPERATURE,
  DEFAULT_TIMEOUT_MS,
  LIMITS,
} from './defaults';

export interface RawProviderSettings {
  readonly type?: unknown;
  readonly baseUrl?: unknown;
  readonly model?: unknown;
  readonly timeoutMs?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly temperature?: unknown;
  readonly stream?: unknown;
  readonly allowInsecureLocalhost?: unknown;
}

export interface ResolvedProviderSettings {
  readonly type: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly temperature: number;
  readonly stream: boolean;
  readonly allowInsecureLocalhost: boolean;
}

export interface RawContextSettings {
  readonly excludeGlobs?: unknown;
  readonly maxFileSizeKb?: unknown;
  readonly maxTotalChars?: unknown;
  readonly maxFiles?: unknown;
}

export interface ResolvedContextSettings {
  readonly excludeGlobs: readonly string[];
  readonly maxFileSizeBytes: number;
  readonly maxTotalChars: number;
  readonly maxFiles: number;
}

function stringValue(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  return trimmed.slice(0, maxLength);
}

function numberValue(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  integer: boolean,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, value));
  return integer ? Math.round(clamped) : clamped;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function globList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const patterns: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const pattern = entry.trim();
    if (pattern.length === 0 || pattern.length > 300) {
      continue;
    }
    const key = pattern.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    patterns.push(pattern);
    if (patterns.length >= LIMITS.maxExcludePatterns) {
      break;
    }
  }
  return patterns;
}

export function resolveProviderSettings(raw: RawProviderSettings): ResolvedProviderSettings {
  return {
    type: stringValue(raw.type, DEFAULT_PROVIDER_TYPE, 100),
    baseUrl: stringValue(raw.baseUrl, DEFAULT_BASE_URL, 4096),
    model: stringValue(raw.model, DEFAULT_MODEL, 200),
    timeoutMs: numberValue(
      raw.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      LIMITS.timeoutMs.min,
      LIMITS.timeoutMs.max,
      true,
    ),
    maxOutputTokens: numberValue(
      raw.maxOutputTokens,
      DEFAULT_MAX_OUTPUT_TOKENS,
      LIMITS.maxOutputTokens.min,
      LIMITS.maxOutputTokens.max,
      true,
    ),
    temperature: numberValue(
      raw.temperature,
      DEFAULT_TEMPERATURE,
      LIMITS.temperature.min,
      LIMITS.temperature.max,
      false,
    ),
    stream: booleanValue(raw.stream, DEFAULT_STREAM),
    allowInsecureLocalhost: booleanValue(
      raw.allowInsecureLocalhost,
      DEFAULT_ALLOW_INSECURE_LOCALHOST,
    ),
  };
}

export function resolveContextSettings(raw: RawContextSettings): ResolvedContextSettings {
  const maxFileSizeKb = numberValue(
    raw.maxFileSizeKb,
    DEFAULT_MAX_FILE_SIZE_KB,
    LIMITS.maxFileSizeKb.min,
    LIMITS.maxFileSizeKb.max,
    true,
  );

  return {
    excludeGlobs: [...DEFAULT_EXCLUDE_GLOBS, ...globList(raw.excludeGlobs)],
    maxFileSizeBytes: maxFileSizeKb * 1024,
    maxTotalChars: numberValue(
      raw.maxTotalChars,
      DEFAULT_MAX_TOTAL_CHARS,
      LIMITS.maxTotalChars.min,
      LIMITS.maxTotalChars.max,
      true,
    ),
    maxFiles: numberValue(
      raw.maxFiles,
      DEFAULT_MAX_FILES,
      LIMITS.maxFiles.min,
      LIMITS.maxFiles.max,
      true,
    ),
  };
}
