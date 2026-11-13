import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { createAgentRuntime } from '../../src/agent/runtime';
import { ChangeService } from '../../src/changes/changeService';
import { ChangeHistoryStore } from '../../src/changes/history';
import { ChatViewProvider } from '../../src/chat/chatViewProvider';
import { ConversationStore } from '../../src/chat/persistence';
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
const TEST_KEY = 'sk-large-attachment-integration-000000000000';
const ATTACH_FIXTURE = 'src/task_manager.py';
const MANIFEST_VERSION = String(
  JSON.parse(
    readFileSync(join(__dirname, '../../../package.json'), 'utf8'),
  ).version,
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

  last<T extends HostToWebviewMessage['type']>(type: T):
    | Extract<HostToWebviewMessage, { type: T }>
    | undefined {
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
}

function extensionUri(): vscode.Uri {
  const found = vscode.extensions.getExtension(EXTENSION_ID);
  expect(found, `Extension ${EXTENSION_ID} should be present`).to.not.equal(undefined);
  return found!.extensionUri;
}

function createHarness(
  settingsOverrides: Partial<ResolvedProviderSettings>,
  withKey = true,
  state?: MemoryMemento,
): { provider: ChatViewProvider; webview: FakeWebview } {
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
    vscode.Uri.file(join('unused-backups-for-large-attachment-tests')),
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
    isTrusted: () => vscode.workspace.isTrusted,
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
  provider.resolveWebviewView(
    view as unknown as vscode.WebviewView,
    {} as vscode.WebviewViewResolveContext,
    new vscode.CancellationTokenSource().token,
  );

  return { provider, webview };
}

async function markReady(webview: FakeWebview): Promise<void> {
  webview.emit({ type: 'ready' });
  await waitFor(() => webview.has('init'));
}

async function openAttachment(): Promise<void> {
  const fileUri = vscode.Uri.joinPath(
    vscode.workspace.workspaceFolders![0].uri,
    ATTACH_FIXTURE,
  );
  const document = await vscode.workspace.openTextDocument(fileUri);
  await vscode.window.showTextDocument(document);
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

suite('large attachment and provider reliability (v3.1.1)', () => {
  test('attaches the 15,064-char task_manager.py and sends it end-to-end', async () => {
    await withServer(
      (_incoming, response) =>
        sendSse(response, [
          { choices: [{ delta: { content: 'It is a task manager module.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      async (server) => {
        await openAttachment();
        const state = new MemoryMemento();
        const { provider, webview } = createHarness({ baseUrl: server.baseUrl, stream: true }, true, state);
        try {
          await markReady(webview);
          webview.emit({ type: 'attachActiveFile' });
          await waitFor(() => {
            const message = webview.last('attachments');
            return message !== undefined && message.attachments.length === 1;
          });

          webview.emit({ type: 'send', prompt: 'Summarize the task manager', mode: 'ask' });
          await waitFor(() => webview.has('assistantEnd'), 15000);

          expect(server.requests).to.have.length(1);
          const body = server.requests[0].body;
          const attachmentBlockStart = body.indexOf('<attached_context>');
          const attachmentBlockEnd = body.indexOf('</attached_context>');
          expect(attachmentBlockStart).to.be.greaterThanOrEqual(0);
          expect(attachmentBlockEnd).to.be.greaterThan(attachmentBlockStart);
          const block = body.slice(attachmentBlockStart, attachmentBlockEnd);
          expect(block).to.contain('src/task_manager.py');
          expect(block).to.contain('V3.1.1_LARGE_ATTACHMENT_SENTINEL');
        } finally {
          provider.dispose();
        }
      },
    );
  });

  test('large attachment survives New Chat without silently becoming a different request', async () => {
    await withServer(
      (_incoming, response) =>
        sendSse(response, [
          { choices: [{ delta: { content: 'Plain answer after new chat.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      async (server) => {
        await openAttachment();
        const state = new MemoryMemento();
        const { provider, webview } = createHarness({ baseUrl: server.baseUrl, stream: true }, true, state);
        try {
          await markReady(webview);
          webview.emit({ type: 'newConversation' });
          await waitFor(() => webview.count('clear') === 1);

          webview.emit({ type: 'attachActiveFile' });
          await waitFor(() => webview.last('attachments')?.attachments.length === 1);

          webview.emit({ type: 'send', prompt: 'Summarize', mode: 'ask' });
          await waitFor(() => webview.has('assistantEnd'), 15000);

          const body = server.requests[server.requests.length - 1]?.body ?? '';
          expect(body).to.contain('<attached_context>');
          expect(body).to.contain('V3.1.1_LARGE_ATTACHMENT_SENTINEL');
        } finally {
          provider.dispose();
        }
      },
    );
  });

  test('large attachment with existing conversation history reaches the provider unchanged', async () => {
    await withServer(
      (_incoming, response) =>
        sendSse(response, [
          { choices: [{ delta: { content: 'Answer with history.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      async (server) => {
        await openAttachment();
        const state = new MemoryMemento();
        // Persist one prior turn so the restored conversation has history.
        const store = new ConversationStore(state);
        await store.save({
          id: 'seeded-large-attachment',
          title: 'prior turns',
          createdAt: '2026-11-12T00:00:00.000Z',
          updatedAt: '2026-11-12T00:00:00.000Z',
          schema: 2,
          mode: 'ask',
          messages: [
            {
              role: 'user',
              text: 'earlier question',
              attachments: [],
              createdAt: '2026-11-12T00:00:00.000Z',
              mode: 'ask',
            },
            {
              role: 'assistant',
              text: 'earlier answer',
              attachments: [],
              createdAt: '2026-11-12T00:00:00.000Z',
              mode: 'ask',
            },
          ],
        });
        const { provider, webview } = createHarness({ baseUrl: server.baseUrl, stream: true }, true, state);
        try {
          await markReady(webview);
          // The seeded conversation is auto-restored on load; wait for it.
          await waitFor(
            () => webview.last('init')?.history.conversationId === 'seeded-large-attachment',
            15000,
          );

          webview.emit({ type: 'attachActiveFile' });
          await waitFor(() => webview.last('attachments')?.attachments.length === 1);

          webview.emit({ type: 'send', prompt: 'And now?', mode: 'ask' });
          await waitFor(() => webview.has('assistantEnd'), 15000);

          const body = server.requests[server.requests.length - 1]?.body ?? '';
          expect(body).to.contain('earlier question');
          expect(body).to.contain('earlier answer');
          expect(body).to.contain('<attached_context>');
          expect(body).to.contain('V3.1.1_LARGE_ATTACHMENT_SENTINEL');
        } finally {
          provider.dispose();
        }
      },
    );
  });

  test('retrying after a provider failure resends the same request without duplicating the user turn', async () => {
    let attempt = 0;
    await withServer(
      (_incoming, response) => {
        attempt += 1;
        if (attempt === 1) {
          sendJson(response, 500, {
            error: { message: 'upstream temporarily unavailable' },
          });
          return;
        }
        sendSse(response, [
          { choices: [{ delta: { content: 'Best effort after a hiccup.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]);
      },
      async (server) => {
        await openAttachment();
        const state = new MemoryMemento();
        const { provider, webview } = createHarness({ baseUrl: server.baseUrl, stream: true }, true, state);
        try {
          await markReady(webview);
          webview.emit({ type: 'attachActiveFile' });
          await waitFor(() => webview.last('attachments')?.attachments.length === 1);

          webview.emit({ type: 'send', prompt: 'retry me please', mode: 'ask' });
          await waitFor(() => webview.has('error'));

          // Attachments survive the failure so the user can retry with the same context.
          expect(webview.last('attachments')?.attachments.length).to.equal(1);
          expect(server.requests).to.have.length(1);

          webview.emit({ type: 'retryLastRequest' });
          await waitFor(() => webview.has('assistantEnd'), 15000);

          expect(server.requests).to.have.length(2);
          const retryBody = server.requests[1].body;
          expect(retryBody).to.contain('V3.1.1_LARGE_ATTACHMENT_SENTINEL');
          expect(retryBody).to.contain('retry me please');
          expect(retryBody).to.equal(server.requests[0].body);

          // Exactly one user message was recorded despite two provider attempts.
          const userMessages = webview.posted.filter(
            (message) => message.type === 'userMessage',
          );
          expect(userMessages).to.have.lengthOf(1);
        } finally {
          provider.dispose();
        }
      },
    );
  });
});
