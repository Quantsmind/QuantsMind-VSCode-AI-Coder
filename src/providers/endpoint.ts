import { ProviderError } from './errors';

export interface EndpointValidationOptions {
  readonly allowInsecureLocalhost: boolean;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** RFC 1918 private IPv4 ranges: 10/8, 172.16/12, 192.168/16. */
export function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.trim().toLowerCase().split('.');
  if (parts.length !== 4) {
    return false;
  }
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  if (!Number.isInteger(first) || !Number.isInteger(second)) {
    return false;
  }
  if (parts.some((part) => !/^\d+$/.test(part))) {
    return false;
  }
  if (first === 10) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  return false;
}

/**
 * Loopback OR private literal IPs. Hostnames that would require DNS resolution
 * are NOT treated as LAN/private here — see the DNS boundary note on
 * `normalizeBaseUrl`.
 */
export function isLoopbackOrPrivateHost(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  if (isLoopbackHost(lower)) {
    return true;
  }
  if (isPrivateIPv4(lower)) {
    return true;
  }
  return false;
}

/**
 * Normalizes and validates a provider base URL.
 *
 * - HTTPS is always allowed.
 * - Plain HTTP is allowed only for literal loopback or RFC 1918 private IPs,
 *   and only when explicitly enabled via `allowInsecureLocalhost` (the flag
 *   name is retained for backwards compatibility; it now also covers private
 *   LAN literals).
 * - Embedded credentials, query strings, and fragments are rejected so a URL
 *   cannot smuggle in secrets or unexpected request parameters.
 *
 * DNS boundary: this function performs no DNS resolution. Hostnames — including
 * single-label names (e.g. `ollama`) and `.local` mDNS names — resolve through
 * DNS search domains, /etc/hosts, or mDNS and could point at a public address.
 * They are therefore NOT treated as private/LAN here and must use HTTPS (or a
 * loopback/private literal instead). Adding DNS-aware verification (resolve +
 * address-family checks, TTL/TOCTOU handling) would be a new network-execution
 * capability, which the endpoint architecture cannot provide safely today; the
 * conservative literal-only rule above is the documented boundary.
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
      'The provider base URL must use https:// (or http:// for loopback/private addresses).',
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
    if (!isLoopbackOrPrivateHost(url.hostname)) {
      throw new ProviderError(
        'configuration',
        'Plain HTTP is only allowed for literal loopback or private IP addresses. Use HTTPS for hostnames, remote endpoints, or DNS-resolved addresses.',
      );
    }
    if (!options.allowInsecureLocalhost) {
      throw new ProviderError(
        'configuration',
        'Plain HTTP loopback/private endpoints are disabled. Enable "quantsmind.provider.allowInsecureLocalhost" or use HTTPS.',
      );
    }
  }

  url.pathname = url.pathname.replace(/\/+$/, '');
  const normalized = url.toString().replace(/\/+$/, '');
  if (normalized.length > 4096) {
    throw new ProviderError('configuration', 'The provider base URL is too long.');
  }
  // Reject control characters in the path.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(url.pathname)) {
    throw new ProviderError('configuration', 'The provider base URL path is invalid.');
  }
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
