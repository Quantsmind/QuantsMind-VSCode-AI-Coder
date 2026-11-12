/**
 * MCP transport implementations.
 *
 * The transport layer owns the wire I/O for each connection; `McpClient`
 * owns protocol semantics (JSON-RPC 2.0 request/response correlation, the
 * initialize handshake, capability negotiation, output clamping). This
 * keeps the stdio implementation byte-compatible with v2.5.1/v2.5.2 while
 * adding the MCP Streamable HTTP transport behind the same interface.
 *
 * Streamable HTTP notes (MCP 2025-06-18):
 * - Every JSON-RPC message is POSTed to the configured endpoint with
 *   `Accept: application/json, text/event-stream`.
 * - The server answers either with a single `application/json` body or with
 *   a `text/event-stream` in which each `data:` block carries one JSON-RPC
 *   message (notifications mixed with the actual response are supported).
 * - If the server issues an `Mcp-Session-Id` header (on the initialize
 *   response), it is captured and echoed on all subsequent requests together
 *   with `MCP-Protocol-Version`.
 * - A `404` for a request made with a session id terminates the session;
 *   the transport drops it and the client fails pending requests. The next
 *   operation initializes a fresh session. Requests are never replayed.
 * - Redirects are refused (`redirect: 'error'`); the endpoint cannot be used
 *   to bounce the client to an unreviewed host.
 * - Responses are read with a hard byte cap; oversized bodies drop the
 *   connection with a protocol error.
 * - `DELETE` with the session id terminates the session on `close()`;
 *   it is best-effort and bounded.
 * - TLS certificate verification is never disabled.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { redactSecrets } from '../security/redact';
import { parseMcpEndpoint } from './endpoint';
import {
  McpError,
  DEFAULT_MCP_TIMEOUT_MS,
  MAX_MESSAGE_CHARS,
  MAX_STDERR_CHARS,
} from './client';

export type McpTransportKind = 'stdio' | 'streamable-http';

export interface McpTransportHandlers {
  /** Delivers one complete JSON-RPC message (unparsed text). */
  readonly onMessage: (raw: string) => void;
  /** Fires once when the underlying connection dies; pending requests must fail. */
  readonly onClose: (error: McpError) => void;
}

/**
 * Hard cap for remote (Streamable HTTP) MCP calls and the effective timeout shown in errors.
 * Evaluated lazily: transport.ts and client.ts import each other (error class /
 * timeout constant), so reading the constant only at call time avoids a stale
 * binding when this module loads first.
 */
function maxHttpTimeoutMs(): number {
  return DEFAULT_MCP_TIMEOUT_MS * 30;
}

function httpTimeoutMs(configured: number | undefined): number {
  return Number.isFinite(configured) && (configured as number) > 0
    ? Math.min(configured as number, maxHttpTimeoutMs())
    : DEFAULT_MCP_TIMEOUT_MS;
}

export interface McpSendContext {
  /** JSON-RPC request id; null for notifications. */
  readonly id: number | null;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Negotiated protocol version; sent as MCP-Protocol-Version when set. */
  readonly protocolVersion?: string;
}

export interface McpTransport {
  readonly kind: McpTransportKind;
  /** Validates the configuration and attaches the message handlers. */
  open(handlers: McpTransportHandlers): Promise<void>;
  send(message: string, context: McpSendContext): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
  lastStderr(): string;
}

const FORBIDDEN_IN_COMMAND = /["';&|<>$`(){}[\]*?!^~%\r\n\0]/;
export const MAX_HTTP_BODY_BYTES = 4_000_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const DELETE_TIMEOUT_MS = 2_000;

const ENV_INHERITED = new Set(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TERM']);

/** Builds the sanitized child environment for an MCP server; never inherits secrets. */
export function mcpChildEnv(override?: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && ENV_INHERITED.has(key)) {
      env[key] = value;
    }
  }
  // Deterministic line-delimited JSON-RPC over pipes.
  env.MCP_CLIENT = 'QuantsMind-VSCode-AI-Coder';
  return { ...env, ...(override ?? {}) };
}

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

/**
 * Newline-delimited JSON-RPC over the child's stdin/stdout. This is the
 * exact v2.5.1/v2.5.2 wire behavior; only the bookkeeping moved.
 */
