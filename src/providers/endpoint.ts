import { ProviderError } from './errors';

export interface EndpointValidationOptions {
  readonly allowInsecureLocalhost: boolean;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * Normalizes and validates a provider base URL.
 *
 * - HTTPS is always allowed.
 * - HTTP is allowed only for loopback hosts, and only when explicitly enabled.
 * - Embedded credentials, query strings, and fragments are rejected so a URL
 *   cannot smuggle in secrets or unexpected request parameters.
 */
export function normalizeBaseUrl(
  raw: string,
  options: EndpointValidationOptions = { allowInsecureLocalhost: true },
): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ProviderError('configuration', 'The provider base URL is not configured.');
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ProviderError(
      'configuration',
      'The provider base URL is not a valid URL. Include the scheme, for example https://api.openai.com/v1.',
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ProviderError(
      'configuration',
      'The provider base URL must use https:// (or http:// for loopback addresses).',
    );
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new ProviderError(
      'configuration',
      'The provider base URL must not contain embedded credentials.',
    );
  }

  if (url.search.length > 0 || url.hash.length > 0) {
    throw new ProviderError(
      'configuration',
      'The provider base URL must not contain query parameters or fragments.',
    );
  }

  if (url.protocol === 'http:') {
    if (!isLoopbackHost(url.hostname)) {
      throw new ProviderError(
        'configuration',
        'Plain HTTP is only allowed for loopback providers. Use HTTPS for remote endpoints.',
      );
    }
    if (!options.allowInsecureLocalhost) {
      throw new ProviderError(
        'configuration',
        'Plain HTTP loopback endpoints are disabled. Enable "quantsmind.provider.allowInsecureLocalhost" or use HTTPS.',
      );
    }
  }

  url.pathname = url.pathname.replace(/\/+$/, '');
  const normalized = url.toString().replace(/\/+$/, '');
  return normalized;
}

export function buildChatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) {
    return base;
  }
  return `${base}/chat/completions`;
}

export function describeEndpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'invalid endpoint';
  }
}
