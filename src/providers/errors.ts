import { redactSecrets } from '../security/redact';

export type ProviderErrorCode =
  | 'configuration'
  | 'authentication'
  | 'rate_limit'
  | 'timeout'
  | 'cancelled'
  | 'network'
  | 'server'
  | 'http'
  | 'invalid_response';

const MAX_MESSAGE_LENGTH = 500;
const MAX_PROVIDER_MESSAGE_LENGTH = 240;

export interface ProviderErrorOptions {
  readonly status?: number;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

function sanitizeMessage(message: string, maxLength = MAX_MESSAGE_LENGTH): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  const collapsed = cleaned.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength - 1)}…`;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions = {}) {
    // Defense in depth: every provider error is scrubbed again here so a
    // caller cannot accidentally surface a credential echoed by a provider.
    super(sanitizeMessage(redactSecrets(message).text), { cause: options.cause });
    this.name = 'ProviderError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

export type RetryAfterHeaders =
  | { get(name: string): string | null }
  | Record<string, string | undefined | null>
  | Map<string, string>
  | undefined;

export function parseRetryAfterMs(headers: RetryAfterHeaders): number | undefined {
  if (headers === undefined) return undefined;
  let value: string | null | undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    value = (headers as { get(name: string): string | null }).get('retry-after');
  } else if (headers instanceof Map) {
    value = headers.get('retry-after') ?? headers.get('Retry-After');
  } else {
    const record = headers as Record<string, unknown>;
    value = (record['retry-after'] ?? record['Retry-After']) as string | null | undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    const diff = parsedDate - Date.now();
    if (diff > 0) return Math.min(diff, 60_000);
  }
  return undefined;
}

export function shouldRetryProviderError(error: unknown): boolean {
  if (!isProviderError(error)) return false;
  if (error.code === 'cancelled' || error.code === 'authentication' || error.code === 'configuration') return false;
  if (error.code === 'rate_limit') return true;
  if (error.code === 'server' && (error.status === 503 || error.status === 502)) return true;
  return false;
}

function readProviderMessage(bodyText: string, secret?: string): string | undefined {
  const trimmed = bodyText.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      if (typeof error === 'object' && error !== null) {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === 'string' && message.trim().length > 0) {
          return sanitizeMessage(redactSecrets(message, [secret]).text, MAX_PROVIDER_MESSAGE_LENGTH);
        }
      }
      if (typeof record.message === 'string' && record.message.trim().length > 0) {
        return sanitizeMessage(redactSecrets(record.message, [secret]).text, MAX_PROVIDER_MESSAGE_LENGTH);
      }
    }
    return undefined;
  } catch {
    if (trimmed.length > MAX_PROVIDER_MESSAGE_LENGTH || trimmed.startsWith('<')) {
      return undefined;
    }
    return sanitizeMessage(redactSecrets(trimmed, [secret]).text, MAX_PROVIDER_MESSAGE_LENGTH);
  }
}

/**
 * Maps an HTTP failure to a stable, user-safe error. The raw response body is
 * never surfaced wholesale or logged. `headers` is optional; when provided,
 * `Retry-After` is parsed and stored on the error for bounded retry logic.
 */
export function normalizeHttpError(
  status: number,
  bodyText: string,
  secret?: string,
  headers?: RetryAfterHeaders,
): ProviderError {
  const providerMessage = readProviderMessage(bodyText, secret);
  const suffix = providerMessage !== undefined ? ` Provider message: ${providerMessage}` : '';
  const retryAfterMs = status === 429 || status === 503 ? parseRetryAfterMs(headers) : undefined;

  if (status === 401 || status === 403) {
    return new ProviderError(
      'authentication',
      `Authentication failed (HTTP ${status}). Check the API key and provider permissions.${suffix}`,
      { status, retryAfterMs },
    );
  }

  if (status === 404) {
    return new ProviderError(
      'http',
      `The endpoint or model was not found (HTTP 404). Check the base URL and model name.${suffix}`,
      { status, retryAfterMs },
    );
  }

  if (status === 408) {
    return new ProviderError('timeout', `The provider reported a request timeout (HTTP 408).${suffix}`, {
      status,
      retryable: true,
      retryAfterMs,
    });
  }

  if (status === 429) {
    return new ProviderError(
      'rate_limit',
      `The provider rate-limited the request (HTTP 429). Wait and retry.${suffix}`,
      { status, retryable: true, retryAfterMs: retryAfterMs ?? 500 },
    );
  }

  if (status >= 500) {
    return new ProviderError(
      'server',
      `The provider returned a server error (HTTP ${status}). Retry later.${suffix}`,
      { status, retryable: status === 503 || status === 502, retryAfterMs: retryAfterMs ?? (status === 503 ? 500 : undefined) },
    );
  }

  return new ProviderError('http', `The provider rejected the request (HTTP ${status}).${suffix}`, {
    status,
    retryAfterMs,
  });
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError')
  );
}

/**
 * Converts fetch/stream exceptions into normalized provider errors. Callers
 * handle cancellation and timeout before reaching this function. Underlying
 * Node.js `code` values (ECONNREFUSED, ENOTFOUND, ECONNRESET, …) are mapped
 * to distinct network messages to distinguish connection-refused, DNS and
 * connection-reset failures without leaking topology details or secrets.
 */
export function normalizeThrownError(error: unknown, secret?: string): ProviderError {
  if (isProviderError(error)) {
    return error;
  }

  if (isAbortError(error)) {
    return new ProviderError('cancelled', 'The request was cancelled.');
  }

  const causeCode = extractCauseCode(error);
  const raw = error instanceof Error ? error.message : String(error);
  // Redact before classifying so a secret embedded in an error message cannot
  // influence the classification string or leak into the final message.
  const safe = redactSecrets(raw, [secret]).text;
  const suffix = safe.length > 0 ? ` Details: ${sanitizeMessage(safe, 180)}` : '';

  if (causeCode === 'ECONNREFUSED') {
    return new ProviderError(
      'network',
      `The connection was refused. Is the provider server running on the configured endpoint?${suffix}`,
      { cause: error },
    );
  }
  if (causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN' || causeCode === 'ENETUNREACH') {
    return new ProviderError(
      'network',
      `The provider host could not be resolved. Check the base URL spelling and DNS.${suffix}`,
      { cause: error },
    );
  }
  if (causeCode === 'ECONNRESET' || causeCode === 'EPIPE' || causeCode === 'ENOTCONN') {
    return new ProviderError(
      'network',
      `The connection was reset. Check the endpoint, proxy, and TLS configuration.${suffix}`,
      { cause: error },
    );
  }
  if (causeCode === 'ETIMEDOUT' || causeCode === 'ESOCKETTIMEDOUT') {
    return new ProviderError(
      'timeout',
      `The connection timed out. Check the endpoint and try again.${suffix}`,
      { cause: error, retryable: true },
    );
  }

  return new ProviderError(
    'network',
    `Could not reach the AI provider. Check the endpoint, network connection, and TLS configuration.${suffix}`,
    { cause: error },
  );
}

function extractCauseCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } | undefined };
  const direct = candidate?.code;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const cause = candidate?.cause;
  if (cause !== null && typeof cause === 'object' && typeof cause.code === 'string') {
    return cause.code;
  }
  return undefined;
}

export function errorHint(code: ProviderErrorCode): string | undefined {
  switch (code) {
    case 'authentication':
      return 'Set or replace the API key with "QuantsMind: Set API Key".';
    case 'configuration':
      return 'Open the QuantsMind provider settings and verify the endpoint and model.';
    case 'rate_limit':
      return 'Wait a moment and retry, or choose a different model/provider.';
    case 'timeout':
      return 'Increase "quantsmind.provider.requestTimeoutMs" or send less context.';
    case 'network':
      return 'Verify the base URL, network connectivity, proxy, and TLS certificates.';
    case 'invalid_response':
      return 'The endpoint may not be OpenAI-compatible. Check the base URL.';
    case 'server':
      return 'The provider is having trouble. Retry later.';
    case 'cancelled':
      return undefined;
    default:
      return 'Check the QuantsMind log for normalized diagnostics.';
  }
}
