import { spawn, type ChildProcess } from 'node:child_process';
import { redactSecrets } from '../security/redact';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const DEFAULT_MCP_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 20_000;
export const MAX_STDERR_CHARS = 4_000;

export type McpErrorCode = 'connect' | 'timeout' | 'protocol' | 'server' | 'closed' | 'disabled';

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
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
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

/**
 * Executable tokens must avoid shell metacharacters. Spaces are allowed
 * (Windows install paths contain them) as long as no word contains a
 * shell-special character.
 */
const FORBIDDEN_IN_COMMAND = /["';&|<>$`(){}[\]*?!^~%\r\n\0]/;
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

interface JsonRpcResponse {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

/**
 * Minimal, real MCP (Model Context Protocol) client over stdio using
 * newline-delimited JSON-RPC 2.0. It implements exactly the handshake and
 * the tools surface: initialize, notifications/initialized, tools/list and
 * tools/call. Everything else fails closed.
 *
 * Every tool result is marked untrusted: the output of an external process
 * is data, and it is never interpreted as instructions.
 */
export class McpClient {
  private child: ChildProcess | undefined;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private toolsCache: readonly McpTool[] | undefined;
  private stderrBuffer = '';

  constructor(private readonly config: McpServerConfig) {}

  get serverName(): string {
    return this.config.name;
  }

  lastStderr(): string {
    return this.stderrBuffer;
  }

  isConnected(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) {
      return;
    }
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
    this.toolsCache = undefined;

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
      this.failPending(new McpError('connect', `Could not start the MCP server "${this.config.name}".`));
    });
    child.on('exit', (code) => {
      this.failPending(new McpError('closed', `The MCP server "${this.config.name}" exited (code ${String(code)}).`));
    });

    try {
      await this.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'QuantsMind-VSCode-AI-Coder', version: '2.5.0' },
      });
    } catch (error) {
      await this.close();
      throw error instanceof McpError
        ? error
        : new McpError('connect', `The MCP server "${this.config.name}" did not complete the initialize handshake.`);
    }
    this.notify('notifications/initialized', {});
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
        tools.push({
          name,
          ...(typeof record.description === 'string' ? { description: record.description.slice(0, 400) } : {}),
          ...(record.inputSchema !== undefined ? { inputSchema: record.inputSchema } : {}),
        });
      }
    }
    this.toolsCache = tools;
    return tools;
  }

  async callTool(name: string, args: unknown, maxOutputChars?: number): Promise<McpToolResult> {
    const toolName = String(name ?? '').trim();
    if (toolName.length === 0 || toolName.length > 256) {
      throw new McpError('protocol', 'A tool name is required.');
    }
    const limit = Math.max(1_000, Math.min(maxOutputChars ?? this.config.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS, 200_000));
    const result = await this.request('tools/call', { name: toolName, arguments: args ?? {} });
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
    const child = this.child;
    this.child = undefined;
    this.failPending(new McpError('closed', `The MCP client for "${this.config.name}" was closed.`));
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
  }

  private timeoutMs(): number {
    const configured = Number(this.config.timeoutMs);
    return Math.max(250, Math.min(Number.isFinite(configured) ? configured : DEFAULT_MCP_TIMEOUT_MS, 300_000));
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (child === undefined || !this.isConnected()) {
      throw new McpError('closed', `The MCP server "${this.config.name}" is not connected.`);
    }
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError('timeout', `The MCP server "${this.config.name}" did not respond to ${method} within ${this.timeoutMs()}ms.`));
      }, this.timeoutMs());
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        },
      });
      try {
        child.stdin?.write(`${payload}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new McpError('protocol', `Could not write to the MCP server "${this.config.name}": ${error instanceof Error ? error.message : 'write failed'}`));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    try {
      this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {
      // Notifications are best-effort; the next request will surface problems.
    }
  }

  private onStdout(chunk: Buffer | string): void {
    this.buffer += chunk.toString('utf8');
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
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(raw) as JsonRpcResponse;
      } catch {
        continue; // Ignore non-JSON noise from the server.
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: JsonRpcResponse): void {
    if (typeof message.id !== 'number') {
      return; // Notifications from the server carry no id; we do not use them yet.
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

  private failPending(error: McpError): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
