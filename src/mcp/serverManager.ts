import { McpClient, McpError, type McpServerConfig, type McpServerInfo, type McpTool } from './client';
import { redactSecrets } from '../security/redact';
import type { SecretStorageLike } from '../security/secretStore';
import { readMcpCredential } from './credentials';

export type McpServerState = 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'error';
export type McpTransportKind = 'stdio' | 'streamable-http';

export interface McpServerSnapshot {
  readonly name: string;
  readonly transport: McpTransportKind;
  readonly command?: string;
  readonly args: readonly string[];
  readonly url?: string;
  readonly auth: 'none' | 'bearer';
  readonly enabled: boolean;
  readonly state: McpServerState;
  readonly timeoutMs?: number;
  readonly maxToolOutputChars?: number;
  readonly launchOrigin: string;
  readonly serverInfo?: McpServerInfo;
  readonly protocolVersion?: string;
  readonly toolCount?: number;
  readonly lastError?: string;
}

export interface ApproveMcpLaunchRequest {
  readonly name: string;
  readonly transport: McpTransportKind;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly endpoint?: string;
  readonly auth?: 'none' | 'bearer';
  readonly launchOrigin: string;
}

const LAUNCH_ORIGIN_LABEL = 'Application setting quantsmind.mcp.servers (user-controlled configuration)';
const MAX_TRACKED_SERVERS = 10;

/** Stable fingerprint of a server's launch-relevant configuration. */
function fingerprint(server: {
  transport?: McpTransportKind;
  command?: string;
  args?: readonly string[];
  url?: string;
  auth?: 'none' | 'bearer';
  timeoutMs?: number;
  maxToolOutputChars?: number;
}): string {
  return JSON.stringify({
    transport: server.transport ?? 'stdio',
    command: server.command ?? null,
    args: [...(server.args ?? [])],
    url: server.url ?? null,
    auth: server.auth ?? 'none',
    timeoutMs: server.timeoutMs ?? null,
    maxToolOutputChars: server.maxToolOutputChars ?? null,
  });
}

export interface McpServerManagerOptions {
  /** VS Code SecretStorage (or a structural equivalent) for bearer credentials. Optional so tests can omit it. */
  readonly credentials?: SecretStorageLike;
}

/**
 * Launches and supervises MCP server connections for the extension.
 *
 * - Launching a configured server requires explicit user approval per
 *   window (never persisted, never implied by prior discovery or trust).
 * - Connections are cached; repeated tool calls reuse one connection.
 * - Crashed or exited connections are detected and disposed; the next call
 *   reconnects (after approval if it lapsed or the server was reconfigured).
 * - Configuration fingerprints cover transport, command/args, endpoint,
 *   authentication scheme and the v2.5.2 limits; any change invalidates the
 *   cached connection and revokes its launch approval.
 * - Bearer credentials are read from SecretStorage at connect time; the
 *   token never appears in settings, logs, fingerprints or snapshots.
 * - `disconnectAll()` terminates every connection; wired into extension
 *   deactivation.
 */
