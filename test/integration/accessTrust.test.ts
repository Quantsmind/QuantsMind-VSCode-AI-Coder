import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import * as vscode from 'vscode';
import { createAgentRuntime } from '../../src/agent/runtime';
import { ChangeService } from '../../src/changes/changeService';
import { ChangeHistoryStore } from '../../src/changes/history';
import { checksumOf } from '../../src/chat/attachmentContext';
import { ChatViewProvider } from '../../src/chat/chatViewProvider';
import { ConversationStore } from '../../src/chat/persistence';
import type { Conversation } from '../../src/chat/persistence';
import type { HostToWebviewMessage } from '../../src/chat/protocol';
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
  startMockServer,
  waitFor,
  type MockServer,
} from '../unit/helpers';

const EXTENSION_ID = 'quantsmind.quantsmind-vscode-ai-coder';
const TEST_KEY = 'sk-trust-integration-0000000000000000';
const MANIFEST_VERSION = String(
  JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8')).version,
);

function trustSwitch(initial: boolean): { isTrusted: () => boolean; set(value: boolean): void } {
  let trusted = initial;
  return {
    isTrusted: () => trusted,
    set(value: boolean): void {
      trusted = value;
    },
  };
}

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
    return { dispose: () => (this.listener = undefined) };
  }

  async postMessage(message: unknown): Promise<boolean> {
    this.posted.push(message as HostToWebviewMessage);
    return true;
  }

  emit(message: unknown): void {
    this.listener?.(message);
  }

  has(type: HostToWebviewMessage['type']): boolean {
    return this.posted.some((message) => message.type === type);
  }

  last<T extends HostToWebviewMessage['type']>(
    type: T,
  ): Extract<HostToWebviewMessage, { type: T }> | undefined {
    for (let index = this.posted.length - 1; index >= 0; index -= 1) {
      if (this.posted[index].type === type) {
        return this.posted[index] as Extract<HostToWebviewMessage, { type: T }>;
      }
    }
    return undefined;
  }

  notices(): string[] {
    return this.posted
      .filter((message) => message.type === 'notice')
      .map((message) => (message as Extract<HostToWebviewMessage, { type: 'notice' }>).message);
  }

  attachmentsCount(): number {
    const message = this.last('attachments');
    return message?.attachments.length ?? 0;
  }
}

class FakeWebviewView {
  constructor(readonly webview: FakeWebview) {}
  onDidDispose(): vscode.Disposable {
    return { dispose: () => undefined };
  }
  show(): void {
    return undefined;
  }
}

