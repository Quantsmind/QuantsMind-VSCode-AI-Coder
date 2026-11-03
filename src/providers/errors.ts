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

  constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions = {}) {
    // Defense in depth: every provider error is scrubbed again here so a
    // caller cannot accidentally surface a credential echoed by a provider.
    super(sanitizeMessage(redactSecrets(message).text), { cause: options.cause });
    this.name = 'ProviderError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
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
 * never surfaced wholesale or logged.
 */
export function normalizeHttpError(
  status: number,
  bodyText: string,
  secret?: string,
): ProviderError {
  const providerMessage = readProviderMessage(bodyText, secret);
  const suffix = providerMessage !== undefined ? ` Provider message: ${providerMessage}` : '';

  if (status === 401 || status === 403) {
    return new ProviderError(
      'authentication',
      `Authentication failed (HTTP ${status}). Check the API key and provider permissions.${suffix}`,
      { status },
    );
  }

  if (status === 404) {
    return new ProviderError(
      'http',
      `The endpoint or model was not found (HTTP 404). Check the base URL and model name.${suffix}`,
      { status },
    );
  }

  if (status === 408) {
    return new ProviderError('timeout', `The provider reported a request timeout (HTTP 408).${suffix}`, {
      status,
      retryable: true,
    });
  }

  if (status === 429) {
    return new ProviderError(
      'rate_limit',
      `The provider rate-limited the request (HTTP 429). Wait and retry.${suffix}`,
      { status, retryable: true },
    );
  }

  if (status >= 500) {
    return new ProviderError(
      'server',
      `The provider returned a server error (HTTP ${status}). Retry later.${suffix}`,
      { status, retryable: true },
    );
  }

  return new ProviderError('http', `The provider rejected the request (HTTP ${status}).${suffix}`, {
    status,
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
 * handle cancellation and timeout before reaching this function.
 */
export function normalizeThrownError(error: unknown, secret?: string): ProviderError {
  if (isProviderError(error)) {
    return error;
  }

  if (isAbortError(error)) {
    return new ProviderError('cancelled', 'The request was cancelled.');
  }

  const raw = error instanceof Error ? error.message : String(error);
  const safe = redactSecrets(raw, [secret]).text;
  const suffix = safe.length > 0 ? ` Details: ${sanitizeMessage(safe, 180)}` : '';

  return new ProviderError(
    'network',
    `Could not reach the AI provider. Check the endpoint, network connection, and TLS configuration.${suffix}`,
    { cause: error },
  );
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