export class McpServerManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly fingerprints = new Map<string, string>();
  private readonly states = new Map<string, McpServerState>();
  private readonly lastErrors = new Map<string, string>();
  private readonly launchOrigin = LAUNCH_ORIGIN_LABEL;
  private readonly approvedLaunches = new Set<string>();
  private readonly credentials: SecretStorageLike | undefined;

  constructor(options: McpServerManagerOptions = {}) {
    this.credentials = options.credentials;
  }

  /** True when the user has approved launching this server in this window. */
  hasLaunchApproval(name: string): boolean {
    return this.approvedLaunches.has(name);
  }

  grantLaunchApproval(name: string): void {
    if (this.approvedLaunches.size >= MAX_TRACKED_SERVERS) {
      this.approvedLaunches.clear();
    }
    this.approvedLaunches.add(name);
  }

  revokeLaunchApproval(name: string): void {
    this.approvedLaunches.delete(name);
  }

  reset(): void {
    this.approvedLaunches.clear();
  }

  /** Returns the connection for a server, reusing a healthy, identically configured one. */
  async client(server: McpServerConfig): Promise<McpClient | undefined> {
    const desiredFingerprint = fingerprint(server);
    const existingFingerprint = this.fingerprints.get(server.name);
    const existing = this.clients.get(server.name);
    if (existing !== undefined && existingFingerprint !== undefined && existingFingerprint !== desiredFingerprint) {
      // Configuration changed since the last launch: drop the stale connection and approval.
      await existing.close().catch(() => undefined);
      this.clients.delete(server.name);
      this.fingerprints.delete(server.name);
      this.revokeLaunchApproval(server.name);
      this.setError(server.name, 'The server configuration changed; reconnect to launch it with the new settings.');
      return undefined;
    }
    if (existing?.isConnected() === true) {
      return existing;
    }
    if (existing !== undefined) {
      await existing.close().catch(() => undefined);
      this.clients.delete(server.name);
      this.fingerprints.delete(server.name);
      this.setError(server.name, 'The previous connection was closed; a reconnect was performed.');
    }
    return undefined;
  }

  async connectApproved(server: McpServerConfig): Promise<McpClient> {
    const cached = await this.client(server);
    if (cached !== undefined) {
      this.setState(server.name, 'connected');
      return cached;
    }
    const transport = server.transport ?? 'stdio';
    this.setState(server.name, 'connecting');
    const clientConfig: McpServerConfig = {
      name: server.name,
      transport,
      ...(server.command !== undefined ? { command: server.command } : {}),
      ...(server.args !== undefined ? { args: server.args } : {}),
      ...(server.url !== undefined ? { url: server.url } : {}),
      ...(server.env !== undefined ? { env: server.env } : {}),
      ...(server.auth !== undefined ? { auth: server.auth } : {}),
      ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
      ...(server.maxToolOutputChars !== undefined ? { maxToolOutputChars: server.maxToolOutputChars } : {}),
    };
    if (server.auth === 'bearer') {
      // Bearer authentication: the token lives in SecretStorage only.
      if (transport !== 'streamable-http') {
        this.setState(server.name, 'error');
        throw new McpError('disabled', 'Bearer authentication is only supported for streamable-http servers.');
      }
      if (this.credentials === undefined) {
        this.setState(server.name, 'error');
        throw new McpError('auth', 'Secure credential storage is unavailable; cannot authenticate to this server.');
      }
      let token: string | undefined;
      try {
        token = await readMcpCredential(this.credentials, server.name);
      } catch {
        token = undefined;
      }
      if (token === undefined) {
        this.setState(server.name, 'error');
        throw new McpError('auth', `No bearer credential is stored for MCP server "${server.name}". Configure one with "QuantsMind: Manage MCP Servers" before connecting.`);
      }
      (clientConfig as { bearerToken?: string }).bearerToken = token;
    }
    const client = new McpClient(clientConfig);
    try {
      await client.connect();
      this.clients.set(server.name, client);
      this.fingerprints.set(server.name, fingerprint(server));
      this.setState(server.name, 'connected');
      this.lastErrors.delete(server.name);
      return client;
    } catch (error) {
      this.setState(server.name, 'error');
      this.setError(server.name, error instanceof McpError ? error.message : 'Could not connect to the MCP server.');
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async listTools(server: McpServerConfig): Promise<readonly McpTool[]> {
    const client = await this.connectApproved(server);
    return client.listTools();
  }

  async callTool(
    server: McpServerConfig,
    tool: string,
    args: unknown,
    maxOutputChars?: number,
    signal?: AbortSignal,
  ): Promise<import('./client').McpToolResult> {
    const client = await this.connectApproved(server);
    return client.callTool(tool, args, maxOutputChars, signal);
  }

  snapshot(servers: readonly (McpServerConfig & { readonly enabled: boolean })[]): readonly McpServerSnapshot[] {
    return servers.map((server) => {
      const client = this.clients.get(server.name);
      const connected = client?.isConnected() === true;
      const transport = server.transport ?? 'stdio';
      const error = this.lastErrors.get(server.name);
      return {
        name: server.name,
        transport,
        ...(server.command !== undefined ? { command: server.command } : {}),
        args: server.args ?? [],
        ...(server.url !== undefined ? { url: server.url } : {}),
        auth: server.auth ?? 'none',
        enabled: server.enabled,
        state: this.states.get(server.name) ?? (server.enabled ? 'disconnected' : 'disabled'),
        ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
        ...(server.maxToolOutputChars !== undefined ? { maxToolOutputChars: server.maxToolOutputChars } : {}),
        launchOrigin: this.launchOrigin,
        ...(connected && client?.serverInfo() !== undefined ? { serverInfo: client.serverInfo() } : {}),
        ...(connected && client?.protocolVersion() !== undefined ? { protocolVersion: client.protocolVersion() } : {}),
        ...(connected ? { toolCount: client?.cachedToolCount() } : {}),
        ...(error !== undefined ? { lastError: error } : {}),
      };
    });
  }

  state(name: string): McpServerState {
    return this.states.get(name) ?? 'disconnected';
  }

  lastError(name: string): string | undefined {
    return this.lastErrors.get(name);
  }

  async disconnect(name: string): Promise<void> {
    const client = this.clients.get(name);
    this.clients.delete(name);
    this.fingerprints.delete(name);
    if (client !== undefined) {
      await client.close().catch(() => undefined);
    }
    this.setState(name, 'disconnected');
  }

  async disconnectAll(): Promise<void> {
    const names = [...this.clients.keys()];
    await Promise.all(names.map((name) => this.disconnect(name)));
  }

  private setState(name: string, state: McpServerState): void {
    this.states.set(name, state);
    if (state === 'connected') {
      this.lastErrors.delete(name);
    }
  }

  private setError(name: string, message: string): void {
    this.lastErrors.set(name, redactSecrets(message).text.slice(0, 400));
    this.setState(name, 'error');
  }
}