export class StdioTransport implements McpTransport {
  readonly kind = 'stdio' as const;
  private child: ChildProcess | undefined;
  private handlers: McpTransportHandlers | undefined;
  private buffer = '';
  private stderrBuffer = '';
  private failed = false;
  private readonly config: { name: string; command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> };

  constructor(config: { name: string; command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }) {
    this.config = config;
  }

  isConnected(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null;
  }

  lastStderr(): string {
    return this.stderrBuffer;
  }

  open(handlers: McpTransportHandlers): Promise<void> {
    this.handlers = handlers;
    const command = this.config.command;
    if (
      command.length === 0 ||
      command.length > 260 ||
      command !== command.trim() ||
      FORBIDDEN_IN_COMMAND.test(command)
    ) {
      throw new McpError('disabled', 'The MCP server command is not a permitted executable token.');
    }
    const args = [...(this.config.args ?? [])];
    if (args.some((arg) => arg.includes('\0'))) {
      throw new McpError('disabled', 'The MCP server arguments contain a null byte.');
    }

    this.buffer = '';
    this.stderrBuffer = '';
    this.failed = false;

    const child = spawn(command, args, {
      env: mcpChildEnv(this.config.env),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer | string) => this.onStdout(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (this.stderrBuffer.length < MAX_STDERR_CHARS) {
        this.stderrBuffer = (this.stderrBuffer + chunk.toString('utf8')).slice(0, MAX_STDERR_CHARS);
      }
    });
    child.on('error', () => {
      this.fail(new McpError('connect', `Could not start the MCP server "${this.config.name}".`));
    });
    child.on('exit', (code) => {
      this.fail(new McpError('closed', `The MCP server "${this.config.name}" exited (code ${String(code)}).`));
    });
    return Promise.resolve();
  }

  send(message: string): Promise<void> {
    const child = this.child;
    if (child === undefined || !this.isConnected()) {
      return Promise.reject(new McpError('closed', `The MCP server "${this.config.name}" is not connected.`));
    }
    const stdin = child.stdin;
    if (stdin === undefined || stdin === null || stdin.destroyed) {
      return Promise.reject(new McpError('closed', `The MCP server "${this.config.name}" is not connected.`));
    }
    // A server that dies mid-write must not surface an unhandled stream
    // 'error' event into the extension host; both the callback and the
    // one-shot error listener funnel into the same rejection.
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (error?: Error | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        stdin.removeListener('error', onError);
        if (error) {
          reject(
            new McpError('protocol', `Could not write to the MCP server "${this.config.name}": ${error.message}`),
          );
          return;
        }
        resolve();
      };
      const onError = (error: Error): void => done(error);
      stdin.once('error', onError);
      try {
        stdin.write(`${message}\n`, done);
      } catch (error) {
        done(error instanceof Error ? error : new Error('write failed'));
      }
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill();
      // Give the server a bounded grace period to exit, then force-kill.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Process already gone.
          }
          resolve();
        }, 500);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.buffer = '';
  }

  private fail(error: McpError, options: { kill: boolean } = { kill: false }): void {
    if (this.failed) {
      return; // 'exit' and 'error' may both fire; only report once
    }
    this.failed = true;
    const child = this.child;
    this.child = undefined;
    this.handlers?.onClose(error);
    if (options.kill && child !== undefined) {
      try {
        child.kill();
      } catch {
        // Child already gone.
      }
    }
  }

  private onStdout(chunk: Buffer | string): void {
    this.buffer += chunk.toString('utf8');
    if (this.buffer.length > MAX_MESSAGE_CHARS) {
      this.buffer = '';
      this.fail(new McpError('protocol', `The MCP server "${this.config.name}" sent an oversized message; the connection was dropped.`), { kill: true });
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) {
        return;
      }
      const raw = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (raw.length === 0) {
        continue;
      }
      this.handlers?.onMessage(raw);
    }
  }
}

// ---------------------------------------------------------------------------
// Streamable HTTP
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * MCP Streamable HTTP transport (single endpoint; JSON or SSE responses).
 * Stateless between requests apart from the negotiated session id.
 */