class MemoryMemento {
  private readonly values = new Map<string, unknown>();
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

function workspaceFolder(): vscode.WorkspaceFolder {
  const folder = vscode.workspace.workspaceFolders?.[0];
  expect(folder, 'A test workspace folder should be open').to.not.equal(undefined);
  return folder!;
}

function chatHarness(
  trust: { isTrusted: () => boolean },
  baseUrl = 'http://127.0.0.1:1/v1',
): { provider: ChatViewProvider; webview: FakeWebview; sink: MemoryLogSink; state: MemoryMemento } {
  const storage = new MemorySecretStorage();
  storage.values.set(API_KEY_SECRET_KEY, TEST_KEY);
  const sink = new MemoryLogSink();
  const logger = new Logger(sink);
  const secrets = new SecretStore(storage);
  const settings = createSettings({ baseUrl, model: 'test-model', stream: false });
  const state = new MemoryMemento();
  const completion = new CompletionService(secrets, settings, logger);
  const contextService = new ContextService(new SettingsService(), trust.isTrusted);
  const workspaceIndex = new WorkspaceIndexService(settings, logger, trust.isTrusted);
  const changeService = new ChangeService(
    settings,
    new ChangeHistoryStore(state),
    vscode.Uri.file(join(tmpdir(), 'quantsmind-trust-test-backups')),
    logger,
  );
  const agentRuntime = createAgentRuntime({
    completion,
    settings,
    secrets,
    logger,
    workspaceIndex,
    changeService,
    sessionStore: state,
    isTrusted: trust.isTrusted,
  });
  const provider = new ChatViewProvider({
    extensionUri: extensionUri(),
    completion,
    contextService,
    secrets,
    settings,
    logger,
    version: MANIFEST_VERSION,
    conversations: new ConversationStore(state),
    workspaceIndex,
    changeService,
    agentRuntime,
    isTrusted: trust.isTrusted,
  });

  const webview = new FakeWebview();
  provider.resolveWebviewView(
    new FakeWebviewView(webview) as unknown as vscode.WebviewView,
    {} as vscode.WebviewViewResolveContext,
    new vscode.CancellationTokenSource().token,
  );
  return { provider, webview, sink, state };
}

async function markReady(webview: FakeWebview): Promise<void> {
  webview.emit({ type: 'ready' });
  await waitFor(() => webview.has('init'), 10_000);
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

suite('restricted mode workspace trust', () => {
  test('index and retrieval return nothing while untrusted and resume after a grant', async () => {
    const trust = trustSwitch(false);
    const settings = new SettingsService();
    const logger = new Logger({ appendLine: () => undefined });
    const index = new WorkspaceIndexService(settings, logger, trust.isTrusted);

    expect(await index.getEntries()).to.deep.equal([]);
    expect((await index.summarize()).fileCount).to.equal(0);
    const blocked = await index.retrieve('greeting example');
    expect(blocked.items).to.deep.equal([]);

    trust.set(true);
    const entries = await index.getEntries();
    expect(entries.map((entry) => entry.path)).to.include('src/example.ts');
    const allowed = await index.retrieve('greeting example');
    expect(allowed.items.some((item) => item.path === 'src/example.ts')).to.equal(true);
    expect(allowed.items[0].origin).to.equal('workspace');
  });

  test('context service refuses workspace enumeration and disk reads while untrusted', async () => {
    const trust = trustSwitch(false);
    const context = new ContextService(new SettingsService(), trust.isTrusted);
    const target = vscode.Uri.joinPath(workspaceFolder().uri, 'src', 'example.ts');

    expect(await context.listAttachableFiles()).to.deep.equal([]);
    const read = await context.readUris([target]);
    expect(read.candidates).to.deep.equal([]);
    expect(read.failures).to.have.lengthOf(1);
    expect(read.failures[0].message).to.match(/trusted workspace/);

    trust.set(true);
    expect((await context.listAttachableFiles()).length).to.be.greaterThan(0);
    const allowed = await context.readUris([target]);
    expect(allowed.candidates).to.have.lengthOf(1);
    expect(allowed.candidates[0].origin).to.equal('user');
  });

  test('editor-selected content stays explicit in restricted mode', async () => {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(workspaceFolder().uri, 'src', 'example.ts'),
    );
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(0, 0, 0, 8);

    const context = new ContextService(new SettingsService(), () => false);
    const candidate = context.fromSelection(editor);
    expect(candidate).to.not.equal(undefined);
    expect(candidate?.origin).to.equal('user');
    expect(candidate?.content.length).to.be.greaterThan(0);
    expect(context.fromActiveFile(editor)?.origin).to.equal('user');
  });

  test('agent runtime neither inspects nor starts while untrusted', async () => {
    const trust = trustSwitch(false);
    const storage = new MemorySecretStorage();
    const logger = new Logger({ appendLine: () => undefined });
    const settings = new SettingsService();
    const secrets = new SecretStore(storage);
    const completion = new CompletionService(secrets, settings, logger);
    const workspaceIndex = new WorkspaceIndexService(settings, logger, trust.isTrusted);
    const changeService = new ChangeService(
      settings,
      new ChangeHistoryStore(new MemoryMemento()),
      vscode.Uri.file(join(tmpdir(), 'quantsmind-trust-test-backups')),
      logger,
    );
    const runtime = createAgentRuntime({
      completion,
      settings,
      secrets,
      logger,
      workspaceIndex,
      changeService,
      sessionStore: new MemoryMemento(),
      isTrusted: trust.isTrusted,
    });

    const context = await runtime.intelligence.inspect({ isCancellationRequested: false } as never);
    expect(context.configFiles).to.deep.equal([]);
    expect(context.summaryText).to.contain('0 indexed');

    let caught: unknown;
    try {
      await runtime.controller.start('Implement the feature', {
        isCancellationRequested: false,
      } as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.match(/trust is required/i);
  });

  test('chat announces restricted mode without paths or credentials', async () => {
    const trust = trustSwitch(false);
    const { provider, webview } = chatHarness(trust);
    try {
      await markReady(webview);
      const notice = webview.notices().find((text) => text.includes('Restricted Mode'));
      expect(notice).to.not.equal(undefined);
      expect(notice).to.contain('attach yourself');
      expect(notice).to.not.contain(TEST_KEY);
      expect(notice).to.not.contain(workspaceFolder().uri.fsPath);
      expect(webview.last('init')?.status.ready).to.equal(true);
    } finally {
      provider.dispose();
    }
  });

  test('chat refuses automatic discovery and restores it after a grant', async () => {
    const trust = trustSwitch(false);
    const { provider, webview } = chatHarness(trust);
    try {
      await markReady(webview);

      webview.emit({ type: 'summarizeWorkspace' });
      await waitFor(
        () => webview.notices().some((text) => text.includes('needs a trusted workspace')),
        10_000,
      );
      expect(webview.has('workspaceSummary')).to.equal(false);

      webview.emit({ type: 'attachRelevantFiles', query: 'greeting example' });
      await waitFor(
        () => webview.notices().filter((text) => text.includes('needs a trusted workspace')).length >= 2,
        10_000,
      );
      expect(webview.attachmentsCount()).to.equal(0);

      trust.set(true);
      provider.refreshWorkspaceTrust();
      webview.emit({ type: 'summarizeWorkspace' });
      await waitFor(() => webview.has('workspaceSummary'), 20_000);
    } finally {
      provider.dispose();
    }
  });

  test('restricted mode refuses both halves of a validation command approval', async () => {
    const trust = trustSwitch(false);
    const { provider, webview, sink } = chatHarness(trust);
    try {
      await markReady(webview);
      const refused = (count: number): boolean =>
        webview.notices().filter((text) => text.includes('needs a trusted workspace')).length >=
        count;

      webview.emit({ type: 'requestValidation', sessionId: 'session-1', command: 'npm test' });
      await waitFor(() => refused(1), 10_000);

      webview.emit({
        type: 'approveValidation',
        sessionId: 'session-1',
        requestId: 'approval-1',
      });
      await waitFor(() => refused(2), 10_000);

      expect(webview.has('session')).to.equal(false);
      expect(webview.has('commandOutput')).to.equal(false);
      expect(sink.lines.some((line) => /validation/i.test(line))).to.equal(true);

      trust.set(true);
      provider.refreshWorkspaceTrust();
      webview.emit({
        type: 'approveValidation',
        sessionId: 'session-1',
        requestId: 'approval-1',
      });
      // After the grant the same message reaches the orchestrator, which refuses
      // on session identity instead of trust; the refusal still runs no command.
      await waitFor(
        () => webview.last('sessionError')?.message === 'Unknown agent session.',
        10_000,
      );
      expect(webview.has('commandOutput')).to.equal(false);
      expect(refused(3)).to.equal(false);
    } finally {
      provider.dispose();
    }
  });

  test('chat drops buffered discovered content at send time and says so', async () => {
    const trust = trustSwitch(true);
    await withServer(
      (_incoming, response) =>
        sendJson(response, 200, { choices: [{ message: { content: 'ok' } }] }),
      async (server) => {
        const { provider, webview } = chatHarness(trust, server.baseUrl);
        try {
          await markReady(webview);
          webview.emit({ type: 'attachRelevantFiles', query: 'greeting example' });
          await waitFor(() => webview.attachmentsCount() > 0, 20_000);

          trust.set(false);
          webview.emit({ type: 'send', prompt: 'Summarize the attached code.', mode: 'ask' });
          await waitFor(() => webview.has('assistantEnd'), 10_000);

          const body = server.requests[0]?.body ?? '';
          expect(body).to.contain('Summarize the attached code.');
          expect(body).to.not.contain('export function greet');
          expect(webview.notices().some((text) => text.includes('automatically discovered'))).to.equal(
            true,
          );
        } finally {
          provider.dispose();
        }
      },
    );
  });

  test('ordinary prompts still work while untrusted', async () => {
    const trust = trustSwitch(false);
    await withServer(
      (_incoming, response) =>
        sendJson(response, 200, {
          choices: [{ message: { content: 'plain answer' }, finish_reason: 'stop' }],
        }),
      async (server) => {
        const { provider, webview } = chatHarness(trust, server.baseUrl);
        try {
          await markReady(webview);
          webview.emit({ type: 'send', prompt: 'Explain a binary search.', mode: 'ask' });
          await waitFor(() => webview.has('assistantEnd'), 10_000);

          expect(webview.last('assistantEnd')?.finishReason).to.not.equal(undefined);
          expect(server.requests[0]?.body).to.contain('Explain a binary search.');
          expect(webview.has('error')).to.equal(false);
        } finally {
          provider.dispose();
        }
      },
    );
  });

  test('restored history withholds discovered attachments while untrusted', async () => {
    const trust = trustSwitch(false);
    const state = new MemoryMemento();
    const store = new ConversationStore(state);
    const snippet = 'const workspaceOnlySnippet = "must not be replayed";';
    const conversation: Conversation = {
      id: 'restricted-history',
      title: 'restricted history',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      messages: [
        {
          role: 'user',
          text: 'Earlier question',
          question: 'Earlier question',
          attachments: [],
          createdAt: '2026-11-01T00:00:00.000Z',
          attachmentContext: [
            {
              path: 'src/example.ts',
              content: snippet,
              chars: snippet.length,
              checksum: checksumOf(snippet),
              isSelection: false,
              redactions: 0,
              capturedAt: '2026-11-01T00:00:00.000Z',
              origin: 'workspace',
            },
          ],
        },
        {
          role: 'assistant',
          text: 'Earlier answer',
          attachments: [],
          createdAt: '2026-11-01T00:00:01.000Z',
        },
      ],
    };
    await store.save(conversation);

    await withServer(
      (_incoming, response) =>
        sendJson(response, 200, { choices: [{ message: { content: 'ok' } }] }),
      async (server) => {
        const storage = new MemorySecretStorage();
        storage.values.set(API_KEY_SECRET_KEY, TEST_KEY);
        const sink = new MemoryLogSink();
        const logger = new Logger(sink);
        const secrets = new SecretStore(storage);
        const settings = createSettings({ baseUrl: server.baseUrl, model: 'test-model', stream: false });
        const completion = new CompletionService(secrets, settings, logger);
        const contextService = new ContextService(new SettingsService(), trust.isTrusted);
        const workspaceIndex = new WorkspaceIndexService(settings, logger, trust.isTrusted);
        const changeService = new ChangeService(
          settings,
          new ChangeHistoryStore(state),
          vscode.Uri.file(join(tmpdir(), 'quantsmind-trust-test-backups')),
          logger,
        );
        const agentRuntime = createAgentRuntime({
          completion,
          settings,
          secrets,
          logger,
          workspaceIndex,
          changeService,
          sessionStore: state,
          isTrusted: trust.isTrusted,
        });
        const provider = new ChatViewProvider({
          extensionUri: extensionUri(),
          completion,
          contextService,
          secrets,
          settings,
          logger,
          version: MANIFEST_VERSION,
          conversations: store,
          workspaceIndex,
          changeService,
          agentRuntime,
          isTrusted: trust.isTrusted,
        });
        const webview = new FakeWebview();
        provider.resolveWebviewView(
          new FakeWebviewView(webview) as unknown as vscode.WebviewView,
          {} as vscode.WebviewViewResolveContext,
          new vscode.CancellationTokenSource().token,
        );
        try {
          await markReady(webview);
          await waitFor(
            () => webview.notices().some((text) => text.includes('withheld')),
            10_000,
          );
          webview.emit({ type: 'send', prompt: 'Follow up', mode: 'ask' });
          await waitFor(() => webview.has('assistantEnd'), 10_000);

          const body = server.requests[0]?.body ?? '';
          expect(body).to.contain('Follow up');
          expect(body).not.to.contain(snippet);
          expect(webview.last('userMessage')?.attachments).to.deep.equal([]);
        } finally {
          provider.dispose();
        }
      },
    );
  });
});
