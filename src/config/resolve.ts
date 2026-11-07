import {
  getProviderProfile,
} from '../providers/profiles';
import {
  DEFAULT_AGENT_MAX_REPAIR_ITERATIONS,
  DEFAULT_AGENT_MAX_STEPS,
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_ALLOW_INSECURE_LOCALHOST,
  DEFAULT_BASE_URL,
  DEFAULT_COMMAND_ALLOWLIST,
  DEFAULT_COMMAND_OUTPUT_MAX_CHARS,
  DEFAULT_COMMAND_TIMEOUT_MS,
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
  DEFAULT_WORKSPACE_MAX_INDEXED_FILES,
  DEFAULT_WORKSPACE_MAX_RETRIEVED_FILES,
  DEFAULT_WORKSPACE_RETRIEVAL_MAX_CHARS,
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
  const type = stringValue(raw.type, DEFAULT_PROVIDER_TYPE, 100);
  const profile = getProviderProfile(type);

  // Profile defaults apply only when the raw value is absent or still the
  // global default (which is what VS Code returns when the user has not
  // overridden the setting). An explicit non-default URL/model is always
  // honoured so users can override endpoints.
  const rawBaseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';
  const rawModel = typeof raw.model === 'string' ? raw.model.trim() : '';
  const profileBaseUrl =
    profile?.defaultBaseUrl !== undefined &&
    (rawBaseUrl.length === 0 || rawBaseUrl === DEFAULT_BASE_URL)
      ? profile.defaultBaseUrl
      : undefined;
  const profileModel =
    profile?.defaultModel !== undefined &&
    (rawModel.length === 0 || rawModel === DEFAULT_MODEL)
      ? profile.defaultModel
      : undefined;

  return {
    type,
    baseUrl: profileBaseUrl ?? stringValue(raw.baseUrl, DEFAULT_BASE_URL, 4096),
    model: profileModel ?? stringValue(raw.model, DEFAULT_MODEL, 200),
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

export interface RawWorkspaceSettings {
  readonly maxIndexedFiles?: unknown;
  readonly maxRetrievedFiles?: unknown;
  readonly retrievalMaxChars?: unknown;
}

export interface ResolvedWorkspaceSettings {
  readonly maxIndexedFiles: number;
  readonly maxRetrievedFiles: number;
  readonly retrievalMaxChars: number;
}

export interface RawAgentSettings {
  readonly maxSteps?: unknown;
  readonly maxRepairIterations?: unknown;
  readonly timeoutMs?: unknown;
}

export interface ResolvedAgentSettings {
  readonly maxSteps: number;
  readonly maxRepairIterations: number;
  readonly timeoutMs: number;
}

export interface RawCommandSettings {
  readonly allowlist?: unknown;
  readonly timeoutMs?: unknown;
  readonly maxOutputChars?: unknown;
}

export interface ResolvedCommandSettings {
  readonly allowlist: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
}

function commandAllowlist(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_COMMAND_ALLOWLIST];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const command = entry.trim().replace(/\s+/g, ' ');
    if (command.length === 0 || command.length > 200) {
      continue;
    }
    // Commands are executed without a shell; reject characters that only make
    // sense to a shell so an allowlist entry cannot chain extra commands.
    if (/[;&|<>`$\\\n\r]/.test(command)) {
      continue;
    }
    if (seen.has(command)) {
      continue;
    }
    seen.add(command);
    result.push(command);
    if (result.length >= LIMITS.maxCommandAllowlist) {
      break;
    }
  }
  return result;
}

export function resolveWorkspaceSettings(raw: RawWorkspaceSettings): ResolvedWorkspaceSettings {
  return {
    maxIndexedFiles: numberValue(
      raw.maxIndexedFiles,
      DEFAULT_WORKSPACE_MAX_INDEXED_FILES,
      LIMITS.maxIndexedFiles.min,
      LIMITS.maxIndexedFiles.max,
      true,
    ),
    maxRetrievedFiles: numberValue(
      raw.maxRetrievedFiles,
      DEFAULT_WORKSPACE_MAX_RETRIEVED_FILES,
      LIMITS.maxRetrievedFiles.min,
      LIMITS.maxRetrievedFiles.max,
      true,
    ),
    retrievalMaxChars: numberValue(
      raw.retrievalMaxChars,
      DEFAULT_WORKSPACE_RETRIEVAL_MAX_CHARS,
      LIMITS.retrievalMaxChars.min,
      LIMITS.retrievalMaxChars.max,
      true,
    ),
  };
}

export function resolveAgentSettings(raw: RawAgentSettings): ResolvedAgentSettings {
  return {
    maxSteps: numberValue(
      raw.maxSteps,
      DEFAULT_AGENT_MAX_STEPS,
      LIMITS.agentMaxSteps.min,
      LIMITS.agentMaxSteps.max,
      true,
    ),
    maxRepairIterations: numberValue(
      raw.maxRepairIterations,
      DEFAULT_AGENT_MAX_REPAIR_ITERATIONS,
      LIMITS.agentMaxRepairIterations.min,
      LIMITS.agentMaxRepairIterations.max,
      true,
    ),
    timeoutMs: numberValue(
      raw.timeoutMs,
      DEFAULT_AGENT_TIMEOUT_MS,
      LIMITS.agentTimeoutMs.min,
      LIMITS.agentTimeoutMs.max,
      true,
    ),
  };
}

export function resolveCommandSettings(raw: RawCommandSettings): ResolvedCommandSettings {
  return {
    allowlist: commandAllowlist(raw.allowlist),
    timeoutMs: numberValue(
      raw.timeoutMs,
      DEFAULT_COMMAND_TIMEOUT_MS,
      LIMITS.commandTimeoutMs.min,
      LIMITS.commandTimeoutMs.max,
      true,
    ),
    maxOutputChars: numberValue(
      raw.maxOutputChars,
      DEFAULT_COMMAND_OUTPUT_MAX_CHARS,
      LIMITS.commandOutputMaxChars.min,
      LIMITS.commandOutputMaxChars.max,
      true,
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
