/**
 * Bearer-credential storage for remote MCP servers.
 *
 * - Credentials live in VS Code `SecretStorage` only; never in settings,
 *   never in workspace files, never in logs or diagnostics.
 * - One namespaced key per server: `quantsmind.mcp.credential.<name>`.
 * - Writes are validated with the project's shared credential rules before
 *   they reach storage (non-empty, length-capped, no control characters).
 * - Removing or replacing a credential does not rewrite history; deleting
 *   the key is all that is needed to fully remove it.
 * - OAuth for MCP Streamable HTTP is deliberately not implemented in this
 *   version; it is documented as future work rather than shipping an
 *   incomplete or insecure flow.
 */
import { validateCredential } from '../security/credential';
import type { SecretStorageLike } from '../security/secretStore';

const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MCP_CREDENTIAL_KEY_PREFIX = 'quantsmind.mcp.credential.';

export function mcpCredentialSecretKey(serverName: string): string {
  const normalized = serverName.trim();
  if (!MCP_NAME.test(normalized)) {
    throw new Error('An MCP server name must match [A-Za-z0-9._-] and start with a letter or digit.');
  }
  return `${MCP_CREDENTIAL_KEY_PREFIX}${normalized}`;
}

/** True when a hidden bearer credential is stored for the named server. */
export async function hasMcpCredential(storage: SecretStorageLike, serverName: string): Promise<boolean> {
  const value = await storage.get(mcpCredentialSecretKey(serverName));
  return typeof value === 'string' && value.length > 0;
}

/** Reads the bearer credential; undefined when absent. Never logged. */
export async function readMcpCredential(storage: SecretStorageLike, serverName: string): Promise<string | undefined> {
  const value = await storage.get(mcpCredentialSecretKey(serverName));
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Validates and stores the bearer credential. The raw value is never echoed. */
export async function storeMcpCredential(storage: SecretStorageLike, serverName: string, token: string): Promise<void> {
  const validated = validateCredential(token);
  await storage.store(mcpCredentialSecretKey(serverName), validated);
}

export async function deleteMcpCredential(storage: SecretStorageLike, serverName: string): Promise<void> {
  await storage.delete(mcpCredentialSecretKey(serverName));
}
