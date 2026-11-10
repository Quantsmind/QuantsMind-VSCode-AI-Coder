/**
 * Shared integration-test infrastructure for the Whole-Product Integration
 * Qualification (WPIQ). Provides disposable workspace fixtures, mock provider
 * servers, service harnesses, and lifecycle helpers used across WP1-WP5.
 *
 * No product source code is modified by this file.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MemoryLogSink,
  MemorySecretStorage,
  startMockServer,
  sendJson,
  sendSse,
  type MockHandler,
  type MockServer,
  type RecordedRequest,
  waitFor,
  delay,
} from '../unit/helpers';

/**
 * Creates a temporary workspace directory with disposable files for coding
 * workflow tests. The directory is removed when `dispose()` is called.
 */
export class DisposableWorkspaceFixture {
  readonly root: string;
  private disposed = false;

  constructor(name = 'wpiq-fixture') {
    this.root = path.join(os.tmpdir(), `quantsmind-wpiq-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  async create(): Promise<string> {
    await fs.mkdir(this.root, { recursive: true });
    return this.root;
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = path.join(this.root, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf8');
  }

  async readFile(relativePath: string): Promise<string> {
    return fs.readFile(path.join(this.root, relativePath), 'utf8');
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.root, relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      await fs.rm(this.root, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}

/**
 * Captures HTTP requests made to a mock provider. Useful for verifying request
 * bodies, headers, query parameters, and authentication without contacting
 * real paid providers.
 */
export class MockProviderServer {
  readonly server: MockServer;
  readonly requests: RecordedRequest[];

  private constructor(server: MockServer) {
    this.server = server;
    this.requests = server.requests;
  }

  static async create(handler: MockHandler): Promise<MockProviderServer> {
    const server = await startMockServer(handler);
    return new MockProviderServer(server);
  }

  async close(): Promise<void> {
    await this.server.close();
  }

  lastRequest(): RecordedRequest | undefined {
    return this.server.requests[this.server.requests.length - 1];
  }

  requestsMatching(method: string, pathContains: string): RecordedRequest[] {
    return this.server.requests.filter(
      (r: RecordedRequest) => r.method === method && r.url.includes(pathContains),
    );
  }
}

/**
 * Standard mock handlers for common provider behaviors.
 */
export class MockProviderHandlers {
  /** Returns an OpenAI-compatible /models list with a single free model. */
  static openAiModels(models: readonly string[] = ['gpt-4o-mini']): MockHandler {
    return (_request, response) => {
      sendJson(response, 200, {
        object: 'list',
        data: models.map((id) => ({ id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'test' })),
      });
    };
  }

  /** Returns a successful non-streaming completion. */
  static openAiCompletion(text = 'mock completion response'): MockHandler {
    return (_request, response) => {
      sendJson(response, 200, {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    };
  }

  /** Returns HTTP 401 authentication failure. */
  static authenticationFailed(message = 'Incorrect API key provided.'): MockHandler {
    return (_request, response) => {
      sendJson(response, 401, {
        error: { message, type: 'invalid_request_error', param: null, code: 401 },
      });
    };
  }

  /** Returns HTTP 402 quota exhaustion. */
  static quotaExhausted(message = 'You exceeded your current quota.'): MockHandler {
    return (_request, response) => {
      sendJson(response, 402, {
        error: { message, type: 'insufficient_quota', param: null, code: 402 },
      });
    };
  }

  /** Returns HTTP 429 rate limit. */
  static rateLimited(message = 'Rate limit reached.'): MockHandler {
    return (_request, response) => {
      sendJson(response, 429, {
        error: { message, type: 'rate_limit_error', param: null, code: 429 },
      });
    };
  }

  /** Returns HTTP 500 server error. */
  static serverError(message = 'Internal server error.'): MockHandler {
    return (_request, response) => {
      sendJson(response, 500, {
        error: { message, type: 'server_error', param: null, code: 500 },
      });
    };
  }

  /** Streams SSE completion deltas then [DONE]. */
  static streamingCompletion(chunks: readonly string[] = ['Hello', ' world']): MockHandler {
    return (_request, response) => {
      sendSse(response, chunks.map((c) => ({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: c } }] })));
    };
  }
}

/**
 * Helper for asserting that credentials never appear in text output.
 */
export function assertNoCredentialLeak(text: string, secret: string): void {
  if (secret.length === 0) {
    return;
  }
  const lower = text.toLowerCase();
  const secretLower = secret.toLowerCase();
  // Check for the full secret appearing verbatim.
  if (text.includes(secret)) {
    throw new Error(`Credential leak detected: full secret appears in text.`);
  }
  // Check for masked/partial key fragments.
  if (lower.includes(secretLower.slice(0, 8))) {
    throw new Error(`Credential leak detected: secret prefix appears in text.`);
  }
}

/**
 * Waits for a condition to become true within a timeout, throwing if it never
 * does. Re-exported from unit helpers for convenience.
 */
export { waitFor, delay, MemoryLogSink, MemorySecretStorage, startMockServer, sendJson, sendSse, type MockHandler, type MockServer, type RecordedRequest };

/**
 * Creates a minimal in-memory SecretStorage-like implementation for unit-style
 * tests that do not run inside the VS Code extension host.
 */
export function createMemorySecretStorage(): MemorySecretStorage {
  return new MemorySecretStorage();
}

/**
 * Creates a minimal in-memory log sink for capturing logger output.
 */
export function createMemoryLogSink(): MemoryLogSink {
  return new MemoryLogSink();
}
