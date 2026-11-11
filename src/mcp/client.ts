import { redactSecrets } from '../security/redact';
import {
  StdioTransport,
  StreamableHttpTransport,
  STREAMABLE_HTTP_CONNECT_ATTEMPTS,
  STREAMABLE_HTTP_RETRY_BACKOFF_MS,
  mcpRetrySleep,
  type McpTransport,
} from './transport';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2024-11-05'] as const;
export const DEFAULT_MCP_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 20_000;
export const MAX_STDERR_CHARS = 4_000;
export const MAX_MESSAGE_CHARS = 1_000_000;
export const MAX_SCHEMA_CHARS = 32_768;

// Re-exported for backwards compatibility (tests and the manager import it from here).
export { mcpChildEnv } from './transport';

export type McpErrorCode = 'connect' | 'timeout' | 'protocol' | 'server' | 'closed' | 'disabled' | 'cancelled' | 'auth';

export class McpError extends Error {
  constructor(
    readonly code: McpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

export interface McpServerConfig {
  readonly name: string;
  /** Transport selection. Absent means stdio (backwards compatible with v2.5.1/v2.5.2). */
  readonly transport?: 'stdio' | 'streamable-http';
  /** Required for stdio; ignored for streamable-http. */
  readonly command?: string;
  readonly args?: readonly string[];
  /** Required for streamable-http; must pass https/loopback rules. Never carries credentials. */
  readonly url?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Authentication scheme declared in settings; the token itself is never in settings. */
  readonly auth?: 'none' | 'bearer';
  /**
   * Bearer token for streamable-http servers. In-memory only: fetched from
   * VS Code SecretStorage at connect time, never written to settings, logs,
   * fingerprints, or tool output.
   */
  readonly bearerToken?: string;
  readonly timeoutMs?: number;
  readonly maxToolOutputChars?: number;
}

export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface McpToolResult {
  readonly isError: boolean;
  readonly content: string;
  /** Tool output is server-controlled and untrusted; it is data, never instructions. */
  readonly untrusted: true;
  readonly truncated: boolean;
}

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

interface JsonRpcInbound {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
  readonly method?: unknown;
  readonly params?: unknown;
}

/**
 * Minimal, real MCP (Model Context Protocol) client. Two transports are
 * supported, selected per server via `McpServerConfig.transport`:
 *
 * - `stdio` (default, backwards compatible): newline-delimited JSON-RPC 2.0
 *   over the child's pipes.
 * - `streamable-http`: MCP Streamable HTTP (2025-06-18) against a single
 *   HTTPS endpoint with optional bearer authentication from SecretStorage.
 *
 * Protocol semantics are transport-agnostic and identical to v2.5.1/v2.5.2:
 * the client implements exactly the handshake and the tools surface
 * (initialize, notifications/initialized, tools/list, tools/call);
 * everything else fails closed. Server-initiated requests are answered with
 * JSON-RPC `-32601` (method not found) rather than executed or hung.
 *
 * Security boundary: a configured server (local process or remote endpoint)
 * is not trusted, sandboxed or sandboxable by this client. The protections
 * are explicit configuration approval, workspace trust, SecretStorage-backed
 * credentials, sanitized environments (stdio), TLS certificate verification
 * (http), redirect refusal, bounded frames and output, no replay of failed
 * requests and never treating server output as trusted instructions.
 */
export class McpClient {
  private transport: McpTransport | undefined;
  private connecting: Promise<void> | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private toolsCache: readonly McpTool[] | undefined;
  private notificationsReceived = 0;
  private serverInfoCache: McpServerInfo | undefined;
  private serverCapabilitiesCache: Record<string, unknown> | undefined;
  private negotiatedProtocolVersion: string | undefined;

  constructor(private readonly config: McpServerConfig) {}

  get serverName(): string {
    return this.config.name;
  }

  lastStderr(): string {
    return this.transport?.lastStderr() ?? '';
  }

  isConnected(): boolean {
    return this.transport?.isConnected() === true;
  }

  /** Number of tools served from cache after at least one listTools() call. */
  cachedToolCount(): number | undefined {
    return this.toolsCache?.length;
  }

  /** Number of notifications received from the server (diagnostics). */
  notificationCount(): number {
    return this.notificationsReceived;
  }

  /** Server info captured during initialize; undefined until a handshake succeeds. */
  serverInfo(): McpServerInfo | undefined {
    return this.serverInfoCache;
  }

  serverCapabilities(): Record<string, unknown> | undefined {
    return this.serverCapabilitiesCache;
  }

  protocolVersion(): string | undefined {
    return this.negotiatedProtocolVersion;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) {
      return;
    }
    if (this.connecting !== undefined) {
      return this.connecting;
    }
    this.connecting = this.connectWithBoundedRetry();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  /**
   * Streamable HTTP connections may retry the idempotent initialize handshake
   * once after a network failure (bounded retries with backoff). Authentication,
   * protocol and configuration failures are never retried, and tool calls are
   * never replayed.
   */
  private async connectWithBoundedRetry(): Promise<void> {
    const isStreamableHttp = this.config.transport === 'streamable-http';
    const attempts = isStreamableHttp ? STREAMABLE_HTTP_CONNECT_ATTEMPTS : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.connectOnce();
        return;
      } catch (error) {
        lastError = error;
        const code = error instanceof McpError ? error.code : undefined;
        const retriable = isStreamableHttp && code === 'connect';
        await this.close().catch(() => undefined);
        if (!retriable || attempt === attempts) {
          break;
        }
        await mcpRetrySleep(STREAMABLE_HTTP_RETRY_BACKOFF_MS);
      }
    }
    throw lastError instanceof McpError
      ? lastError
      : new McpError('connect', `The MCP server "${this.config.name}" did not complete the initialize handshake.`);
  }

