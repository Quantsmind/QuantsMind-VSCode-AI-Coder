import { withAbort } from './cancellation';
import { userAgent } from './openaiCompatible';
import { normalizeBaseUrl } from './endpoint';
import { ProviderError, isProviderError, normalizeHttpError, normalizeThrownError } from './errors';
import { getProviderProfile, providerAdapterForType } from './profiles';
import type { CancellationTokenLike } from './types';

export type FetchLike = typeof fetch;

const MAX_JSON_RESPONSE_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export type ModelDiscoveryStatus =
  | 'available'
  | 'unsupported'
  | 'unavailable'
  | 'auth_failed'
  | 'network_error'
  | 'configuration_error';

export interface ModelDiscoveryResult {
  readonly status: ModelDiscoveryStatus;
  /** Discovered model ids (empty when status is not available). Never throws for HTTP/parse errors. */
  readonly models: readonly string[];
  /** Distinguishes discovered ids from a manually entered model. */
  readonly source: 'discovered' | 'manual';
  readonly message: string;
  /** HTTP status when relevant (for diagnostics). */
  readonly httpStatus?: number;
}

export interface ListModelsOptions {
  readonly type: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly allowInsecureLocalhost?: boolean;
  readonly token?: CancellationTokenLike;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

async function readResponseText(
  response: Response,
  limitBytes: number,
  overflow: 'truncate' | 'error',
): Promise<string> {
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const remaining = limitBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(Buffer.from(value.subarray(0, remaining)));
        }
        await reader.cancel();
        if (overflow === 'error') {
          throw new ProviderError(
            'invalid_response',
            'The provider response exceeded the supported size limit.',
          );
        }
        break;
      }
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseOpenAiModels(payload: unknown): string[] {
  const record = asRecord(payload);
  if (record === undefined) {
    return [];
  }
  const data = Array.isArray(record.data) ? record.data : [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    const entry = asRecord(item);
    const id = entry?.id;
    if (typeof id === 'string' && id.trim().length > 0) {
      const trimmed = id.trim();
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        ids.push(trimmed);
      }
    }
  }
  return ids;
}

function parseGeminiModels(payload: unknown): string[] {
  const record = asRecord(payload);
  if (record === undefined) {
    return [];
  }
  const models = Array.isArray(record.models) ? record.models : [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of models) {
    const entry = asRecord(item);
    const name = entry?.name;
    if (typeof name === 'string' && name.trim().length > 0) {
      const trimmed = name.trim().replace(/^models\//, '');
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        ids.push(trimmed);
      }
    }
  }
  return ids;
}

function buildModelsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (base.endsWith('/models')) {
    return base;
  }
  return `${base}/models`;
}

/**
 * Lists models for the selected profile. Never throws for transport, HTTP or
 * parse failures — those are reported as a structured result so the caller
 * can fall back to manual model entry.
 */
