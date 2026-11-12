import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { expect } from 'chai';
import * as vscode from 'vscode';
import { ChangeService } from '../../src/changes/changeService';
import { ChangeHistoryStore } from '../../src/changes/history';
import { ChatViewProvider } from '../../src/chat/chatViewProvider';
import { createAgentRuntime } from '../../src/agent/runtime';
import { ConversationStore } from '../../src/chat/persistence';
import type { HostToWebviewMessage } from '../../src/chat/protocol';
import type { ResolvedProviderSettings } from '../../src/config/resolve';
import { SettingsService } from '../../src/config/settings';
import { ContextService } from '../../src/context/contextService';
import { CompletionService } from '../../src/providers/completionService';
import { resolveProviderSettings } from '../../src/config/resolve';
import { getProviderProfile, providerAdapterForType } from '../../src/providers/profiles';
import { Logger } from '../../src/security/logger';
import { LEGACY_API_KEY_SECRET_KEY, SecretStore } from '../../src/security/secretStore';
import { WorkspaceIndexService } from '../../src/workspace/indexService';
import {
  MemoryLogSink,
  MemorySecretStorage,
  createSettings,
  sendJson,
  sendSse,
  startMockServer,
  waitFor,
} from '../unit/helpers';

const TEST_KEY = 'sk-integration-0000000000000000';

class FakeWebview {
  readonly posted: HostToWebviewMessage[] = [];
  html = '';
  options: vscode.WebviewOptions = {};
  readonly cspSource = 'https://test.csp';
  private listener: ((message: unknown) => void) | undefined;

  asWebviewUri(uri: vscode.Uri): vscode.Uri {
    return uri;
  }

  onDidReceiveMessage(listener: (message: unknown) => void): vscode.Disposable {
    this.listener = listener;
    return {
      dispose: () => {
        this.listener = undefined;
      },
    };
  }

  async postMessage(message: unknown): Promise<boolean> {
    this.posted.push(message as HostToWebviewMessage);
    return true;
  }

  emit(message: unknown): void {
    this.listener?.(message);
  }

  count(type: HostToWebviewMessage['type']): number {
    return this.posted.filter((message) => message.type === type).length;
  }

  has(type: HostToWebviewMessage['type']): boolean {
    return this.count(type) > 0;
  }

  last<T extends HostToWebviewMessage['type']>(
    type: T,
  ): Extract<HostToWebviewMessage, { type: T }> | undefined {
    for (let index = this.posted.length - 1; index >= 0; index -= 1) {
      const message = this.posted[index];
      if (message.type === type) {
        return message as Extract<HostToWebviewMessage, { type: T }>;
      }
    }
    return undefined;
  }
}

class FakeWebviewView {
  constructor(readonly webview: FakeWebview) {}
  onDidDispose(): vscode.Disposable {
    return { dispose: () => undefined };
  }
}

function workspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return join(__dirname, '..', '..');
}

function extensionUri(): vscode.Uri {
  const ext = vscode.extensions.getExtension('quantsmind.quantsmind-vscode-ai-coder');
  if (ext !== undefined) {
    return ext.extensionUri;
  }
  return vscode.Uri.file(join(tmpdir(), 'quantsmind-test-ext'));
}

function createHarness(
  settingsOverrides: Partial<ResolvedProviderSettings>,
  withKey = true,
): { provider: ChatViewProvider; webview: FakeWebview; sink: MemoryLogSink; storage: MemorySecretStorage } {
  const storage = new MemorySecretStorage();
  if (withKey) {
    storage.values.set('quantsmind.provider.openai-compatible.apiKey', TEST_KEY);
  }
  const sink = new MemoryLogSink();
  const logger = new Logger(sink);
  const secrets = new SecretStore(storage);
  const settings = createSettings({ model: 'test-model', ...settingsOverrides });
  const completion = new CompletionService(secrets, settings, logger);
  const contextService = new ContextService(new SettingsService());
  const memento = new Map<string, unknown>();
  const mementoLike = {
    get: (key: string) => memento.get(key),
    update: async (key: string, value: unknown) => {
      memento.set(key, value);
    },
  } as unknown as vscode.Memento;
  const conversations = new ConversationStore(mementoLike);
  const provider = new ChatViewProvider({
    extensionUri: extensionUri(),
    completion,
    contextService,
    secrets,
    settings,
    logger,
    version: '0.2.0',
    conversations,
    workspaceIndex: new WorkspaceIndexService(settings, logger),
    changeService: new ChangeService(
      settings,
      new ChangeHistoryStore(mementoLike),
      vscode.Uri.file(join(tmpdir(), 'quantsmind-test-backups')),
      logger,
    ),
    agentRuntime: createAgentRuntime({
      completion,
      settings,
      secrets,
      logger,
      workspaceIndex: new WorkspaceIndexService(settings, logger),
      changeService: new ChangeService(
        settings,
        new ChangeHistoryStore(mementoLike),
        vscode.Uri.file(join(tmpdir(), 'quantsmind-test-backups')),
        logger,
      ),
      sessionStore: mementoLike,
      isTrusted: () => vscode.workspace.isTrusted,
    }),
  });

  const webview = new FakeWebview();
  const view = new FakeWebviewView(webview);
  const tokenSource = new vscode.CancellationTokenSource();
  provider.resolveWebviewView(
    view as unknown as vscode.WebviewView,
    {} as vscode.WebviewViewResolveContext,
    tokenSource.token,
  );
  tokenSource.dispose();

  return { provider, webview, sink, storage };
}

