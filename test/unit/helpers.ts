import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SettingsService } from '../../src/config/settings';
import {
  resolveAgentSettings,
  resolveCommandSettings,
  resolveMcpSettings,
  resolveContextSettings,
  resolveLanguageIntelligenceSettings,
  resolveProviderSettings,
  resolveWorkspaceSettings,
  type ResolvedProviderSettings,
} from '../../src/config/resolve';
import type { DisposableLike, CancellationTokenLike } from '../../src/providers/types';
import type { LogSink } from '../../src/security/logger';
import type { SecretStorageLike } from '../../src/security/secretStore';

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

export type MockHandler = (request: RecordedRequest, response: http.ServerResponse) => void;

export interface MockServer {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

export async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const requests: RecordedRequest[] = [];

  const server = http.createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk as Uint8Array));
    });
    incoming.on('end', () => {
      const recorded: RecordedRequest = {
        method: incoming.method ?? 'GET',
        url: incoming.url ?? '/',
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      try {
        handler(recorded, response);
      } catch (error) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
  });
  response.end(body);
}

export interface SseWriteOptions {
  readonly done?: boolean;
  readonly chunkSize?: number;
}

export function sendSse(
  response: http.ServerResponse,
  payloads: readonly unknown[],
  options: SseWriteOptions = {},
): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const parts = payloads.map(
    (payload) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`,
  );
  if (options.done !== false) {
    parts.push('data: [DONE]\n\n');
  }

  const body = parts.join('');
  const chunkSize = options.chunkSize ?? body.length;
  for (let offset = 0; offset < body.length; offset += chunkSize) {
    response.write(body.slice(offset, offset + chunkSize));
  }
  response.end();
}

export function streamFromChunks(chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index];
      index += 1;
      controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
    },
  });
}

export class TestCancellationToken implements CancellationTokenLike {
  isCancellationRequested = false;
  private readonly listeners = new Set<() => void>();

  onCancellationRequested(listener: () => void): DisposableLike {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  cancel(): void {
    if (this.isCancellationRequested) {
      return;
    }
    this.isCancellationRequested = true;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

export class MemorySecretStorage implements SecretStorageLike {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export class MemoryLogSink implements LogSink {
  readonly lines: string[] = [];

  appendLine(value: string): void {
    this.lines.push(value);
  }

  get text(): string {
    return this.lines.join('\n');
  }
}

export function createSettings(
  overrides: Partial<ResolvedProviderSettings> = {},
): SettingsService {
  const provider = { ...resolveProviderSettings({}), ...overrides };

  return {
    getProviderSettings: () => provider,
    getContextSettings: () => resolveContextSettings({}),
    getWorkspaceSettings: () => resolveWorkspaceSettings({}),
    getAgentSettings: () => resolveAgentSettings({}),
    getCommandSettings: () => resolveCommandSettings({}),
    getMcpSettings: () => resolveMcpSettings({}),
    getLanguageIntelligenceSettings: () => resolveLanguageIntelligenceSettings({}),
    setMcpServers: async () => undefined,
    updateModel: async () => undefined,
    updateProviderType: async () => undefined,
    updateBaseUrl: async () => undefined,
    onDidChange: () => ({ dispose: () => undefined }),
  };
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition.');
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
