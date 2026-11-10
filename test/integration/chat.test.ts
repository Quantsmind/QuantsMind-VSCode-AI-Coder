import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { expect } from 'chai';
import * as vscode from 'vscode';
import { createAgentRuntime } from '../../src/agent/runtime';
import { ChangeService } from '../../src/changes/changeService';
import { ChangeHistoryStore } from '../../src/changes/history';
import { ChatViewProvider } from '../../src/chat/chatViewProvider';
import { ConversationStore } from '../../src/chat/persistence';
import type { Conversation, StoredMessage } from '../../src/chat/persistence';
import type { HostToWebviewMessage } from '../../src/chat/protocol';
import type { ResolvedProviderSettings } from '../../src/config/resolve';
import { SettingsService } from '../../src/config/settings';
import { ContextService } from '../../src/context/contextService';
import { CompletionService } from '../../src/providers/completionService';
import { Logger } from '../../src/security/logger';
import { API_KEY_SECRET_KEY, SecretStore } from '../../src/security/secretStore';
import { WorkspaceIndexService } from '../../src/workspace/indexService';
import {
  MemoryLogSink,
  MemorySecretStorage,
  createSettings,
  sendJson,
  sendSse,
  startMockServer,
  waitFor,
  type MockServer,
} from '../unit/helpers';

const EXTENSION_ID = 'quantsmind.quantsmind-vscode-ai-coder';
const TEST_KEY = 'sk-chat-integration-0000000000000000';
const DEMO_KEY = 'sk-demo-not-a-real-key-000000000000';

/** Taken from the manifest so a version bump cannot leave a stale assertion behind. */
const MANIFEST_VERSION = String(
  JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8')).version,
);

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

  last<T extends HostToWebviewMessage['type']>(type: T): Extract<HostToWebviewMessage, { type: T }> | undefined {
    for (let index = this.posted.length - 1; index >= 0; index -= 1) {
      const message = this.posted[index];
      if (message.type === type) {
        return message as Extract<HostToWebviewMessage, { type: T }>;
      }
    }
    return undefined;
  }

  deltaText(): string {
    return this.posted
      .filter((message) => message.type === 'assistantDelta')
      .map((message) => (message as Extract<HostToWebviewMessage, { type: 'assistantDelta' }>).delta)
      .join('');
  }
}

class FakeWebviewView {
  private disposeListener: (() => void) | undefined;

  constructor(readonly webview: FakeWebview) {}

  onDidDispose(listener: () => void): vscode.Disposable {
    this.disposeListener = listener;
    return { dispose: () => undefined };
  }

  show(): void {
    return undefined;
  }

  dispose(): void {
    this.disposeListener?.();
  }
}

function extensionUri(): vscode.Uri {
  const found = vscode.extensions.getExtension(EXTENSION_ID);
  expect(found, `Extension ${EXTENSION_ID} should be present`).to.not.equal(undefined);
  return found!.extensionUri;
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  expect(folder, 'A test workspace folder should be open').to.not.equal(undefined);
  return folder!.uri.fsPath;
}

class MemoryMemento {
  private readonly values = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.values.keys()];
  }

  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  seed(key: string, value: unknown): void {
    this.values.set(key, value);
  }
}

function createHarness(
  settingsOverrides: Partial<ResolvedProviderSettings>,
  withKey = true,
  state?: MemoryMemento,
): { provider: ChatViewProvider; webview: FakeWebview; sink: MemoryLogSink } {
  const storage = new MemorySecretStorage();
  if (withKey) {
    storage.values.set(API_KEY_SECRET_KEY, TEST_KEY);
  }
  const sink = new MemoryLogSink();
  const logger = new Logger(sink);
  const secrets = new SecretStore(storage);
  const settings = createSettings({ model: 'test-model', ...settingsOverrides });
  const completion = new CompletionService(secrets, settings, logger);
  const contextService = new ContextService(new SettingsService());
  const memento = state ?? new MemoryMemento();
  const workspaceIndex = new WorkspaceIndexService(settings, logger);
  const changeService = new ChangeService(
    settings,
    new ChangeHistoryStore(memento),
    vscode.Uri.file(join(tmpdir(), 'quantsmind-test-backups')),
    logger,
  );
  const agentRuntime = createAgentRuntime({
    completion,
    settings,
    secrets,
    logger,
    workspaceIndex,
    changeService,
    sessionStore: memento,
  });
  const provider = new ChatViewProvider({
    extensionUri: extensionUri(),
    completion,
    contextService,
    secrets,
    settings,
    logger,
    version: MANIFEST_VERSION,
    conversations: new ConversationStore(memento),
    workspaceIndex,
    changeService,
    agentRuntime,
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

  return { provider, webview, sink };
}

async function markReady(webview: FakeWebview): Promise<void> {
  webview.emit({ type: 'ready' });
  await waitFor(() => webview.has('init'));
}

function hashOf(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

async function snapshotWorkspace(): Promise<string[]> {
  const root = workspaceRoot();
  const entries: string[] = [];

  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.vscode' || entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else {
        entries.push(relative(root, absolute).replace(/\\/g, '/'));
      }
    }
  }

  await walk(root);
  return entries.sort();
}