export class StreamableHttpTransport implements McpTransport {
  readonly kind = 'streamable-http' as const;
  private handlers: McpTransportHandlers | undefined;
  private connected = false;
  private closed = false;
  private sessionId: string | undefined;
  private url: string;
  private readonly token: string | undefined;

  constructor(config: { name: string; url: string; bearerToken?: string }) {
    this.url = config.url;
    this.token = config.bearerToken;
  }

  isConnected(): boolean {
    return this.connected && !this.closed;
  }

  lastStderr(): string {
    return '';
  }

  open(handlers: McpTransportHandlers): Promise<void> {
    this.handlers = handlers;
    this.sessionId = undefined;
    const parsed = parseMcpEndpoint(this.url);
    if (!parsed.ok) {
      throw new McpError('disabled', `The MCP endpoint for this server is not permitted: ${parsed.error}`);
    }
    this.url = parsed.url;
    this.connected = true;
    this.closed = false;
    return Promise.resolve();
  }

  async close(): Promise<void> {
    const sessionId = this.sessionId;
    this.sessionId = undefined;
    this.connected = false;
    this.closed = true;
    if (sessionId === undefined) {
      return;
    }
    // Best-effort session termination (MCP: client sends DELETE with the session id).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELETE_TIMEOUT_MS);
    try {
      await fetch(this.url, {
        method: 'DELETE',
        headers: this.buildHeaders(undefined, true),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      // Session termination is best-effort; failure to delete is not an error.
    } finally {
      clearTimeout(timer);
    }
  }

  async send(message: string, context: McpSendContext): Promise<void> {
    if (!this.isConnected()) {
      throw new McpError('closed', 'The MCP server is not connected.');
    }
    const controller = new AbortController();
    const timeoutMs = httpTimeoutMs(context.timeoutMs);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let onRequestAbort: (() => void) | undefined;
    if (context.signal !== undefined) {
      const handler = (): void => controller.abort();
      context.signal.addEventListener('abort', handler, { once: true });
      onRequestAbort = () => context.signal?.removeEventListener('abort', handler);
      if (context.signal.aborted) {
        handler();
      }
    }
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: this.buildHeaders(context.protocolVersion, false),
        body: message,
        redirect: 'error',
        signal: controller.signal,
      });
      await this.handleResponse(response, context);
    } catch (error) {
      this.raiseFetchError(error, context);
    } finally {
      clearTimeout(timer);
      onRequestAbort?.();
    }
  }

  private buildHeaders(protocolVersion: string | undefined, forClose: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    if (this.sessionId !== undefined) {
      headers['mcp-session-id'] = this.sessionId;
    }
    if (protocolVersion !== undefined && !forClose) {
      headers['mcp-protocol-version'] = protocolVersion;
    }
    if (this.token !== undefined && this.token.length > 0) {
      headers.authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  private scrub(text: string): string {
    const redacted = redactSecrets(text).text;
    if (this.token === undefined || this.token.length === 0) {
      return redacted;
    }
    return redacted.split(this.token).join('[redacted]');
  }

  private captureSessionHeader(response: Response): void {
    const header = response.headers.get('mcp-session-id');
    if (header === null) {
      return;
    }
    const value = header.trim();
    if (!SESSION_ID_PATTERN.test(value)) {
      const error = new McpError('protocol', 'The MCP server issued an invalid session identifier; the connection was dropped.');
      this.dropConnection(error);
      throw error;
    }
    this.sessionId = value;
  }

  /**
   * Terminates the HTTP connection: unrecoverable transport/session failures
   * drop every in-flight request and force the next operation to
   * re-initialize. Requests are never replayed.
   */
  private dropConnection(error: McpError): void {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.sessionId = undefined;
    this.handlers?.onClose(error);
  }

  private async readBodyCapped(response: Response): Promise<string> {
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_HTTP_BODY_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      const error = new McpError('protocol', 'The MCP server sent an oversized response; the connection was dropped.');
      this.dropConnection(error);
      throw error;
    }
    const body = response.body;
    if (body === null) {
      return '';
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_HTTP_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        const error = new McpError('protocol', 'The MCP server sent an oversized response; the connection was dropped.');
        this.dropConnection(error);
        throw error;
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8').decode(merged);
  }

  private async handleResponse(response: Response, context: McpSendContext): Promise<void> {
    this.captureSessionHeader(response);
    const status = response.status;

    if (status === 202 || status === 204) {
      return; // Notification accepted; no body by design.
    }

    if (status === 401 || status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpError('auth', `The MCP server rejected the request credentials (HTTP ${status}). Check the stored bearer credential.`);
    }

    if (status === 404 && this.sessionId !== undefined) {
      // The session expired. Drop it and mark the connection dead; the client
      // fails pending requests and the next operation initializes a fresh session.
      const error = new McpError('closed', 'The MCP session expired (HTTP 404); the next operation will establish a new session.');
      this.dropConnection(error);
      throw new McpError('closed', 'The MCP session expired (HTTP 404); reconnect to the server.');
    }

    if (status < 200 || status >= 300) {
      const snippet = await this.safeSnippet(response);
      if (status >= 500) {
        const error = new McpError('connect', `The MCP server is unavailable (HTTP ${status}).${snippet}`);
        this.dropConnection(error);
        throw error;
      }
      throw new McpError('server', `The MCP server rejected the request (HTTP ${status}).${snippet}`);
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const text = await this.readBodyCapped(response);

    if (contentType.includes('text/event-stream')) {
      this.dispatchEventStream(text);
      return;
    }

    // application/json (or any JSON content type): a single message.
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return; // No content; nothing to dispatch.
    }
    this.onMessage(trimmed);
    void context;
  }

  private async safeSnippet(response: Response): Promise<string> {
    try {
      const text = await this.readBodyCapped(response);
      const flat = this.scrub(text).replace(/\s+/g, ' ').trim().slice(0, 200);
      return flat.length > 0 ? ` ${flat}` : '';
    } catch {
      return '';
    }
  }

  private dispatchEventStream(body: string): void {
    const events = parseSseDataBlocks(body);
    for (const data of events) {
      if (data.length === 0 || data.length > MAX_MESSAGE_CHARS) {
        continue;
      }
      this.onMessage(data);
    }
  }

  private onMessage(raw: string): void {
    this.handlers?.onMessage(raw);
  }

  private raiseFetchError(error: unknown, context: McpSendContext): never {
    if (error instanceof McpError) {
      throw error;
    }
    const aborted = (error as { name?: unknown })?.name === 'AbortError';
    if (aborted) {
      if (context.signal?.aborted === true) {
        throw new McpError('cancelled', 'The MCP call was cancelled.');
      }
      throw new McpError('timeout', `The MCP server did not respond within ${Math.round(httpTimeoutMs(context.timeoutMs))}ms.`);
    }
    const raw = error instanceof Error ? error.message : String(error);
    const cause = (error as { cause?: unknown })?.cause;
    const causeMessage = cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : '';
    const detail = this.scrub(`${raw}${causeMessage.length > 0 ? ` ${causeMessage}` : ''}`).slice(0, 200);
    const redirectRefused = /redirect/i.test(detail);
    if (redirectRefused) {
      throw new McpError('protocol', 'The MCP endpoint attempted a redirect; it was refused for security. Update the endpoint to the final URL.');
    }
    const wrapped = new McpError('connect', `Could not reach the MCP server.${detail.length > 0 ? ` ${detail}` : ''}`);
    // Network-level failure: the connection cannot be reused safely.
    this.dropConnection(wrapped);
    throw wrapped;
  }
}

/**
 * Splits an SSE body into the payloads of its `data:` fields. Handles CRLF
 * and LF, multi-line data fields (joined with "\n"), and comment/heartbeat
 * lines (ignored). Bounded: callers enforce a total byte cap upstream and
 * per-message caps downstream.
 */
export function parseSseDataBlocks(body: string): string[] {
  const events: string[] = [];
  const normalized = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const block of normalized.split('\n\n')) {
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        continue; // comment / heartbeat
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
      }
    }
    if (dataLines.length > 0) {
      events.push(dataLines.join('\n'));
    }
  }
  return events;
}

/** Bounded retry for idempotent connection establishment only (never for tool calls). */
export const STREAMABLE_HTTP_CONNECT_ATTEMPTS = 2;
export const STREAMABLE_HTTP_RETRY_BACKOFF_MS = 750;

export { sleep as mcpRetrySleep };