export async function listProviderModels(options: ListModelsOptions): Promise<ModelDiscoveryResult> {
  const type = options.type.trim();
  const profile = getProviderProfile(type);
  const adapter = providerAdapterForType(type);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (adapter === undefined) {
    return {
      status: 'unsupported',
      models: [],
      source: 'manual',
      message: `Model discovery is not supported for provider type "${type}". Enter a model manually.`,
    };
  }

  const profileCaps = profile?.capabilities;
  if (profileCaps !== undefined && !profileCaps.modelDiscovery) {
    return {
      status: 'unsupported',
      models: [],
      source: 'manual',
      message: `Model discovery is not supported for ${profile?.displayName ?? type}. Enter a model manually.`,
    };
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      status: 'configuration_error',
      models: [],
      source: 'manual',
      message: 'The model discovery timeout must be a positive number.',
    };
  }

  try {
    return await withAbort(
      async (signal) => {
        let url: string;
        const headers: Record<string, string> = {
          Accept: 'application/json',
          'User-Agent': userAgent(),
        };
        if (adapter === 'gemini') {
          url = 'https://generativelanguage.googleapis.com/v1beta/models';
          if (options.apiKey !== undefined && options.apiKey.length > 0) {
            headers['x-goog-api-key'] = options.apiKey;
          }
        } else {
          const baseUrl =
            typeof options.baseUrl === 'string' && options.baseUrl.trim().length > 0
              ? options.baseUrl
              : (profile?.defaultBaseUrl ?? '');
          if (baseUrl.length === 0) {
            return {
              status: 'configuration_error',
              models: [],
              source: 'manual',
              message: 'The provider endpoint is not configured.',
            } satisfies ModelDiscoveryResult;
          }
          let normalized: string;
          try {
            normalized = normalizeBaseUrl(baseUrl, {
              allowInsecureLocalhost: options.allowInsecureLocalhost ?? true,
            });
          } catch (error) {
            if (isProviderError(error)) {
              return {
                status: 'configuration_error',
                models: [],
                source: 'manual',
                message: error.message,
              } satisfies ModelDiscoveryResult;
            }
            return {
              status: 'configuration_error',
              models: [],
              source: 'manual',
              message: 'The provider endpoint configuration is invalid.',
            } satisfies ModelDiscoveryResult;
          }
          url = buildModelsUrl(normalized);
          if (options.apiKey !== undefined && options.apiKey.length > 0) {
            headers.Authorization = `Bearer ${options.apiKey}`;
          }
        }

        // Idempotent GET — bounded retry once for rate-limit / transient server errors.
        const maxAttempts = 2;
        let lastResult: ModelDiscoveryResult | undefined;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          if (signal.aborted) {
            throw new ProviderError('cancelled', 'The request was cancelled.');
          }
          const response = await fetchImpl(url, {
            method: 'GET',
            headers,
            signal,
            redirect: 'error',
          });

          if (!response.ok) {
            let body: string;
            try {
              body = await readResponseText(response, 64 * 1024, 'truncate');
            } catch {
              body = '';
            }
            const httpError = normalizeHttpError(response.status, body, options.apiKey, response.headers);
            const status: ModelDiscoveryStatus =
              httpError.code === 'authentication'
                ? 'auth_failed'
                : httpError.code === 'http' && response.status === 404
                  ? 'unsupported'
                  : httpError.code === 'network'
                    ? 'network_error'
                    : 'unavailable';
            lastResult = {
              status,
              models: [],
              source: 'manual',
              message: httpError.message,
              httpStatus: response.status,
            };
            const retryable =
              httpError.code === 'rate_limit' ||
              (httpError.code === 'server' && (response.status === 503 || response.status === 502));
            if (retryable && attempt + 1 < maxAttempts) {
              const delayMs = Math.min(httpError.retryAfterMs ?? 500, 2000);
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                  signal.removeEventListener('abort', onAbort);
                  resolve();
                }, delayMs);
                const onAbort = (): void => {
                  clearTimeout(timer);
                  reject(new ProviderError('cancelled', 'The request was cancelled.'));
                };
                signal.addEventListener('abort', onAbort, { once: true });
              });
              continue;
            }
            return lastResult;
          }

          const text = await readResponseText(response, MAX_JSON_RESPONSE_BYTES, 'error');
          let payload: unknown;
          try {
            payload = JSON.parse(text);
          } catch {
            return {
              status: 'unavailable',
              models: [],
              source: 'manual',
              message: 'The provider returned an invalid model list response. Enter a model manually.',
            } satisfies ModelDiscoveryResult;
          }

          const models = adapter === 'gemini' ? parseGeminiModels(payload) : parseOpenAiModels(payload);
          if (models.length === 0) {
            return {
              status: 'unavailable',
              models: [],
              source: 'manual',
              message: 'No models were returned. Enter a model manually.',
            } satisfies ModelDiscoveryResult;
          }
          return {
            status: 'available',
            models,
            source: 'discovered',
            message: `Found ${models.length} model(s).`,
          } satisfies ModelDiscoveryResult;
        }
        return (
          lastResult ?? {
            status: 'unavailable',
            models: [],
            source: 'manual',
            message: 'Model discovery failed.',
          }
        );
      },
      { token: options.token, timeoutMs },
    );
  } catch (error) {
    if (isProviderError(error)) {
      if (error.code === 'cancelled') {
        return {
          status: 'unavailable',
          models: [],
          source: 'manual',
          message: 'Model discovery was cancelled.',
        };
      }
      if (error.code === 'timeout') {
        return {
          status: 'network_error',
          models: [],
          source: 'manual',
          message: error.message,
        };
      }
      if (error.code === 'configuration') {
        return {
          status: 'configuration_error',
          models: [],
          source: 'manual',
          message: error.message,
        };
      }
      if (error.code === 'authentication') {
        return {
          status: 'auth_failed',
          models: [],
          source: 'manual',
          message: error.message,
        };
      }
      return {
        status: 'unavailable',
        models: [],
        source: 'manual',
        message: error.message,
      };
    }
    const normalized = normalizeThrownError(error, options.apiKey);
    void normalized;
    return {
      status: 'network_error',
      models: [],
      source: 'manual',
      message: 'Could not reach the provider. Check the endpoint and network connection.',
    };
  }
}