async function withServer(
  handler: Parameters<typeof startMockServer>[0],
  run: (server: MockServer) => Promise<void>,
): Promise<void> {
  const server = await startMockServer(handler);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

function storedMessage(role: 'user' | 'assistant', text: string): StoredMessage {
  return {
    role,
    text,
    attachments: [],
    createdAt: '2026-11-01T00:00:00.000Z',
  };
}

function conversationWith(id: string, texts: string[]): Conversation {
  const now = '2026-11-01T00:00:00.000Z';
  return {
    id,
    title: id,
    createdAt: now,
    updatedAt: now,
    messages: texts.map((text, index) =>
      storedMessage(index % 2 === 0 ? 'user' : 'assistant', text),
    ),
  };
}

async function seedConversation(
  state: MemoryMemento,
  id: string,
  turns: number,
  prefix: string,
): Promise<void> {
  const store = new ConversationStore(state);
  const messages: StoredMessage[] = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push(storedMessage(index % 2 === 0 ? 'user' : 'assistant', `${prefix} ${index + 1}`));
  }
  await store.save(conversationWith(id, messages.map((message) => message.text)));
}

/** The attachment block a provider request carried, exactly as it was serialized. */
function extractContext(body: string): string {
  const start = body.indexOf('<attached_context>');
  const end = body.indexOf('</attached_context>');
  return start >= 0 && end > start ? body.slice(start, end) : '';
}