async function markReady(webview: FakeWebview): Promise<void> {
  webview.emit({ type: 'ready' });
  await waitFor(() => webview.has('init'));
}

suite('provider profiles integration (C)', () => {
  test('provider profile selection resolves defaults', () => {
    expect(providerAdapterForType('ollama')).to.equal('openai-compatible');
    expect(providerAdapterForType('gemini')).to.equal('gemini');
    const resolved = resolveProviderSettings({ type: 'groq' });
    expect(resolved.baseUrl).to.equal('https://api.groq.com/openai/v1');
    expect(getProviderProfile('groq')?.displayName).to.equal('Groq');
  });

  test('provider configuration resolution uses profile defaults', async () => {
    const { webview } = createHarness({ type: 'ollama', baseUrl: 'http://localhost:11434/v1' });
    await markReady(webview);
    const init = webview.last('init');
    expect(init?.status.providerType).to.equal('ollama');
  });

  test('credential retrieval for selected profile is isolated', async () => {
    const { storage } = createHarness({ type: 'openai' }, false);
    storage.values.set('quantsmind.provider.openai.apiKey', TEST_KEY);
    storage.values.set(LEGACY_API_KEY_SECRET_KEY, 'sk-should-not-be-inherited');
    const base = new SecretStore(storage);
    expect(await base.forProvider('openai').get()).to.equal(TEST_KEY);
    expect(await base.forProvider('groq').get()).to.equal(undefined);
    storage.values.set('quantsmind.provider.groq.apiKey', 'gsk-groq');
    expect(await base.forProvider('groq').get()).to.equal('gsk-groq');
  });

  test('connection test command succeeds against mocked endpoint', async () => {
    const server = await startMockServer((_incoming, response) => {
      if (response.req?.url?.includes('/models')) {
        sendJson(response, 200, { data: [{ id: 'test-model' }] });
        return;
      }
      sendJson(response, 200, { choices: [{ message: { content: 'Hi' } }] });
    });
    try {
      const storage = new MemorySecretStorage();
      storage.values.set('quantsmind.provider.openai-compatible.apiKey', TEST_KEY);
      const sink = new MemoryLogSink();
      const logger = new Logger(sink);
      const secrets = new SecretStore(storage);
      const settings = createSettings({ baseUrl: server.baseUrl, stream: false });
      const completion = new CompletionService(secrets, settings, logger);
      const result = await completion.testConnection();
      expect(result.code).to.equal('success');
      expect(result.discoveryAvailable).to.equal(true);
      expect(sink.text).to.not.contain(TEST_KEY);
    } finally {
      await server.close();
    }
  });

  test('model discovery succeeds via completion service', async () => {
    const server = await startMockServer((_incoming, response) => {
      sendJson(response, 200, { data: [{ id: 'm1' }, { id: 'm2' }] });
    });
    try {
      const storage = new MemorySecretStorage();
      storage.values.set('quantsmind.provider.openai-compatible.apiKey', TEST_KEY);
      const service = new CompletionService(
        new SecretStore(storage),
        createSettings({ baseUrl: server.baseUrl }),
        new Logger(new MemoryLogSink()),
      );
      const discovery = await service.listModels();
      expect(discovery.status).to.equal('available');
      expect(discovery.models).to.deep.equal(['m1', 'm2']);
      expect(discovery.source).to.equal('discovered');
    } finally {
      await server.close();
    }
  });

  test('completion dispatch uses profile endpoint and credential', async () => {
    const server = await startMockServer((_incoming, response) => {
      sendJson(response, 200, { choices: [{ message: { content: 'ok' } }] });
    });
    try {
      const storage = new MemorySecretStorage();
      storage.values.set('quantsmind.provider.openai-compatible.apiKey', TEST_KEY);
      const service = new CompletionService(
        new SecretStore(storage),
        createSettings({ baseUrl: server.baseUrl, stream: false }),
        new Logger(new MemoryLogSink()),
      );
      const result = await service.complete([{ role: 'user', content: 'Hi' }]);
      expect(result.text).to.equal('ok');
      expect(server.requests[0].headers.authorization).to.equal(`Bearer ${TEST_KEY}`);
    } finally {
      await server.close();
    }
  });

  test('streaming lifecycle delivers deltas and cleanup', async () => {
    const server = await startMockServer((_incoming, response) => {
      sendSse(response, [
        { choices: [{ delta: { content: 'A' } }] },
        { choices: [{ delta: { content: 'B' }, finish_reason: 'stop' }] },
      ]);
    });
    try {
      const storage = new MemorySecretStorage();
      storage.values.set('quantsmind.provider.openai-compatible.apiKey', TEST_KEY);
      const service = new CompletionService(
        new SecretStore(storage),
        createSettings({ baseUrl: server.baseUrl, stream: true }),
        new Logger(new MemoryLogSink()),
      );
      const deltas: string[] = [];
      const result = await service.complete([{ role: 'user', content: 'Hi' }], {
        onDelta: (d) => deltas.push(d),
      });
      expect(result.text).to.equal('AB');
      expect(deltas).to.deep.equal(['A', 'B']);
    } finally {
      await server.close();
    }
  });

  test('cancellation propagation reaches the provider request', async () => {
    const server = await startMockServer(() => {
      // never respond
    });
    try {
      const storage = new MemorySecretStorage();
      storage.values.set('quantsmind.provider.openai-compatible.apiKey', TEST_KEY);
      const service = new CompletionService(
        new SecretStore(storage),
        createSettings({ baseUrl: server.baseUrl }),
        new Logger(new MemoryLogSink()),
      );
      const controller = new vscode.CancellationTokenSource();
      const pending = service.complete([{ role: 'user', content: 'Hi' }], {
        token: {
          isCancellationRequested: controller.token.isCancellationRequested,
          onCancellationRequested: (listener: () => void) =>
            controller.token.onCancellationRequested(listener),
        },
        timeoutMs: 5000,
      });
      await waitFor(() => server.requests.length === 1);
      controller.cancel();
      let failure: unknown;
      try {
        await pending;
      } catch (error) {
        failure = error;
      }
      expect((failure as { code?: string }).code).to.equal('cancelled');
      controller.dispose();
    } finally {
      await server.close();
    }
  });

  test('timeout terminates an unresponsive provider request', async () => {
    const server = await startMockServer(() => {
      // never respond
    });
    try {
      const storage = new MemorySecretStorage();
      storage.values.set('quantsmind.provider.openai-compatible.apiKey', TEST_KEY);
      const service = new CompletionService(
        new SecretStore(storage),
        createSettings({ baseUrl: server.baseUrl, stream: false }),
        new Logger(new MemoryLogSink()),
      );
      let failure: unknown;
      try {
        await service.complete([{ role: 'user', content: 'Hi' }], { timeoutMs: 250 });
      } catch (error) {
        failure = error;
      }
      expect((failure as { code?: string }).code).to.equal('timeout');
    } finally {
      await server.close();
    }
  });

  test('mid-stream cancellation stops delivery without stale completion', async () => {
    const server = await startMockServer((_incoming, response) => {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      response.write('data: {"choices":[{"delta":{"content":"A"}}]}\n\n');
    });
    try {
      const storage = new MemorySecretStorage();
      storage.values.set('quantsmind.provider.openai-compatible.apiKey', TEST_KEY);
      const service = new CompletionService(
        new SecretStore(storage),
        createSettings({ baseUrl: server.baseUrl, stream: true }),
        new Logger(new MemoryLogSink()),
      );
      const controller = new vscode.CancellationTokenSource();
      const deltas: string[] = [];
      let firstDelta: (() => void) | undefined;
      const sawFirstDelta = new Promise<void>((resolve) => {
        firstDelta = resolve;
      });
      const pending = service.complete([{ role: 'user', content: 'Hi' }], {
        token: {
          isCancellationRequested: controller.token.isCancellationRequested,
          onCancellationRequested: (listener: () => void) =>
            controller.token.onCancellationRequested(listener),
        },
        timeoutMs: 5000,
        onDelta: (delta) => {
          deltas.push(delta);
          firstDelta?.();
        },
      });
      await sawFirstDelta;
      controller.cancel();
      let failure: unknown;
      try {
        await pending;
      } catch (error) {
        failure = error;
      }
      expect((failure as { code?: string }).code).to.equal('cancelled');
      expect(deltas).to.deep.equal(['A']);
      controller.dispose();
    } finally {
      await server.close();
    }
  });

  test('credential rotation applies to the next request', async () => {
    const server = await startMockServer((_incoming, response) => {
      sendJson(response, 200, { choices: [{ message: { content: 'ok' } }] });
    });
    try {
      const storage = new MemorySecretStorage();
      storage.values.set('quantsmind.provider.openai-compatible.apiKey', TEST_KEY);
      const service = new CompletionService(
        new SecretStore(storage),
        createSettings({ baseUrl: server.baseUrl, stream: false }),
        new Logger(new MemoryLogSink()),
      );
      await service.complete([{ role: 'user', content: 'first' }]);
      storage.values.set(
        'quantsmind.provider.openai-compatible.apiKey',
        'sk-rotated-1111111111111111',
      );
      await service.complete([{ role: 'user', content: 'second' }]);
      expect(server.requests[0].headers.authorization).to.equal(`Bearer ${TEST_KEY}`);
      expect(server.requests[1].headers.authorization).to.equal(
        'Bearer sk-rotated-1111111111111111',
      );
    } finally {
      await server.close();
    }
  });

  test('provider switching isolates credentials and status', async () => {
    const storage = new MemorySecretStorage();
    storage.values.set('quantsmind.provider.openai.apiKey', TEST_KEY);
    const logger = new Logger(new MemoryLogSink());

    const openaiService = new CompletionService(
      new SecretStore(storage),
      createSettings({ type: 'openai' }),
      logger,
    );
    const openaiStatus = await openaiService.getStatus();
    expect(openaiStatus.hasCredential).to.equal(true);

    const groqService = new CompletionService(
      new SecretStore(storage),
      createSettings({ type: 'groq', baseUrl: 'https://api.groq.com/openai/v1' }),
      logger,
    );
    expect((await groqService.getStatus()).hasCredential).to.equal(false);
  });

  test('error propagation surfaces rate-limit without leaking key', async () => {
    const server = await startMockServer((_incoming, response) => {
      sendJson(response, 429, { error: { message: `limited ${TEST_KEY}` } });
    });
    try {
      const storage = new MemorySecretStorage();
      storage.values.set('quantsmind.provider.openai-compatible.apiKey', TEST_KEY);
      const service = new CompletionService(
        new SecretStore(storage),
        createSettings({ baseUrl: server.baseUrl, stream: false }),
        new Logger(new MemoryLogSink()),
      );
      let failure: unknown;
      try {
        await service.complete([{ role: 'user', content: 'Hi' }]);
      } catch (error) {
        failure = error;
      }
      expect((failure as { code?: string }).code).to.equal('rate_limit');
      expect((failure as { message?: string }).message ?? '').to.not.contain(TEST_KEY);
    } finally {
      await server.close();
    }
  });

  test('chat UI posts error once without false success on auth failure', async () => {
    const server = await startMockServer((_incoming, response) => {
      sendJson(response, 401, { error: { message: 'bad key' } });
    });
    try {
      const { webview } = createHarness({ baseUrl: server.baseUrl, stream: false });
      await markReady(webview);
      webview.emit({ type: 'send', prompt: 'Hello', mode: 'ask' });
      await waitFor(() => webview.has('error'));
      expect(webview.count('error')).to.equal(1);
      expect(webview.has('assistantEnd')).to.equal(false);
      expect(webview.last('error')?.code).to.equal('authentication');
      expect(webview.last('error')?.message ?? '').to.not.contain(TEST_KEY);
    } finally {
      await server.close();
    }
  });

  test('provider change cancels active request and does not post stale success', async () => {
    const server = await startMockServer(() => {
      // never respond; cancellation should clean up UI busy state
    });
    try {
      const { provider, webview } = createHarness({ baseUrl: server.baseUrl, stream: false });
      await markReady(webview);
      webview.emit({ type: 'send', prompt: 'Hello', mode: 'ask' });
      await waitFor(() => server.requests.length === 1);
      provider.cancelActiveRequest();
      await waitFor(() => webview.has('assistantCancelled'));
      expect(webview.has('assistantEnd')).to.equal(false);
    } finally {
      await server.close();
    }
  });
});

suite('extension configuration integration (C)', () => {
  test('configuration resolution follows profile defaults', () => {
    const raw = resolveProviderSettings({ type: 'ollama' });
    expect(raw.baseUrl).to.equal('http://localhost:11434/v1');
    expect(providerAdapterForType('ollama')).to.equal('openai-compatible');
  });

  test('hash utility for workspace fixtures is stable', () => {
    const hash = createHash('sha256').update('fixture').digest('hex');
    expect(hash.length).to.equal(64);
  });

  test('workspace fixture exists for integration harness', async () => {
    const root = workspaceRoot();
    const entries = await readdir(root);
    expect(entries.length).to.be.greaterThan(0);
  });
});
