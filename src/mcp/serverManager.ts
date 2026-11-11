import { McpClient, McpError, type McpServerInfo, type McpTool } from './client';

export type McpServerState = 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'error';

export interface McpServerSnapshot {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
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
  readonly command: string;
  readonly args: readonly string[];
  readonly launchOrigin: string;
}

const LAUNCH_ORIGIN_LABEL = 'Application setting quantsmind.mcp.servers (user-controlled configuration)';
const MAX_TRACKED_SERVERS = 10;

/**
 * Launches and supervises MCP server processes for the extension.
 *
 * - Launching a configured server requires explicit user approval per
 *   window (never persisted, never implied by prior discovery or trust).
 * - Connections are cached; repeated tool calls reuse one process.
 * - Crashed or exited servers are detected and disposed; the next call
 *   reconnects (after approval if it lapsed or the server was reconfigured).
 * - `disposeAll()` terminates every child process; wired into extension
 *   deactivation.
 */
/** Stable fingerprint of a server's launch-relevant configuration. */
function fingerprint(server: { command: string; args: readonly string[]; timeoutMs?: number; maxToolOutputChars?: number }): string {
  return JSON.stringify({
    command: server.command,
    args: [...server.args],
    timeoutMs: server.timeoutMs ?? null,
    maxToolOutputChars: server.maxToolOutputChars ?? null,
  });
}

export class McpServerManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly fingerprints = new Map<string, string>();
  private readonly states = new Map<string, McpServerState>();
  private readonly lastErrors = new Map<string, string>();
  private readonly launchOrigin = LAUNCH_ORIGIN_LABEL;
  private readonly approvedLaunches = new Set<string>();

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
  async client(server: { name: string; command: string; args: readonly string[]; timeoutMs?: number; maxToolOutputChars?: number }): Promise<McpClient | undefined> {
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
      this.setError(server.name, 'The previous server process exited; a reconnect was performed.');
    }
    return undefined;
  }

  async connectApproved(server: { name: string; command: string; args: readonly string[]; timeoutMs?: number; maxToolOutputChars?: number }): Promise<McpClient> {
    const cached = await this.client(server);
    if (cached !== undefined) {
      this.setState(server.name, 'connected');
      return cached;
    }
    this.setState(server.name, 'connecting');
    const client = new McpClient({
      name: server.name,
      command: server.command,
      args: server.args,
      ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
      ...(server.maxToolOutputChars !== undefined ? { maxToolOutputChars: server.maxToolOutputChars } : {}),
    });
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

  async listTools(server: { name: string; command: string; args: readonly string[]; timeoutMs?: number; maxToolOutputChars?: number }): Promise<readonly McpTool[]> {
    const client = await this.connectApproved(server);
    return client.listTools();
  }

  async callTool(
    server: { name: string; command: string; args: readonly string[]; timeoutMs?: number; maxToolOutputChars?: number },
    tool: string,
    args: unknown,
    maxOutputChars?: number,
    signal?: AbortSignal,
  ): Promise<import('./client').McpToolResult> {
    const client = await this.connectApproved(server);
    return client.callTool(tool, args, maxOutputChars, signal);
  }

  snapshot(servers: readonly { name: string; command: string; args?: readonly string[]; enabled: boolean; timeoutMs?: number; maxToolOutputChars?: number }[]): readonly McpServerSnapshot[] {
    return servers.map((server) => {
      const client = this.clients.get(server.name);
      const connected = client?.isConnected() === true;
      const error = this.lastErrors.get(server.name);
      return {
        name: server.name,
        command: server.command,
        args: server.args ?? [],
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
    this.lastErrors.set(name, message.slice(0, 400));
    this.setState(name, 'error');
  }
}