suite('chat webview integration', () => {
  test('renders a locked-down webview and announces its initial state', async () => {
    const { provider, webview } = createHarness({ baseUrl: 'http://127.0.0.1:1/v1' });
    try {
      expect(webview.options.enableScripts).to.equal(true);
      expect(webview.options.localResourceRoots).to.have.length(1);
      expect(webview.html).to.contain("default-src 'none'");
      expect(webview.html).to.contain('<meta http-equiv="Content-Security-Policy"');
      expect(webview.html).to.contain('chat.js');

      await markReady(webview);
      const init = webview.last('init');
      expect(init).to.not.equal(undefined);
      expect(init?.version).to.equal(MANIFEST_VERSION);
      expect(init?.attachments).to.deep.equal([]);
      expect(init?.maxPromptChars).to.equal(20000);
      expect(init?.status.providerType).to.equal('openai-compatible');
    } finally {
      provider.dispose();
    }
  });

  test('streams a completion and preserves conversation history', async () => {
    await withServer(
      (_incoming, response) =>
        sendSse(response, [
          { model: 'test-model', choices: [{ delta: { content: 'Hello' } }] },
          { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] },
        ]),
      async (server) => {
        const { provider, webview, sink } = createHarness({ baseUrl: server.baseUrl, stream: true });
        try {
          await markReady(webview);
          webview.emit({ type: 'send', prompt: 'What does this do?', mode: 'ask' });

          await waitFor(() => webview.has('assistantEnd'));

          expect(webview.deltaText()).to.equal('Hello world');
          expect(webview.last('assistantEnd')?.finishReason).to.equal('stop');
          expect(webview.last('busy')?.busy).to.equal(false);

          const types = webview.posted.map((message) => message.type);
          expect(types.indexOf('userMessage')).to.be.lessThan(types.indexOf('assistantStart'));
          expect(types.indexOf('assistantStart')).to.be.lessThan(types.indexOf('assistantDelta'));
          expect(types.indexOf('assistantDelta')).to.be.lessThan(types.indexOf('assistantEnd'));

          expect(server.requests).to.have.length(1);
          const sent = server.requests[0];
          expect(sent.headers.authorization).to.equal(`Bearer ${TEST_KEY}`);
          const body = JSON.parse(sent.body) as {
            model: string;
            stream: boolean;
            messages: { role: string; content: string }[];
          };
          expect(body.model).to.equal('test-model');
          expect(body.stream).to.equal(true);
          expect(body.messages[0].role).to.equal('system');
          expect(body.messages[0].content).to.contain('You cannot modify files');
          expect(body.messages[1]).to.deep.equal({ role: 'user', content: 'What does this do?' });

          webview.emit({ type: 'send', prompt: 'And the second part?', mode: 'ask' });
          await waitFor(() => webview.count('assistantEnd') === 2);

          expect(server.requests).to.have.length(2);
          const second = JSON.parse(server.requests[1].body) as {
            messages: { role: string; content: string }[];
          };
          expect(second.messages.map((message) => message.role)).to.deep.equal([
            'system',
            'user',
            'assistant',
            'user',
          ]);
          expect(second.messages[2].content).to.equal('Hello world');

          expect(sink.text).to.contain('completion start');
          expect(sink.text).to.not.contain(TEST_KEY);
        } finally {
          provider.dispose();
        }
      },
    );
  });

  test('logs only sanitized shapes across a full request lifecycle', async () => {
    await withServer(
      (_incoming, response) =>
        sendSse(response, [
          { model: 'test-model', choices: [{ delta: { content: 'Reply' }, finish_reason: 'stop' }] },
        ]),
      async (server) => {
        const { provider, webview, sink } = createHarness({ baseUrl: server.baseUrl, stream: true });
        try {
          await markReady(webview);
          webview.emit({ type: 'send', prompt: 'Explain the billing module', mode: 'ask' });
          await waitFor(() => webview.has('assistantEnd'));

          expect(sink.text).to.contain('request context');
          expect(sink.text).to.contain('completion success');

          const forbidden: readonly RegExp[] = [
            /sk-[A-Za-z0-9_-]{8,}/,
            /Bearer\s+\S+/,
            /authorization\s*[:=]/i,
            /api[_-]?key\s*[:=]/i,
          ];
          for (const pattern of forbidden) {
            expect(sink.text, `Output log matched ${pattern}`).to.not.match(pattern);
          }
          expect(sink.text).to.not.contain('Explain the billing module');
        } finally {
          provider.dispose();
        }
      },
    );
  });

  test('attaches the active file only on request, redacts it, and never modifies the workspace', async () => {
    await withServer(
      (_incoming, response) =>
        sendSse(response, [
          { choices: [{ delta: { content: 'It defines a greeting helper.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      async (server) => {
        const fileUri = vscode.Uri.joinPath(
          vscode.workspace.workspaceFolders![0].uri,
          'src',
          'example.ts',
        );
        const document = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(document);
        const before = hashOf(Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf8'));
        const beforeFiles = await snapshotWorkspace();

        const { provider, webview } = createHarness({ baseUrl: server.baseUrl, stream: true });
        try {
          await markReady(webview);
          expect(server.requests).to.have.length(0);

          webview.emit({ type: 'attachActiveFile' });
          await waitFor(() => {
            const message = webview.last('attachments');
            return message !== undefined && message.attachments.length === 1;
          });

          const attached = webview.last('attachments');
          expect(attached?.attachments[0].path).to.equal('src/example.ts');
          expect(attached?.attachments[0].redactions).to.be.greaterThan(0);
          expect(server.requests).to.have.length(0);

          webview.emit({ type: 'send', prompt: 'Explain this file.', mode: 'explain' });
          await waitFor(() => webview.has('assistantEnd'));

          expect(server.requests).to.have.length(1);
          const body = server.requests[0].body;
          expect(body).to.contain('<attached_context>');
          expect(body).to.contain('src/example.ts');
          expect(body).to.contain('[REDACTED]');
          expect(body).to.not.contain(DEMO_KEY);
          expect(body).to.not.contain('DEMO_TOKEN');

          const cleared = webview.last('attachments');
          expect(cleared?.attachments).to.deep.equal([]);

          const after = hashOf(Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf8'));
          expect(after).to.equal(before);
          expect(await snapshotWorkspace()).to.deep.equal(beforeFiles);
        } finally {
          provider.dispose();
        }
      },
    );
  });

  test('cancels an in-flight request from the stop control', async () => {
    await withServer(
      () => {
        // Intentionally never respond.
      },
      async (server) => {
        const { provider, webview } = createHarness({ baseUrl: server.baseUrl, stream: true });
        try {
          await markReady(webview);
          webview.emit({ type: 'send', prompt: 'Long request', mode: 'ask' });
          await waitFor(() => webview.has('assistantStart'));

          webview.emit({ type: 'stop' });
          await waitFor(() => webview.has('assistantCancelled'));
          await waitFor(() => webview.last('busy')?.busy === false);

          expect(webview.has('assistantEnd')).to.equal(false);
          expect(webview.last('busy')?.busy).to.equal(false);
        } finally {
          provider.dispose();
        }
      },
    );
  });

  test('surfaces normalized provider errors without leaking credentials', async () => {
    await withServer(
      (_incoming, response) =>
        sendJson(response, 500, {
          error: { message: `upstream rejected ${TEST_KEY}` },
        }),
      async (server) => {
        const { provider, webview, sink } = createHarness({ baseUrl: server.baseUrl, stream: false });
        try {
          await markReady(webview);
          webview.emit({ type: 'send', prompt: 'Trigger an error', mode: 'ask' });
          await waitFor(() => webview.has('error'));

          const error = webview.last('error');
          expect(error?.code).to.equal('server');
          expect(error?.hint).to.be.a('string');
          expect(error?.message).to.not.contain(TEST_KEY);
          expect(webview.last('busy')?.busy).to.equal(false);
          expect(sink.text).to.not.contain(TEST_KEY);
        } finally {
          provider.dispose();
        }
      },
    );
  });

  test('blocks sending before any request when the provider is not ready', async () => {
    const { provider, webview } = createHarness(
      { baseUrl: 'https://api.example.com/v1' },
      false,
    );
    try {
      await markReady(webview);
      const init = webview.last('init');
      expect(init?.status.ready).to.equal(false);
      expect(init?.status.hasCredential).to.equal(false);

      webview.emit({ type: 'send', prompt: 'Should not be sent', mode: 'ask' });
      await waitFor(() => webview.has('error'));

      expect(webview.last('error')?.code).to.equal('authentication');
      expect(webview.has('assistantStart')).to.equal(false);
    } finally {
      provider.dispose();
    }
  });

  test('new chat clears attachments and conversation state', async () => {
    const { provider, webview } = createHarness({ baseUrl: 'http://127.0.0.1:1/v1' });
    try {
      await markReady(webview);
      webview.emit({ type: 'newChat' });

      await waitFor(() => webview.has('clear'));
      expect(webview.last('attachments')?.attachments).to.deep.equal([]);
      expect(webview.last('busy')?.busy).to.equal(false);
    } finally {
      provider.dispose();
    }
  });

  test('starts clean after New Chat and never replays a restored conversation', async () => {
    await withServer(
      (_incoming, response) =>
        sendSse(response, [
          { choices: [{ delta: { content: 'READY' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      async (server) => {
        const state = new MemoryMemento();
        const first = createHarness({ baseUrl: server.baseUrl, stream: true }, true, state);
        let second: { provider: ChatViewProvider; webview: FakeWebview } | undefined;
        try {
          await markReady(first.webview);
          first.webview.emit({ type: 'send', prompt: 'Turn that should not follow', mode: 'ask' });
          await waitFor(() => first.webview.has('assistantEnd'));
          first.provider.dispose();

          second = createHarness({ baseUrl: server.baseUrl, stream: true }, true, state);
          await markReady(second.webview);

          const restored = second.webview.last('init');
          expect(restored?.history.restored).to.equal(true);
          expect(restored?.history.messages).to.equal(2);
          expect(restored?.transcript).to.have.lengthOf(2);

          second.webview.emit({ type: 'newConversation' });
          await waitFor(() => {
            const history = second?.webview.last('history');
            return history !== undefined && history.history.messages === 0;
          });

          const clean = second.webview.last('history');
          expect(clean?.history.restored).to.equal(false);
          expect(clean?.history.transcriptMessages).to.equal(0);
          expect(second.webview.last('clear')).to.not.equal(undefined);

          second.webview.emit({ type: 'send', prompt: 'Reply with exactly: READY', mode: 'ask' });
          await waitFor(() => server.requests.length === 2);

          const body = JSON.parse(server.requests[1].body) as {
            messages: { role: string; content: string }[];
          };
          expect(body.messages).to.have.lengthOf(2);
          expect(body.messages[0].role).to.equal('system');
          expect(body.messages[1]).to.deep.equal({
            role: 'user',
            content: 'Reply with exactly: READY',
          });
          expect(server.requests[1].body).to.not.contain('Turn that should not follow');
        } finally {
          first.provider.dispose();
          second?.provider.dispose();
        }
      },
    );
  });

  test('restores a long conversation in order with the new prompt last', async () => {
    const state = new MemoryMemento();
    await seedConversation(state, 'restored-17', 17, 'Historical turn');

    await withServer(
      (_incoming, response) =>
        sendSse(response, [
          { choices: [{ delta: { content: 'READY' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      async (server) => {
        const { provider, webview, sink } = createHarness(
          { baseUrl: server.baseUrl, stream: true },
          true,
          state,
        );
        try {
          await markReady(webview);

          const init = webview.last('init');
          expect(init?.history.conversationId).to.equal('restored-17');
          expect(init?.history.restored).to.equal(true);
          expect(init?.history.messages).to.equal(17);
          expect(init?.transcript).to.have.lengthOf(17);

          webview.emit({ type: 'send', prompt: 'Reply with exactly: READY', mode: 'ask' });
          await waitFor(() => server.requests.length === 1);

          const body = JSON.parse(server.requests[0].body) as {
            messages: { role: string; content: string }[];
          };
          expect(body.messages).to.have.lengthOf(19);
          expect(body.messages.filter((message) => message.role === 'system')).to.have.lengthOf(1);
          expect(body.messages[1].content).to.equal('Historical turn 1');
          expect(body.messages[17].content).to.equal('Historical turn 17');
          expect(body.messages[18]).to.deep.equal({
            role: 'user',
            content: 'Reply with exactly: READY',
          });
          expect(new Set(body.messages.slice(1, 18).map((message) => message.content)).size).to.equal(17);

          const breakdown = webview.last('requestContext')?.breakdown;
          expect(breakdown?.messages).to.equal(19);
          expect(breakdown?.historyMessages).to.equal(17);
          expect(breakdown?.promptChars).to.equal('Reply with exactly: READY'.length);
          expect(breakdown?.systemChars).to.be.greaterThan(0);

          expect(sink.text).to.contain('conversation history ready source=reload');
          expect(sink.text).to.contain('request context');
          expect(sink.text).to.not.contain(TEST_KEY);
        } finally {
          provider.dispose();
        }
      },
    );
  });

  test('replays the captured attachment context after a simulated reload', async () => {
    const fileUri = vscode.Uri.joinPath(
      vscode.workspace.workspaceFolders![0].uri,
      'src',
      'example.ts',
    );
    const document = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(document);
    const state = new MemoryMemento();

    await withServer(
      (_incoming, response) =>
        sendSse(response, [
          { choices: [{ delta: { content: 'It defines a greeting helper.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      async (server) => {
        const first = createHarness({ baseUrl: server.baseUrl, stream: true }, true, state);
        let second: ChatViewProvider | undefined;
        try {
          await markReady(first.webview);
          first.webview.emit({ type: 'attachActiveFile' });
          await waitFor(() => (first.webview.last('attachments')?.attachments.length ?? 0) === 1);

          first.webview.emit({ type: 'send', prompt: 'Explain this file.', mode: 'explain' });
          await waitFor(() => first.webview.has('assistantEnd'));

          const original = server.requests[0].body;
          expect(original).to.contain('<attached_context>');
          expect(original).to.not.contain(DEMO_KEY);

          const stored = new ConversationStore(state).get(
            first.webview.last('init')?.activeConversationId ?? '',
          );
          const capturedContext = stored?.messages.find((message) => message.role === 'user')
            ?.attachmentContext;
          expect(capturedContext?.map((item) => item.path)).to.deep.equal(['src/example.ts']);
          expect(capturedContext?.[0].content.length).to.be.greaterThan(0);

          const capturedChars = first.webview.last('requestContext')?.breakdown.attachmentChars ?? 0;
          expect(capturedChars).to.be.greaterThan(0);

          first.provider.dispose();
          const harness = createHarness({ baseUrl: server.baseUrl, stream: true }, true, state);
          second = harness.provider;
          await markReady(harness.webview);

          const restored = harness.webview.last('init');
          expect(restored?.history.attachmentTurns).to.equal(1);
          expect(restored?.history.unavailableAttachments).to.equal(0);
          const details = restored?.transcript.find((message) => message.role === 'user')
            ?.attachmentDetails;
          expect(details?.map((detail) => detail.status)).to.deep.equal(['captured']);

          harness.webview.emit({ type: 'send', prompt: 'And the second part?', mode: 'ask' });
          await waitFor(() => server.requests.length === 2);

          const replay = server.requests[1].body;
          expect(extractContext(replay)).to.equal(extractContext(original));
          const replayMessages = JSON.parse(replay) as {
            messages: { role: string; content: string }[];
          };
          const currentTurn = replayMessages.messages[replayMessages.messages.length - 1];
          expect(currentTurn).to.deep.equal({ role: 'user', content: 'And the second part?' });
          const replayedTurn = replayMessages.messages.find((message) =>
            message.content.includes('<attached_context>'),
          );
          expect(replayedTurn?.content).to.contain('User request:\nExplain this file.');
          expect(replay).to.not.contain(DEMO_KEY);
        } finally {
          first.provider.dispose();
          second?.dispose();
        }
      },
    );
  });

  test('warns when a historical attachment no longer matches the file on disk', async () => {
    const targetUri = vscode.Uri.joinPath(
      vscode.workspace.workspaceFolders![0].uri,
      'ctx-probe-freshness.ts',
    );
    const probe = 'export const probeValue = 42;\n';
    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(probe, 'utf8'));

    const state = new MemoryMemento();
    await withServer(
      (_incoming, response) =>
        sendSse(response, [
          { choices: [{ delta: { content: 'A constant.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      async (server) => {
        const document = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(document);
        const first = createHarness({ baseUrl: server.baseUrl, stream: true }, true, state);
        let second: ChatViewProvider | undefined;
        try {
          await markReady(first.webview);
          first.webview.emit({ type: 'attachActiveFile' });
          await waitFor(() => (first.webview.last('attachments')?.attachments.length ?? 0) === 1);
          first.webview.emit({ type: 'send', prompt: 'What is this?', mode: 'ask' });
          await waitFor(() => first.webview.has('assistantEnd'));
          first.provider.dispose();

          await vscode.workspace.fs.writeFile(targetUri, Buffer.from('export const probeValue = 7;\n', 'utf8'));

          const harness = createHarness({ baseUrl: server.baseUrl, stream: true }, true, state);
          second = harness.provider;
          await markReady(harness.webview);
          await waitFor(() =>
            harness.webview.posted.some(
              (message) =>
                message.type === 'notice' &&
                (message as Extract<HostToWebviewMessage, { type: 'notice' }>).message.includes(
                  'no longer match the file on disk',
                ),
            ),
          );

          expect(harness.sink.text).to.contain('attachment freshness audit');
          expect(harness.sink.text).to.contain('modified=1');

          harness.webview.emit({ type: 'send', prompt: 'And now?', mode: 'ask' });
          await waitFor(() => server.requests.length === 2);
          expect(server.requests[1].body).to.contain('export const probeValue = 42;');
          expect(server.requests[1].body).to.not.contain('export const probeValue = 7;');
        } finally {
          first.provider.dispose();
          second?.dispose();
          await vscode.workspace.fs.writeFile(targetUri, Buffer.from(probe, 'utf8'));
          await vscode.workspace.fs.delete(targetUri).then(
            () => undefined,
            () => undefined,
          );
        }
      },
    );
  });

  test('keeps conversations isolated when switching between them', async () => {
    const state = new MemoryMemento();
    const store = new ConversationStore(state);
    await store.save(conversationWith('conv-a', ['Alpha question', 'Alpha answer']));
    await store.save(conversationWith('conv-b', ['Beta question', 'Beta answer', 'Third', 'Fourth']));

    await withServer(
      (_incoming, response) =>
        sendSse(response, [
          { choices: [{ delta: { content: 'Noted.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      async (server) => {
        const { provider, webview } = createHarness(
          { baseUrl: server.baseUrl, stream: true },
          true,
          state,
        );
        try {
          await markReady(webview);
          expect(webview.last('init')?.history.conversationId).to.equal('conv-b');
          expect(webview.last('init')?.history.messages).to.equal(4);

          webview.emit({ type: 'switchConversation', id: 'conv-a' });
          await waitFor(() => webview.last('history')?.history.conversationId === 'conv-a');
          expect(webview.last('history')?.history.messages).to.equal(2);

          const alphaBusyPosts = webview.count('busy');
          webview.emit({ type: 'send', prompt: 'Alpha follow-up', mode: 'ask' });
          await waitFor(() => server.requests.length === 1);
          const alpha = JSON.parse(server.requests[0].body) as {
            messages: { content: string }[];
          };
          expect(alpha.messages).to.have.lengthOf(4);
          expect(alpha.messages[1].content).to.equal('Alpha question');
          expect(alpha.messages[2].content).to.equal('Alpha answer');
          expect(alpha.messages[3].content).to.equal('Alpha follow-up');
          const alphaBody = server.requests[0].body;
          expect(alphaBody).to.not.contain('Beta question');
          expect(alphaBody).to.not.contain('Third');

          // A switch while a request is still streaming is refused by design, so the
          // completion has to settle before the conversation may change.
          await waitFor(
            () => webview.count('busy') > alphaBusyPosts && webview.last('busy')?.busy === false,
          );

          webview.emit({ type: 'switchConversation', id: 'conv-b' });
          await waitFor(() => webview.last('history')?.history.conversationId === 'conv-b');
          const betaBusyPosts = webview.count('busy');
          webview.emit({ type: 'send', prompt: 'Beta follow-up', mode: 'ask' });
          await waitFor(() => server.requests.length === 2);
          await waitFor(
            () => webview.count('busy') > betaBusyPosts && webview.last('busy')?.busy === false,
          );

          const beta = JSON.parse(server.requests[1].body) as { messages: { content: string }[] };
          expect(beta.messages).to.have.lengthOf(6);
          expect(beta.messages[1].content).to.equal('Beta question');
          expect(beta.messages[5].content).to.equal('Beta follow-up');
          expect(server.requests[1].body).to.not.contain('Alpha question');
          expect(server.requests[1].body).to.not.contain('Alpha follow-up');

          const storedA = new ConversationStore(state).get('conv-a');
          expect(storedA?.messages.filter((message) => message.role === 'user')).to.have.lengthOf(2);
          const storedB = new ConversationStore(state).get('conv-b');
          expect(storedB?.messages.filter((message) => message.role === 'user')).to.have.lengthOf(3);
        } finally {
          provider.dispose();
        }
      },
    );
  });

  test('never offers an empty conversation in history and restores the selected one', async () => {
    const state = new MemoryMemento();
    const store = new ConversationStore(state);
    await store.save(conversationWith('history-a', ['Alpha', 'Alpha answer']));
    await store.save(conversationWith('history-b', ['Beta', 'Beta answer', 'Gamma', 'Gamma answer']));

    await withServer(
      (_incoming, response) =>
        sendSse(response, [
          { choices: [{ delta: { content: 'Noted.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      async (server) => {
        const { provider, webview } = createHarness(
          { baseUrl: server.baseUrl, stream: true },
          true,
          state,
        );
        try {
          await markReady(webview);
          expect(webview.last('init')?.conversations.map((entry) => entry.id)).to.deep.equal([
            'history-b',
            'history-a',
          ]);

          webview.emit({ type: 'newConversation' });
          await waitFor(() => webview.has('clear'));
          const afterNew = webview.last('conversations');
          const blankId = afterNew?.activeConversationId ?? '';
          expect(blankId).to.not.equal('history-a');
          expect(blankId).to.not.equal('history-b');
          expect(afterNew?.conversations.find((entry) => entry.id === blankId)?.messageCount).to.equal(
            0,
          );
          expect(afterNew?.conversations.filter((entry) => entry.messageCount === 0)).to.have.lengthOf(
            1,
          );
          expect(
            afterNew?.conversations
              .filter((entry) => entry.id !== blankId)
              .map((entry) => entry.id),
          ).to.deep.equal(['history-b', 'history-a']);

          webview.emit({ type: 'restorePreviousConversation', id: 'history-a' });
          await waitFor(() => webview.last('history')?.history.conversationId === 'history-a');
          expect(webview.last('conversation')?.transcript).to.have.lengthOf(2);
          expect(webview.last('conversations')?.activeConversationId).to.equal('history-a');
          expect(
            webview.last('conversations')?.conversations.some((entry) => entry.id === blankId),
          ).to.equal(false);

          webview.emit({ type: 'newConversation' });
          await waitFor(() => webview.count('clear') === 2);
          const blankAgain = webview.last('conversations')?.activeConversationId ?? '';
          expect(blankAgain).to.not.equal(blankId);

          webview.emit({ type: 'restorePreviousConversation' });
          await waitFor(() => webview.last('history')?.history.conversationId === 'history-b');
          expect(webview.last('history')?.history.messages).to.equal(4);
          expect(webview.last('conversations')?.activeConversationId).to.equal('history-b');
          expect(
            webview.last('conversations')?.conversations.some((entry) => entry.messageCount === 0),
          ).to.equal(false);
        } finally {
          provider.dispose();
        }
      },
    );
  });

  test('reports provider failures without exposing credentials or request content', async () => {
    await withServer(
      (_incoming, response) =>
        sendJson(response, 429, { error: { message: `rate limited key ${TEST_KEY}` } }),
      async (server) => {
        const { provider, webview, sink } = createHarness({
          baseUrl: server.baseUrl,
          stream: true,
        });
        try {
          await markReady(webview);
          webview.emit({
            type: 'send',
            prompt: 'Secret wording that must not be logged',
            mode: 'ask',
          });
          await waitFor(() => webview.has('error'));

          expect(sink.text).to.contain('request context');
          expect(sink.text).to.contain('completion failed code=');
          expect(sink.text).to.not.contain(TEST_KEY);
          expect(sink.text).to.not.contain('must not be logged');
          expect(webview.last('error')?.message).to.not.contain(TEST_KEY);
        } finally {
          provider.dispose();
        }
      },
    );
  });

  test('plans, approves, writes, validates state, and undoes a workspace change end to end', async () => {
    const targetName = 'agent-demo-created.txt';
    const targetUri = vscode.Uri.joinPath(
      vscode.workspace.workspaceFolders![0].uri,
      targetName,
    );
    const developmentPlan = JSON.stringify({
      summary: 'Create a demonstration file.',
      approach: 'Add one text file and let the user approve it.',
      tasks: [
        {
          id: 'task-1',
          title: 'Create the demonstration file',
          description: 'Create the file with deterministic content.',
          dependsOn: [],
          suggestedFiles: [targetName],
          criteria: [{ text: 'The file exists with the expected content', verification: 'review' }],
        },
      ],
    });
    const changePlan = JSON.stringify({
      summary: 'Create a demonstration file.',
      changes: [
        {
          kind: 'create',
          path: targetName,
          summary: 'Add it for the approval test.',
          content: 'created by the agent integration test\n',
        },
      ],
    });
    let requestCount = 0;

    await withServer(
      (_incoming, response) => {
        requestCount += 1;
        const content = requestCount === 1 ? developmentPlan : changePlan;
        sendJson(response, 200, {
          model: 'test-model',
          choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        });
      },
      async (server) => {
        const { provider, webview } = createHarness({ baseUrl: server.baseUrl, stream: false });
        try {
          await markReady(webview);
          webview.emit({ type: 'startSession', requirement: 'Create a demonstration file.' });

          await waitFor(
            () => webview.last('session')?.session.state === 'awaiting-plan-approval',
            15000,
          );
          const planned = webview.last('session')?.session;
          expect(planned?.plan?.tasks).to.have.length(1);
          expect(planned?.pendingApproval?.kind).to.equal('plan');

          // A decision that does not name the pending request is dropped at the
          // wire boundary, so the plan stays unapproved.
          webview.emit({ type: 'approvePlan', sessionId: planned!.id });
          await new Promise((resolve) => setTimeout(resolve, 300));
          expect(webview.last('session')?.session.state).to.equal('awaiting-plan-approval');
          expect(webview.last('session')?.session.pendingApproval?.id).to.equal(
            planned!.pendingApproval!.id,
          );

          webview.emit({
            type: 'approvePlan',
            sessionId: planned!.id,
            requestId: planned!.pendingApproval!.id,
          });
          await waitFor(
            () => webview.last('session')?.session.state === 'awaiting-change-approval',
            15000,
          );
          const reviewed = webview.last('session')?.session;
          expect(reviewed?.pendingApproval?.kind).to.equal('change-set');
          expect(reviewed?.changeSets[0].plan.changes[0].path).to.equal(targetName);

          const beforeApply = await vscode.workspace.fs.stat(targetUri).then(
            () => true,
            () => false,
          );
          expect(beforeApply).to.equal(false);

          webview.emit({
            type: 'approveChangeSet',
            sessionId: reviewed!.id,
            ids: reviewed!.changeSets[0].plan.changes.map((change) => change.id),
            requestId: reviewed!.pendingApproval!.id,
          });
          await waitFor(() => webview.last('session')?.session.state === 'completed', 15000);
          const completed = webview.last('session')?.session;
          expect(completed?.tasks[0].status).to.equal('completed');
          expect(completed?.report?.outcome).to.equal('completed');

          const written = Buffer.from(await vscode.workspace.fs.readFile(targetUri)).toString('utf8');
          expect(written).to.equal('created by the agent integration test\n');

          webview.emit({ type: 'undoSession', sessionId: completed!.id });
          await waitFor(() => webview.has('undoResult'), 15000);
          expect(webview.last('undoResult')?.restored).to.equal(1);

          const afterUndo = await vscode.workspace.fs.stat(targetUri).then(
            () => true,
            () => false,
          );
          expect(afterUndo).to.equal(false);
        } finally {
          provider.dispose();
          await vscode.workspace.fs.delete(targetUri).then(
            () => undefined,
            () => undefined,
          );
        }
      },
    );
  });
});
