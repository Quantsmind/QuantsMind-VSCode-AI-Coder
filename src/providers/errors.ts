import { redactSecrets } from '../security/redact';

export type ProviderErrorCode =
  | 'configuration'
  | 'authentication'
  | 'quota'
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
  if (headers === undefined) {
    return undefined;
  }
  let value: string | null | undefined;
  // A Map also exposes `get`, but unlike Headers it is case-sensitive, so it
  // must be matched before the duck-typed branch.
  if (headers instanceof Map) {
    value = headers.get('retry-after') ?? headers.get('Retry-After');
  } else if (typeof (headers as { get?: unknown }).get === 'function') {
    value = (headers as { get(name: string): string | null }).get('retry-after');
  } else {
    const record = headers as Record<string, unknown>;
    value = (record['retry-after'] ?? record['Retry-After']) as string | null | undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 60_000);
    }
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    const diff = parsedDate - Date.now();
    if (diff > 0) {
      return Math.min(diff, 60_000);
    }
  }
  return undefined;
}

/**
 * Single source of truth for automatic retry eligibility. `normalizeHttpError`
 * derives the `retryable` flag from this same rule so the metadata surfaced to
 * the user cannot disagree with what `withProviderRetry` actually does.
 */
function isRetryableClassification(code: ProviderErrorCode, status?: number): boolean {
  if (code === 'rate_limit') {
    return true;
  }
  if (code === 'server') {
    return status === 503 || status === 502;
  }
  return false;
}

export function shouldRetryProviderError(error: unknown): boolean {
  if (!isProviderError(error)) {
    return false;
  }
  return isRetryableClassification(error.code, error.status);
}

const QUOTA_CODE_MARKERS: ReadonlySet<string> = new Set([
  'insufficient_quota',
  'quota_exceeded',
  'quota_exhausted',
  'billing_hard_limit_reached',
  'billing_not_active',
  'billing_limit_reached',
  'credit_balance_too_low',
  'insufficient_credits',
]);

const QUOTA_MESSAGE_MARKERS: readonly string[] = [
  'insufficient quota',
  'insufficient_quota',
  'exceeded your current quota',
  'quota exceeded',
  'quota has been exhausted',
  'out of quota',
  'billing hard limit',
  'credit balance is too low',
  'insufficient credits',
  'no remaining credits',
];

function containsQuotaMarker(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.toLowerCase();
  if (QUOTA_CODE_MARKERS.has(normalized.trim())) {
    return true;
  }
  return QUOTA_MESSAGE_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Detects an explicit quota/billing exhaustion signal. Only structured fields
 * and short provider messages are inspected; the body is never surfaced.
 * A 401 is excluded by the caller so an invalid key stays an authentication
 * failure even when the provider mentions billing in the same payload.
 */
function hasQuotaExhaustionSignal(bodyText: string): boolean {
  const trimmed = bodyText.trim();
  if (trimmed.length === 0 || trimmed.startsWith('<')) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return containsQuotaMarker(trimmed.slice(0, MAX_PROVIDER_MESSAGE_LENGTH));
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return false;
  }
  const record = parsed as Record<string, unknown>;
  const error = typeof record.error === 'object' && record.error !== null
    ? (record.error as Record<string, unknown>)
    : undefined;
  return (
    containsQuotaMarker(error?.type) ||
    containsQuotaMarker(error?.code) ||
    containsQuotaMarker(error?.message) ||
    containsQuotaMarker(record.type) ||
    containsQuotaMarker(record.code) ||
    containsQuotaMarker(record.message)
  );
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

  // 402 is unambiguous. Elsewhere an explicit quota/billing marker wins over the
  // status-based classification (OpenAI reports exhausted quota as 429, some
  // gateways as 403), but never over a 401 invalid-credential response.
  if (status === 402 || (status !== 401 && hasQuotaExhaustionSignal(bodyText))) {
    return new ProviderError(
      'quota',
      `The provider reports exhausted quota or billing limits (HTTP ${status}). Automatic retries are disabled because retrying cannot restore quota.${suffix}`,
      { status, retryable: false },
    );
  }

  if (status === 401 || status === 403) {
    return new ProviderError(
      'authentication',
      `Authentication failed (HTTP ${status}). Check the API key and provider permissions.${suffix}`,
      { status, retryable: isRetryableClassification('authentication', status), retryAfterMs },
    );
  }

  if (status === 404) {
    return new ProviderError(
      'http',
      `The endpoint or model was not found (HTTP 404). Check the base URL and model name.${suffix}`,
      { status, retryable: isRetryableClassification('http', status), retryAfterMs },
    );
  }

  if (status === 408) {
    return new ProviderError(
      'timeout',
      `The provider reported a request timeout (HTTP 408). It is not retried automatically; increase the request timeout or send less context.${suffix}`,
      { status, retryable: isRetryableClassification('timeout', status), retryAfterMs },
    );
  }

  if (status === 429) {
    return new ProviderError(
      'rate_limit',
      `The provider rate-limited the request (HTTP 429). Wait and retry.${suffix}`,
      {
        status,
        retryable: isRetryableClassification('rate_limit', status),
        retryAfterMs: retryAfterMs ?? 500,
      },
    );
  }

  if (status >= 500) {
    const retryable = isRetryableClassification('server', status);
    const guidance = retryable
      ? 'It may be retried automatically once.'
      : 'It is not retried automatically; retry later.';
    return new ProviderError(
      'server',
      `The provider returned a server error (HTTP ${status}). ${guidance}${suffix}`,
      { status, retryable, retryAfterMs: retryAfterMs ?? (status === 503 ? 500 : undefined) },
    );
  }

  return new ProviderError('http', `The provider rejected the request (HTTP ${status}).${suffix}`, {
    status,
    retryable: isRetryableClassification('http', status),
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
    case 'quota':
      return 'The account has no usable quota or credits left. Check the provider billing and usage limits, then retry once quota is available. A local provider such as Ollama does not consume cloud quota.';
    case 'configuration':
      return 'Open the QuantsMind provider settings and verify the endpoint and model.';
    case 'rate_limit':
      return 'Wait a moment and retry, or choose a different model/provider.';
    case 'timeout':
      return 'Increase "quantsmind.provider.requestTimeoutMs" or send less context, then retry. Timeouts are not retried automatically.';
    case 'network':
      return 'Verify the base URL, network connectivity, proxy, and TLS certificates.';
    case 'invalid_response':
      return 'The endpoint may not be OpenAI-compatible. Check the base URL.';
    case 'server':
      return 'The provider is having trouble. Only HTTP 502 and 503 are retried automatically; for other server errors retry later.';
    case 'cancelled':
      return undefined;
    default:
      return 'Check the QuantsMind log for normalized diagnostics.';
  }
}
