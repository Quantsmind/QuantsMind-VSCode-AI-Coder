/**
 * Shared validation for MCP Streamable HTTP endpoints.
 *
 * Used by the settings resolver (authoritative), the MCP client (defense in
 * depth) and the management UI (input validation). One implementation keeps
 * the security rules identical across all three entry points.
 *
 * Rules:
 * - `https:` is required for production remote endpoints.
 * - `http:` is permitted only for loopback development/test scenarios
 *   (`localhost`, `127.0.0.1`, `::1` / `[::1]`).
 * - Userinfo (`https://user:pass@host`), query strings and fragments are
 *   rejected: credentials must never travel in a URL. Store them with
 *   `QuantsMind: Manage MCP Servers` instead (SecretStorage-backed).
 * - Everything must parse with the WHATWG URL parser; malformed endpoints
 *   are rejected outright.
 * - No other schemes (`file:`, `ftp:`, `ws:`, ...) are permitted.
 * - Certificate verification is never disabled; this module cannot weaken TLS.
 */
export const MAX_MCP_ENDPOINT_LENGTH = 2_048;

export type McpEndpointParseResult =
  | { readonly ok: true; readonly url: string; readonly hostname: string; readonly isLoopbackHttp: boolean }
  | { readonly ok: false; readonly error: string };

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return LOOPBACK_HOSTNAMES.has(normalized);
}

export function parseMcpEndpoint(raw: unknown): McpEndpointParseResult {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'The endpoint must be a string.' };
  }
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, error: 'The endpoint is required.' };
  }
  if (value.length > MAX_MCP_ENDPOINT_LENGTH) {
    return { ok: false, error: `The endpoint is too long (maximum ${MAX_MCP_ENDPOINT_LENGTH} characters).` };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: 'The endpoint is not a valid URL.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: `The endpoint scheme "${url.protocol.replace(':', '')}" is not permitted; use https (or http only for loopback development).` };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'The endpoint must not contain user info (user:password@); store credentials with "Manage MCP Servers" instead.' };
  }
  if (url.search !== '') {
    return { ok: false, error: 'The endpoint must not contain a query string; store credentials with "Manage MCP Servers" instead.' };
  }
  if (url.hash !== '') {
    return { ok: false, error: 'The endpoint must not contain a fragment.' };
  }
  if (url.hostname.length === 0) {
    return { ok: false, error: 'The endpoint must include a host.' };
  }
  const isLoopbackHttp = url.protocol === 'http:';
  if (isLoopbackHttp && !isLoopbackHostname(url.hostname)) {
    return { ok: false, error: 'Plain HTTP is only permitted for loopback endpoints (localhost, 127.0.0.1, ::1); use https for remote servers.' };
  }
  return { ok: true, url: url.toString(), hostname: url.hostname, isLoopbackHttp };
}

/** True when the endpoint passes all transport security rules. */
export function isPermittedMcpEndpoint(raw: unknown): boolean {
  return parseMcpEndpoint(raw).ok;
}
