import { expect } from 'chai';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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
  startMockServer,
  waitFor,
  type MockServer,
} from '../unit/helpers';

const EXTENSION_ID = 'quantsmind.quantsmind-vscode-ai-coder';
const TEST_KEY = 'sk-read-only-integration-0000000000000000';
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
    vscode.Uri.file(join('unused-backups-for-read-only-tests')),
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
  provider.resolveWebviewView(view as unknown as vscode.WebviewView, {} as vscode.WebviewViewResolveContext, new vscode.CancellationTokenSource().token);

  return { provider, webview, sink };
}

async function markReady(webview: FakeWebview): Promise<void> {
  webview.emit({ type: 'ready' });
  await waitFor(() => webview.has('init'));
}

function walkFiles(root: string): Map<string, boolean> {
  const files = new Map<string, boolean>();
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') {
        continue;
      }
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else {
        files.set(relative(root, abs).replace(/\\/g, '/'), true);
      }
    }
  }
  return files;
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

suite('read-only inspection flow (v3.1.1)', () => {
  test('read-only request causes zero workspace mutations and zero commands', async () => {
    const requestCounts = { provider: 0 };
    await withServer(
      () => {
        requestCounts.provider += 1;
        throw new Error('read-only inspection must not call the provider');
      },
      async (server) => {
        const state = new MemoryMemento();
        const { provider, webview } = createHarness({ baseUrl: server.baseUrl, stream: false }, true, state);
        try {
          await markReady(webview);
          const before = walkFiles(join(__dirname, '..', '..', '..', 'test', 'fixtures', 'workspace'));

          webview.emit({
            type: 'startSession',
            requirement: 'Inspect this workspace and summarize its structure.',
          });

          await waitFor(() => webview.has('assistantEnd'), 60000);
          const delta = webview.deltaText();
          expect(delta).to.contain('read-only');
          expect(delta).to.contain('Indexed files');
          expect(delta).to.contain('src/example.ts');
          expect(delta).to.contain('README.md');

          expect(requestCounts.provider).to.equal(0);
          expect(webview.has('session')).to.equal(false);
          expect(webview.has('sessionError')).to.equal(false);

          const after = walkFiles(join(__dirname, '..', '..', '..', 'test', 'fixtures', 'workspace'));
          expect(after).to.deep.equal(before);
          expect(server.requests).to.have.length(0);
        } finally {
          provider.dispose();
        }
      },
    );
  });

  test('normal change request still requires plan approval before any writes', async () => {
    let requestCount = 0;
    const developmentPlan = JSON.stringify({
      kind: 'implementation',
      summary: 'Add a greeting helper.',
      approach: 'Small helper, tests optional.',
      tasks: [
        {
          id: 'task-1',
          title: 'Add greeting helper',
          description: 'Create the helper.',
          dependsOn: [],
          suggestedFiles: ['src/greeting.ts'],
        },
      ],
    });
    await withServer(
      (_incoming, response) => {
        requestCount += 1;
        sendJson(response, 200, {
          model: 'test-model',
          choices: [{ message: { role: 'assistant', content: developmentPlan }, finish_reason: 'stop' }],
        });
      },
      async (server) => {
        const state = new MemoryMemento();
        const { provider, webview } = createHarness({ baseUrl: server.baseUrl, stream: false }, true, state);
        try {
          await markReady(webview);
          webview.emit({ type: 'startSession', requirement: 'Add a greeting helper' });

          await waitFor(
            () => webview.last('session')?.session.state === 'awaiting-plan-approval',
            15000,
          );
          const planned = webview.last('session')?.session;
          expect(planned?.plan?.tasks).to.have.length(1);
          expect(planned?.pendingApproval?.kind).to.equal('plan');
          // No writes and no commands before explicit approval.
          expect(planned?.changeSets).to.have.length(0);
          expect(requestCount).to.equal(1);
          expect(server.requests.length).to.equal(1);
        } finally {
          provider.dispose();
        }
      },
    );
  });

  test('ask history does not appear in Ask-scope provider requests after an Agent requirement is recorded', async () => {
    const askAnswer = 'Ask answer body';
    await withServer(
      (_incoming, response) => {
        sendJson(response, 200, {
          model: 'test-model',
          choices: [{ message: { role: 'assistant', content: askAnswer }, finish_reason: 'stop' }],
        });
      },
      async (server) => {
        const state = new MemoryMemento();
        // Seed a conversation that contains an agent requirement transcript tagged 'agent'.
        const store = new ConversationStore(state);
        const agentReply = 'agent-only-marker-text';
        await store.save({
          id: 'seeded-agent-history',
          title: 'seeded',
          createdAt: '2026-11-12T00:00:00.000Z',
          updatedAt: '2026-11-12T00:00:00.000Z',
          schema: 2,
          mode: 'agent',
          messages: [
            {
              role: 'user',
              text: 'Agent requirement with distinctive-marker-text',
              attachments: [],
              createdAt: '2026-11-12T00:00:00.000Z',
              mode: 'agent',
            },
            {
              role: 'assistant',
              text: agentReply,
              attachments: [],
              createdAt: '2026-11-12T00:00:00.000Z',
              mode: 'agent',
            },
          ],
        });

        const { provider, webview } = createHarness({ baseUrl: server.baseUrl, stream: false }, true, state);
        try {
          await markReady(webview);
          // Open the seeded conversation explicitly.
          webview.emit({ type: 'switchConversation', id: 'seeded-agent-history' });
          await waitFor(
            () => webview.last('conversation')?.id === 'seeded-agent-history',
            15000,
          );

          webview.emit({ type: 'send', prompt: 'History question', mode: 'ask' });
          await waitFor(() => webview.count('assistantEnd') >= 1, 15000);

          const body = server.requests[0]?.body ?? '{}';
          expect(body).to.not.contain('distinctive-marker-text');
          expect(body).to.not.contain(agentReply);
          expect(body).to.contain('History question');
        } finally {
          provider.dispose();
        }
      },
    );
  });
});