  private createTransport(): McpTransport {
    if (this.config.transport === 'streamable-http') {
      const url = this.config.url;
      if (typeof url !== 'string' || url.trim().length === 0) {
        throw new McpError('disabled', 'An MCP streamable-http server requires an endpoint URL.');
      }
      return new StreamableHttpTransport({
        name: this.config.name,
        url,
        ...(this.config.bearerToken !== undefined ? { bearerToken: this.config.bearerToken } : {}),
      });
    }
    const command = this.config.command;
    if (command === undefined) {
      throw new McpError('disabled', 'The MCP server command is not a permitted executable token.');
    }
    return new StdioTransport({
      name: this.config.name,
      command,
      ...(this.config.args !== undefined ? { args: this.config.args } : {}),
      ...(this.config.env !== undefined ? { env: this.config.env } : {}),
    });
  }

  private async connectOnce(): Promise<void> {
    this.resetCaches();
    const transport = this.createTransport();
    this.transport = transport;
    await transport.open({
      onMessage: (raw) => this.onRawMessage(raw),
      onClose: (error) => this.failPending(error),
    });
    try {
      const result = await this.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'QuantsMind-VSCode-AI-Coder', version: '2.5.1' },
      });
      this.verifyInitializeResult(result);
    } catch (error) {
      await this.close();
      throw error instanceof McpError
        ? error
        : new McpError('connect', `The MCP server "${this.config.name}" did not complete the initialize handshake.`);
    }
    this.notify('notifications/initialized', {});
  }

  /** Validates the initialize result and records the negotiated protocol. */
  private verifyInitializeResult(result: unknown): void {
    if (typeof result !== 'object' || result === null) {
      throw new McpError('protocol', `The MCP server "${this.config.name}" returned an invalid initialize response.`);
    }
    const record = result as Record<string, unknown>;
    const protocolVersion = typeof record.protocolVersion === 'string' ? record.protocolVersion : undefined;
    if (
      protocolVersion !== undefined &&
      !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(protocolVersion)
    ) {
      throw new McpError(
        'protocol',
        `The MCP server "${this.config.name}" negotiated unsupported protocol version "${protocolVersion}".`,
      );
    }
    const serverInfoRaw = typeof record.serverInfo === 'object' && record.serverInfo !== null
      ? (record.serverInfo as Record<string, unknown>)
      : undefined;
    const name = typeof serverInfoRaw?.name === 'string' ? serverInfoRaw.name.slice(0, 128) : '(unnamed server)';
    const version = typeof serverInfoRaw?.version === 'string' ? serverInfoRaw.version.slice(0, 64) : 'unknown';
    this.serverInfoCache = { name, version };
    if (typeof record.capabilities === 'object' && record.capabilities !== null && !Array.isArray(record.capabilities)) {
      const serialized = JSON.stringify(record.capabilities);
      if (serialized.length > MAX_SCHEMA_CHARS) {
        throw new McpError('protocol', `The MCP server "${this.config.name}" returned oversized capabilities.`);
      }
      this.serverCapabilitiesCache = record.capabilities as Record<string, unknown>;
    } else {
      this.serverCapabilitiesCache = {};
    }
    this.negotiatedProtocolVersion = protocolVersion ?? MCP_PROTOCOL_VERSION;
  }

  async listTools(): Promise<readonly McpTool[]> {
    if (this.toolsCache !== undefined) {
      return this.toolsCache;
    }
    const result = await this.request('tools/list', {});
    const parsed = result as { tools?: unknown };
    const tools: McpTool[] = [];
    if (Array.isArray(parsed.tools)) {
      for (const raw of parsed.tools) {
        if (typeof raw !== 'object' || raw === null) {
          continue;
        }
        const record = raw as Record<string, unknown>;
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        if (name.length === 0 || name.length > 256) {
          continue;
        }
        const inputSchema = record.inputSchema;
        if (inputSchema !== undefined) {
          const serialized = JSON.stringify(inputSchema);
          if (serialized.length > MAX_SCHEMA_CHARS) {
            continue; // schema too large to trust or forward
          }
        }
        tools.push({
          name,
          ...(typeof record.description === 'string' ? { description: record.description.slice(0, 400) } : {}),
          ...(inputSchema !== undefined ? { inputSchema } : {}),
        });
      }
    }
    this.toolsCache = tools;
    return tools;
  }

  async callTool(name: string, args: unknown, maxOutputChars?: number, signal?: AbortSignal): Promise<McpToolResult> {
    const toolName = String(name ?? '').trim();
    if (toolName.length === 0 || toolName.length > 256) {
      throw new McpError('protocol', 'A tool name is required.');
    }
    if (signal?.aborted === true) {
      throw new McpError('cancelled', 'The MCP call was cancelled before it started.');
    }
    const configured = maxOutputChars ?? this.config.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
    const limit = Number.isFinite(configured)
      ? Math.max(1_000, Math.min(configured, 200_000))
      : DEFAULT_MAX_TOOL_OUTPUT_CHARS;
    const result = await this.request('tools/call', { name: toolName, arguments: args ?? {} }, signal);
    const parsed = result as { isError?: unknown; content?: unknown };
    const isError = parsed.isError === true;
    const text = this.extractText(parsed.content, limit);
    return { isError, content: text, untrusted: true, truncated: text.length >= limit };
  }

  private extractText(content: unknown, limit: number): string {
    if (typeof content === 'string') {
      return redactSecrets(content).text.slice(0, limit);
    }
    if (!Array.isArray(content)) {
      return '(no textual content returned)';
    }
    const parts: string[] = [];
    let total = 0;
    for (const entry of content) {
      if (total >= limit) {
        break;
      }
      if (typeof entry !== 'object' || entry === null) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (record.type === 'text' && typeof record.text === 'string') {
        const remaining = limit - total;
        const slice = redactSecrets(record.text).text.slice(0, remaining);
        parts.push(slice);
        total += slice.length;
      } else {
        parts.push('[non-text content]');
        total += 18;
      }
    }
    return parts.join('\n');
  }

  async close(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    this.failPending(new McpError('closed', `The MCP client for "${this.config.name}" was closed.`));
    this.resetCaches();
    if (transport !== undefined) {
      await transport.close().catch(() => undefined);
    }
  }

  private resetCaches(): void {
    this.toolsCache = undefined;
    this.serverInfoCache = undefined;
    this.serverCapabilitiesCache = undefined;
    this.negotiatedProtocolVersion = undefined;
  }

  private timeoutMs(): number {
    const configured = Number(this.config.timeoutMs);
    return Math.max(250, Math.min(Number.isFinite(configured) ? configured : DEFAULT_MCP_TIMEOUT_MS, 300_000));
  }

  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const transport = this.transport;
    if (transport === undefined || !transport.isConnected()) {
      throw new McpError('closed', `The MCP server "${this.config.name}" is not connected.`);
    }
    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = this.timeoutMs();
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError('timeout', `The MCP server "${this.config.name}" did not respond to ${method} within ${timeoutMs}ms.`));
      }, timeoutMs);
      const abortSignal = signal;
      let onAbort: (() => void) | undefined;
      if (abortSignal !== undefined) {
        const handler = (): void => {
          this.pending.delete(id);
          clearTimeout(timer);
          abortSignal.removeEventListener('abort', handler);
          this.notify('notifications/cancelled', { requestId: id, reason: 'The client cancelled the request.' });
          reject(new McpError('cancelled', `The MCP call to "${this.config.name}" was cancelled.`));
        };
        onAbort = handler;
        if (abortSignal.aborted) {
          handler();
          return;
        }
        abortSignal.addEventListener('abort', handler, { once: true });
      }
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          if (onAbort !== undefined && abortSignal !== undefined) {
            abortSignal.removeEventListener('abort', onAbort);
          }
          this.pending.delete(id);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          if (onAbort !== undefined && abortSignal !== undefined) {
            abortSignal.removeEventListener('abort', onAbort);
          }
          this.pending.delete(id);
          reject(error);
        },
      });
      transport.send(payload, { id, timeoutMs, signal, protocolVersion: this.negotiatedProtocolVersion }).catch((error: unknown) => {
        const pending = this.pending.get(id);
        if (pending === undefined) {
          return; // The timer or the abort handler already rejected this request.
        }
        clearTimeout(timer);
        if (onAbort !== undefined && abortSignal !== undefined) {
          abortSignal.removeEventListener('abort', onAbort);
        }
        this.pending.delete(id);
        pending.reject(
          error instanceof McpError
            ? error
            : new McpError('connect', `The MCP request to "${this.config.name}" failed.`),
        );
      });
    });
  }

  private notify(method: string, params: unknown): void {
    const transport = this.transport;
    if (transport === undefined || !transport.isConnected()) {
      return;
    }
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    // Notifications are best-effort; the next request surfaces problems.
    transport.send(payload, { id: null, timeoutMs: this.timeoutMs(), protocolVersion: this.negotiatedProtocolVersion }).catch(() => undefined);
  }

  private onRawMessage(raw: string): void {
    if (raw.length > MAX_MESSAGE_CHARS) {
      this.failPending(new McpError('protocol', `The MCP server "${this.config.name}" sent an oversized message; the connection was dropped.`));
      void this.close();
      return;
    }
    let message: JsonRpcInbound;
    try {
      message = JSON.parse(raw) as JsonRpcInbound;
    } catch {
      return; // Ignore non-JSON noise from the server.
    }
    this.dispatch(message);
  }

  private dispatch(message: JsonRpcInbound): void {
    if (typeof message.method === 'string' && message.method.length > 0) {
      const id = message.id;
      if (id === undefined || id === null) {
        // Server notification: received, counted, never executed.
        this.notificationsReceived += 1;
        return;
      }
      // Server-initiated request: fail closed with JSON-RPC -32601.
      if ((typeof id === 'number' && Number.isFinite(id)) || (typeof id === 'string' && id.length > 0 && id.length <= 64)) {
        this.respondError(id, -32601, 'This client does not support server-initiated requests.');
      }
      return;
    }
    if (typeof message.id !== 'number') {
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    if (message.error !== undefined && message.error !== null) {
      const record = message.error;
      const detail = typeof record.message === 'string' ? record.message.slice(0, 300) : 'unknown error';
      pending.reject(new McpError('server', `The MCP server "${this.config.name}" reported an error: ${detail}`));
      return;
    }
    pending.resolve(message.result);
  }

  /** Sends a JSON-RPC error response to a server-initiated request. */
  private respondError(id: number | string, code: number, message: string): void {
    const transport = this.transport;
    if (transport === undefined || !transport.isConnected()) {
      return;
    }
    const payload = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
    transport.send(payload, { id: null, timeoutMs: this.timeoutMs(), protocolVersion: this.negotiatedProtocolVersion }).catch(() => undefined);
  }

  private failPending(error: McpError): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
