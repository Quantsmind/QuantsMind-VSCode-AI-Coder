import { createHash } from 'node:crypto';
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
}

function createHarness(
  settingsOverrides: Partial<ResolvedProviderSettings>,
  withKey = true,
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
  const memento = new MemoryMemento();
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
    version: '0.3.0',
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
      expect(init?.version).to.equal('0.3.0');
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

          webview.emit({ type: 'approvePlan', sessionId: planned!.id });
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
