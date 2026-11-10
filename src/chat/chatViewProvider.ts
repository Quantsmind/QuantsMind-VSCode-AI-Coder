import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { AgentRuntime } from '../agent/runtime';
import type { AgentRunEvent } from '../agent/codingAgent';
import type { AgentSessionView } from '../agent/models';
import { AgentSessionError } from '../agent/orchestrator';
import type { ChangeService } from '../changes/changeService';
import type { WorkspaceIndexService } from '../workspace/indexService';
import { selectWorkspaceRoot } from '../workspace/rootPolicy';
import { COMMANDS } from '../commands/ids';
import { LIMITS } from '../config/defaults';
import type { SettingsService } from '../config/settings';
import type { ContextService } from '../context/contextService';
import {
  normalizeContextPath,
  type ContextCandidate,
  type ContextSkipReason,
  type RedactedContextItem,
} from '../context/filters';
import type { CompletionService, ProviderStatus } from '../providers/completionService';
import { errorHint, isProviderError, normalizeThrownError } from '../providers/errors';
import type { Logger } from '../security/logger';
import type { SecretStore } from '../security/secretStore';
import {
  isTrusted,
  RESTRICTED_MODE_ACTION_NOTICE,
  RESTRICTED_MODE_FEATURE_NOTICE,
  RESTRICTED_MODE_REPLAY_NOTICE,
  type AttachmentOrigin,
  type TrustCheck,
} from '../security/workspaceTrust';
import {
  attachmentRestoreWarnings,
  captureAttachments,
  displaysForStoredAttachments,
  droppedContentNotice,
  enforceAttachmentBudget,
  freshnessOf,
  providerHistoryMessages,
  withheldAttachmentCount,
  type AttachmentDisplay,
  type StoredAttachment,
} from './attachmentContext';
import { formatRequestBreakdown, measureRequest } from './requestMetrics';
import {
  buildMessages,
  DEFAULT_QUESTIONS,
  isAgentMode,
  type ChatMode,
} from './prompts';
import {
  ConversationStore,
  type Conversation,
  type ConversationMeta,
  type StoredMessage,
} from './persistence';
import {
  parseWebviewMessage,
  type AttachmentSummary,
  type HistoryState,
  type HostToWebviewMessage,
  type RepositoryView,
  type SessionSummary,
  type TranscriptMessage,
  type WebviewToHostMessage,
} from './protocol';
import { ChatSession } from './session';
import { architectureSummary } from '../repository/discovery';
import { explainContextSelection } from '../repository/contextSelection';
import { renderChatHtml } from './webviewHtml';
import type { ExecutionRecord } from '../execution/service';
import {
  repoInfo,
  status,
  log,
  listRemotes,
  inProgressState,
} from '../git/gitService';
import { parseRemote } from '../github/githubService';
import type { ExecutionView, GitStatusView } from './protocol';

/** Upper bound on disk comparisons a single restoration may trigger. */
const FRESHNESS_AUDIT_LIMIT = 12;

const EMPTY_HISTORY: HistoryState = {  conversationId: '',
  messages: 0,
  chars: 0,
  restored: false,
  transcriptMessages: 0,
  attachmentTurns: 0,
  unavailableAttachments: 0,
};

interface AttachmentBuffer {
  readonly id: string;
  readonly path: string;
  readonly content: string;
  readonly languageId?: string;
  readonly isSelection: boolean;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly redactions: number;
  /** Provenance decides whether Restricted Mode may put this in a request. */
  readonly source: AttachmentOrigin;
}

interface AddResult {
  readonly added: number;
  readonly skipped: string[];
}

const SKIP_LABELS: Record<ContextSkipReason, string> = {
  excluded: 'sensitive or excluded path',
  empty: 'empty content',
  binary: 'binary content',
  too_large: 'file too large',
  duplicate: 'already attached',
  limit_files: 'attachment limit reached',
  limit_chars: 'context size limit reached',
};

export interface ChatViewDependencies {
  readonly extensionUri: vscode.Uri;
  readonly completion: CompletionService;
  readonly contextService: ContextService;
  readonly secrets: SecretStore;
  readonly settings: SettingsService;
  readonly logger: Logger;
  readonly version: string;
  readonly conversations: ConversationStore;
  readonly workspaceIndex: WorkspaceIndexService;
  readonly changeService: ChangeService;
  readonly agentRuntime: AgentRuntime;
  readonly isTrusted?: TrustCheck;
}

function toExecutionView(record: ExecutionRecord): ExecutionView {
  return {
    id: record.id,
    kind: record.kind,
    command: record.command,
    cwd: record.cwd,
    state: record.status === 'running' ? 'running' : 'finished',
    startedAt: record.startedAt,
    ...(record.status !== 'running' ? { status: record.status } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    exitCode: record.exitCode,
    ...(record.status !== 'running' ? { output: record.output } : {}),
    ...(record.truncated ? { truncated: true } : {}),
    ...(record.timedOut ? { timedOut: true } : {}),
    ...(record.cancelled ? { cancelled: true } : {}),
    ...(record.diagnostics !== undefined ? { diagnostics: record.diagnostics.length } : {}),
    ...(record.tests !== undefined
      ? {
          tests: {
            ...(record.tests.passed !== undefined ? { passed: record.tests.passed } : {}),
            ...(record.tests.failed !== undefined ? { failed: record.tests.failed } : {}),
            ...(record.tests.skipped !== undefined ? { skipped: record.tests.skipped } : {}),
            ...(record.tests.total !== undefined ? { total: record.tests.total } : {}),
          },
        }
      : {}),
  };
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'quantsmind.chatView';

  private view: vscode.WebviewView | undefined;
  private ready = false;
  private attachments: AttachmentBuffer[] = [];
  private readonly session = new ChatSession();
  private busy = false;
  private cancelSource: vscode.CancellationTokenSource | undefined;
  private requestSeq = 0;
  private attachmentSeq = 0;
  private pendingDraft: { readonly prompt: string; readonly mode: ChatMode } | undefined;
  private viewDisposables: vscode.Disposable[] = [];
  private conversation: Conversation | undefined;
  private storedMessages: StoredMessage[] = [];
  private activeSessionId: string | undefined;
  private sessionSource: vscode.CancellationTokenSource | undefined;
  private sessionTimer: NodeJS.Timeout | undefined;
  private sessionsLoaded = false;
  private historySourceId: string | undefined;
  private history: HistoryState = EMPTY_HISTORY;
  private restoreWarnings: string[] = [];
  private readonly sessionSubscription: { dispose(): void };
  private readonly executionSubscription: { dispose(): void };
  private readonly trustCheck: TrustCheck;

  constructor(private readonly deps: ChatViewDependencies) {
    this.sessionSubscription = deps.agentRuntime.subscribe((view) => this.onSessionUpdate(view));
    this.executionSubscription = deps.agentRuntime.executionService.subscribe((record) =>
      this.onExecution(record),
    );
    this.trustCheck = deps.isTrusted ?? (() => vscode.workspace.isTrusted);
  }

  private onExecution(record: ExecutionRecord): void {
    this.post({ type: 'execution', execution: toExecutionView(record) });
  }

  /**
   * Trust is re-read at each boundary instead of cached: a grant, a revocation,
   * or a folder change must take effect on the next operation.
   */
  private trustState(): boolean {
    return isTrusted(this.trustCheck);
  }

  private requireTrust(action: string): boolean {
    if (this.trustState()) {
      return true;
    }
    this.deps.logger.info(`restricted mode refused to ${action}`);
    this.notifyWarning(RESTRICTED_MODE_ACTION_NOTICE);
    return false;
  }

  private async currentSecret(): Promise<string | undefined> {
    try {
      const providerType = this.deps.settings.getProviderSettings().type;
      return await this.deps.secrets.forProvider(providerType).get();
    } catch {
      return await this.deps.secrets.get();
    }
  }

  private workspaceRoot(): vscode.WorkspaceFolder | undefined {
    return selectWorkspaceRoot(vscode.workspace.workspaceFolders);
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.disposeViewListeners();
    this.view = webviewView;
    this.ready = false;

    const mediaRoot = vscode.Uri.joinPath(this.deps.extensionUri, 'media');
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };

    const nonce = randomBytes(16).toString('base64url');
    webviewView.webview.html = renderChatHtml({
      cspSource: webviewView.webview.cspSource,
      scriptUri: webviewView.webview.asWebviewUri(
        vscode.Uri.joinPath(mediaRoot, 'chat.js'),
      ).toString(),
      styleUri: webviewView.webview.asWebviewUri(
        vscode.Uri.joinPath(mediaRoot, 'chat.css'),
      ).toString(),
      nonce,
      version: this.deps.version,
    });

    this.viewDisposables.push(
      webviewView.webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseWebviewMessage(raw);
        if (message === undefined) {
          return;
        }
        void this.handleMessage(message).catch((error: unknown) => {
          this.deps.logger.error('chat message handler failed', error);
        });
      }),
    );

    this.viewDisposables.push(
      webviewView.onDidDispose(() => {
        this.ready = false;
        this.view = undefined;
        this.cancelActive();
      }),
    );
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand('quantsmind.chatView.focus');
    this.view?.show?.(true);
  }

  cancelActiveRequest(): void {
    this.cancelActive();
  }

  async runCodingAgentAndReveal(task: string): Promise<void> {
    const trimmed = task.trim();
    if (trimmed.length === 0) {
      return;
    }
    await this.reveal();
    if (this.busy) {
      this.post({ type: 'notice', level: 'warn', message: 'A request is already running.' });
      return;
    }
    const assistantId = `assistant-agent-${++this.requestSeq}`;
    await this.ensureConversation();
    this.syncHistoryBeforeSend();
    await this.recordUser(trimmed, []);
    this.session.addUser(trimmed);
    const toolEvents: Array<{ tool?: string; ok?: boolean; message: string; output?: string }> = [];
    this.busy = true;
    this.post({ type: 'busy', busy: true });
    this.post({ type: 'assistantStart', id: assistantId, model: 'coding-agent' });

    try {
      const result = await this.deps.agentRuntime.codingAgent.run(trimmed, {
        maxIterations: 8,
        onEvent: (event: AgentRunEvent) => {
          this.deps.logger.info(`coding agent ${event.type}: ${event.message}`);
          if (event.type === 'model') {
            // Agent thinking/progress state without exposing hidden reasoning.
            this.post({
              type: 'notice',
              level: 'info',
              message: event.message,
            });
          } else if (event.type === 'tool') {
            this.post({
              type: 'notice',
              level: event.ok === false ? 'warn' : 'info',
              message: event.message,
            });
            this.post({
              type: 'agentToolResult',
              tool: event.tool ?? 'tool',
              ok: event.ok !== false,
              message: event.message,
              output: event.output,
            });
            toolEvents.push({
              tool: event.tool ?? 'tool',
              ok: event.ok !== false,
              message: event.message,
              output: event.output,
            });
            if (
              event.tool !== undefined &&
              /command/i.test(event.tool) &&
              typeof event.output === 'string'
            ) {
              try {
                const commandResult = JSON.parse(event.output) as {
                  command?: string;
                  cwd?: string;
                  exitCode?: number | null;
                  output?: string;
                  timedOut?: boolean;
                  cancelled?: boolean;
                };
                this.post({
                  type: 'commandOutput',
                  command: commandResult.command ?? event.tool,
                  cwd: commandResult.cwd ?? '',
                  output: commandResult.output ?? '',
                  exitCode: commandResult.exitCode ?? null,
                  timedOut: commandResult.timedOut === true,
                  cancelled: commandResult.cancelled === true,
                });
              } catch {
                // The tool result was not a command result; leave the notice as the only UI update.
              }
            }
          } else if (event.type === 'cancelled') {
            this.post({
              type: 'notice',
              level: 'warn',
              message: `Cancelled: ${event.message}`,
            });
          } else if (event.type === 'limit') {
            this.post({
              type: 'notice',
              level: 'warn',
              message: `Safety limit reached: ${event.message}`,
            });
          } else if (event.type === 'error') {
            this.post({
              type: 'error',
              message: event.message,
              hint: undefined,
              code: undefined,
            });
          }
        },
      });
      for (const event of toolEvents) {
        const summary = `[tool] ${event.tool}: ${event.ok ? 'succeeded' : 'failed'}\n${(event.output ?? '').slice(0, 2000)}`.trim();
        if (summary.length > 0) {
          await this.recordAssistant(summary, false, true);
        }
      }
      if (result.finalText.length > 0) {
        this.post({ type: 'assistantDelta', id: assistantId, delta: result.finalText });
      }
      await this.recordAssistant(result.finalText || `Coding agent finished with status: ${result.status}.`);
      this.post({
        type: 'assistantEnd',
        id: assistantId,
        finishReason: result.status,
        usage: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Coding agent failed.';
      this.post({ type: 'error', message, hint: undefined, code: undefined });
    } finally {
      this.busy = false;
      this.post({ type: 'busy', busy: false });
    }
  }

  async refreshStatus(): Promise<void> {
    if (!this.ready) {
      return;
    }
    try {
      const status = await this.deps.completion.getStatus();
      this.post({ type: 'status', status });
    } catch (error) {
      this.deps.logger.error('failed to refresh provider status', error);
    }
  }

  /**
   * Rebuilds the trust-dependent state after VS Code reports a grant. VS Code
   * has no revoke event (revocation reloads the window), so the other direction
   * is covered by re-reading the check before each workspace operation.
   */
  refreshWorkspaceTrust(): void {
    const trusted = this.trustState();
    this.deps.logger.info(`workspace trust changed trusted=${trusted}`);
    if (this.conversation !== undefined) {
      this.refreshHistoryState(
        { ...this.conversation, messages: this.storedMessages },
        'reload',
      );
      this.postHistory();
    }
    this.postSessions();
    this.post({
      type: 'notice',
      level: trusted ? 'info' : 'warn',
      message: trusted
        ? 'Workspace trust granted. Workspace summaries, relevant-file matching, the file picker, and agent mode are available again.'
        : RESTRICTED_MODE_FEATURE_NOTICE,
    });
    void this.refreshStatus();
  }

  /**
   * Called when provider configuration changed while a request is active.
   * Cancels the active request so a stale profile cannot finish and post a
   * result under the new profile's UI.
   */
  cancelActiveIfBusy(): void {
    if (this.busy) {
      this.cancelActive();
    }
  }

  async requestSelection(mode: ChatMode, prompt: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      this.notifyWarning('Open a text editor and select code first.');
      return;
    }

    const candidate = this.deps.contextService.fromSelection(editor);
    if (candidate === undefined) {
      this.notifyWarning('Select some code first.');
      return;
    }

    const result = await this.addCandidates([candidate], 'user');
    if (result.added === 0 && this.attachments.length === 0) {
      this.notifyWarning(
        `The selection could not be attached (${result.skipped[0] ?? 'no usable content'}).`,
      );
      return;
    }

    this.pendingDraft = { prompt, mode };
    await this.reveal();
    this.sendDraft();
  }

  async summarizeWorkspaceAndReveal(): Promise<void> {
    await this.reveal();
    await this.summarizeWorkspace();
  }

  async attachRelevantFilesAndReveal(query: string): Promise<void> {
    await this.reveal();
    await this.attachRelevantFiles(query);
  }

  async startAgentTaskAndReveal(prompt: string): Promise<void> {
    await this.reveal();
    await this.startSession(prompt);
  }

  async attachActiveFileAndReveal(): Promise<void> {
    const result = await this.attachFromEditor('file');
    if (result.added === 0 && this.attachments.length === 0) {
      this.notifyWarning(
        `The active file could not be attached (${result.skipped[0] ?? 'no usable content'}).`,
      );
      return;
    }
    await this.reveal();
  }

  async startNewChat(): Promise<void> {
    if (this.busy) {
      this.notifyWarning('Wait for the current request to finish before starting a new chat.');
      return;
    }
    this.requestSeq += 1;
    this.cancelActive();
    this.busy = false;
    this.session.clear();
    this.storedMessages = [];
    this.attachments = [];
    this.pendingDraft = undefined;
    this.activeSessionId = undefined;
    this.historySourceId = undefined;
    this.history = EMPTY_HISTORY;
    this.restoreWarnings = [];

    // Reuse an untouched conversation instead of stacking empty ones, so a
    // restored conversation can never be re-attached to a "new" chat.
    const reusable =
      this.conversation !== undefined &&
      this.conversation.messages.length === 0 &&
      this.deps.conversations.get(this.conversation.id)?.messages.length === 0
        ? this.conversation
        : undefined;
    const conversation = reusable ?? this.deps.conversations.create();
    this.conversation = await this.deps.conversations.save(conversation);
    this.historySourceId = this.conversation.id;
    this.history = { ...EMPTY_HISTORY, conversationId: this.conversation.id };

    this.post({ type: 'busy', busy: false });
    this.post({ type: 'attachments', attachments: [] });
    this.post({ type: 'clear' });
    this.postHistory();
    this.postConversations();
    this.postSessions();
    void this.refreshStatus();
    this.deps.logger.info(
      `new chat started conversation=${this.conversation.id.slice(0, 24)} reused=${reusable !== undefined}`,
    );
  }

  private postExecutionHistory(): void {
    const executions = this.deps.agentRuntime.executionService
      .list()
      .slice(0, 20)
      .map(toExecutionView);
    this.post({ type: 'executionHistory', executions });
  }

  dispose(): void {
    this.requestSeq += 1;
    this.cancelActive();
    this.cancelSessionStep();
    this.sessionSubscription.dispose();
    this.executionSubscription.dispose();
    this.disposeViewListeners();
    this.session.clear();
    this.attachments = [];
    this.view = undefined;
    this.ready = false;
  }

  private disposeViewListeners(): void {
    for (const disposable of this.viewDisposables.splice(0)) {
      disposable.dispose();
    }
  }

  private cancelActive(): void {
    const source = this.cancelSource;
    this.cancelSource = undefined;
    source?.cancel();
    source?.dispose();
  }

  private cancelSessionStep(): void {
    if (this.sessionTimer !== undefined) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = undefined;
    }
    const source = this.sessionSource;
    this.sessionSource = undefined;
    source?.cancel();
    source?.dispose();
  }

  private async ensureConversation(): Promise<void> {
    if (this.conversation !== undefined) {
      return;
    }
    const activeId = this.deps.conversations.activeId();
    const existing = activeId !== undefined ? this.deps.conversations.get(activeId) : undefined;
    if (existing !== undefined) {
      this.conversation = existing;
      this.storedMessages = [...existing.messages];
      this.session.load(
        existing.messages
          .filter((message) => message.localOnly !== true)
          .map((message) => ({ role: message.role, content: message.text })),
      );
      this.refreshHistoryState(existing, 'reload');
      return;
    }
    const created = this.deps.conversations.create();
    this.conversation = await this.deps.conversations.save(created);
    this.storedMessages = [];
    this.session.clear();
    this.historySourceId = this.conversation.id;
    this.history = { ...EMPTY_HISTORY, conversationId: this.conversation.id };
    this.restoreWarnings = [];
  }

  /**
   * Rebuilds the provider-bound history from the durable transcript so the UI
   * can report exactly what the next request will contain. `load` replaces the
   * session wholesale, which makes repeated restoration idempotent.
   */
  private refreshHistoryState(
    conversation: Conversation,
    source: 'reload' | 'switch' | 'send' | 'budget',
  ): void {
    const trusted = this.trustState();
    const rebuilt = providerHistoryMessages(conversation.messages, {
      includeAutoDiscovered: trusted,
    });
    this.session.load(rebuilt);
    this.historySourceId = conversation.id;

    const displays: AttachmentDisplay[] = [];
    let attachmentTurns = 0;
    for (const message of conversation.messages) {
      if (message.role !== 'user') {
        continue;
      }
      const stored = message.attachmentContext ?? [];
      const labels = stored.length > 0 ? [] : message.attachments;
      if (stored.length > 0 || labels.length > 0) {
        attachmentTurns += 1;
      }
      displays.push(...displaysForStoredAttachments(stored, labels));
    }

    const unavailable = displays.filter(
      (display) => display.status === 'unavailable' || display.status === 'legacy',
    ).length;

    this.history = {
      conversationId: conversation.id,
      messages: this.session.snapshot().length,
      chars: this.session.charCount,
      restored: rebuilt.length > 0,
      transcriptMessages: conversation.messages.length,
      attachmentTurns,
      unavailableAttachments: unavailable,
    };
    this.restoreWarnings = attachmentRestoreWarnings(displays);
    if (!trusted && withheldAttachmentCount(conversation.messages) > 0) {
      this.restoreWarnings.push(RESTRICTED_MODE_REPLAY_NOTICE);
    }

    this.deps.logger.info(
      `conversation history ready source=${source} transcriptMessages=${conversation.messages.length} providerMessages=${this.history.messages} providerChars=${this.history.chars} attachmentTurns=${attachmentTurns} unavailableAttachments=${unavailable}`,
    );

    if (trusted && (source === 'reload' || source === 'switch')) {
      void this.auditAttachmentFreshness(conversation);
    }
  }

  /**
   * Read-only comparison between the attachment context a restored conversation
   * captured and the files on disk today. It never substitutes current file
   * contents for the captured context; it only reports the difference so the
   * user knows the replay is sending the original snapshot.
   */
  private async auditAttachmentFreshness(conversation: Conversation): Promise<void> {
    const root = this.workspaceRoot();
    if (root === undefined || !this.trustState()) {
      return;
    }

    const comparable: StoredAttachment[] = [];
    for (const message of conversation.messages) {
      if (message.role !== 'user') {
        continue;
      }
      for (const attachment of message.attachmentContext ?? []) {
        if (attachment.content.length === 0 || attachment.isSelection || attachment.redactions > 0) {
          continue;
        }
        comparable.push(attachment);
      }
    }
    if (comparable.length === 0) {
      return;
    }

    const audited = comparable.slice(-FRESHNESS_AUDIT_LIMIT);
    const { maxFileSizeBytes } = this.deps.settings.getContextSettings();
    let unchanged = 0;
    let modified = 0;
    let missing = 0;
    let skipped = comparable.length - audited.length;

    for (const attachment of audited) {
      const uri = this.resolveStoredPath(root, attachment.path);
      if (uri === undefined) {
        missing += 1;
        continue;
      }
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (typeof stat.size === 'number' && stat.size > maxFileSizeBytes) {
          skipped += 1;
          continue;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        const verdict = freshnessOf(attachment, Buffer.from(bytes).toString('utf8'));
        if (verdict === 'modified') {
          modified += 1;
        } else {
          unchanged += 1;
        }
      } catch {
        missing += 1;
      }
    }

    this.deps.logger.info(
      `attachment freshness audit conversation=${conversation.id.slice(0, 24)} checked=${audited.length} unchanged=${unchanged} modified=${modified} missing=${missing} skipped=${skipped}`,
    );
    if (modified === 0 && missing === 0) {
      return;
    }
    this.post({
      type: 'notice',
      level: 'warn',
      message:
        `${modified + missing} historical attachment(s) in this conversation no longer match the file on disk` +
        `${modified > 0 ? ` (${modified} changed, ${missing} unavailable)` : ''}.` +
        ' Restored requests replay the context captured at the time of each message; the current file contents are not substituted in.',
    });
  }

  /** Resolves a stored workspace-relative path, refusing anything that escapes the root. */
  private resolveStoredPath(root: vscode.WorkspaceFolder, storedPath: string): vscode.Uri | undefined {
    const normalized = normalizeContextPath(storedPath);
    if (
      normalized.length === 0 ||
      normalized.startsWith('/') ||
      /^[a-zA-Z]:[\\/]/.test(normalized) ||
      normalized.split('/').some((segment) => segment === '..' || segment.length === 0)
    ) {
      return undefined;
    }
    return vscode.Uri.joinPath(root.uri, ...normalized.split('/'));
  }

  private postHistory(): void {
    this.post({ type: 'history', history: this.history, warnings: this.restoreWarnings });
  }

  /** Keeps the reported provider-history counters in sync with the live session. */
  private refreshHistoryCounts(): void {
    if (this.conversation === undefined) {
      return;
    }
    this.history = {
      ...this.history,
      conversationId: this.conversation.id,
      messages: this.session.snapshot().length,
      chars: this.session.charCount,
      restored: this.session.snapshot().length > 0,
      transcriptMessages: this.storedMessages.length,
    };
  }

  /**
   * Keeps the provider session aligned with the durable transcript. Loading is
   * keyed by conversation id, so a re-shown webview can never replay the same
   * turns twice.
   */
  private syncHistoryBeforeSend(): void {
    if (this.conversation === undefined) {
      return;
    }
    if (this.historySourceId === this.conversation.id) {
      return;
    }
    this.refreshHistoryState({ ...this.conversation, messages: this.storedMessages }, 'send');
  }

  private transcript(): TranscriptMessage[] {
    return this.storedMessages.map((message) => {
      const stored = message.attachmentContext ?? [];
      return {
        role: message.role,
        text: message.text,
        attachments: message.attachments,
        attachmentDetails:
          message.role === 'user'
            ? displaysForStoredAttachments(
                stored,
                stored.length === 0 ? message.attachments : [],
              )
            : [],
        localOnly: message.localOnly === true,
      };
    });
  }

  /**
   * Conversations offered in the history dropdown. Empty records are excluded so
   * a New Chat placeholder can never be mistaken for the "New chat" action row,
   * except the one currently open, which is shown as the active empty chat.
   */
  private historyEntries(): ConversationMeta[] {
    const activeId = this.conversation?.id;
    return this.deps.conversations
      .list()
      .filter((entry) => entry.messageCount > 0 || entry.id === activeId);
  }

  private postConversations(): void {
    this.post({
      type: 'conversations',
      conversations: this.historyEntries(),
      activeConversationId: this.conversation?.id ?? '',
    });
  }

  private async persistConversation(): Promise<void> {
    if (this.conversation === undefined) {
      return;
    }
    const bounded = enforceAttachmentBudget(this.storedMessages);
    if (bounded.releasedAttachments > 0) {
      this.storedMessages = bounded.messages;
      this.deps.logger.warn(
        `attachment context released attachments=${bounded.releasedAttachments} chars=${bounded.releasedChars}`,
      );
      this.refreshHistoryState(
        { ...this.conversation, messages: this.storedMessages },
        'budget',
      );
      this.notifyWarning(
        `${bounded.releasedAttachments} older attachment context(s) were released from storage to keep this conversation within its budget. Their file names remain in the transcript, but their captured contents can no longer be resent.`,
      );
    }
    try {
      this.conversation = await this.deps.conversations.save({
        ...this.conversation,
        messages: this.storedMessages,
      });
    } catch (error) {
      this.deps.logger.error('conversation persist failed', error);
      this.notifyWarning(
        'The conversation could not be saved to workspace state. It stays available in this window.',
      );
    }
    this.postConversations();
  }

  private async recordUser(
    text: string,
    attachments: readonly string[],
    question?: string,
    attachmentContext?: readonly StoredAttachment[],
  ): Promise<void> {
    this.storedMessages.push({
      role: 'user',
      text,
      attachments,
      createdAt: new Date().toISOString(),
      ...(question === undefined || question === text ? {} : { question }),
      ...(attachmentContext === undefined || attachmentContext.length === 0
        ? {}
        : { attachmentContext }),
    });
    await this.persistConversation();
  }

  private async recordAssistant(
    text: string,
    addToSession = true,
    localOnly = false,
  ): Promise<void> {
    if (text.trim().length === 0) {
      return;
    }
    if (addToSession) {
      this.session.addAssistant(text);
    }
    this.storedMessages.push({
      role: 'assistant',
      text,
      attachments: [],
      createdAt: new Date().toISOString(),
      ...(localOnly ? { localOnly: true } : {}),
    });
    await this.persistConversation();
    if (addToSession) {
      this.refreshHistoryCounts();
      this.postHistory();
    }
  }

  private async switchConversation(id: string): Promise<void> {
    if (this.busy) {
      this.notifyWarning('Wait for the current request to finish before switching conversations.');
      return;
    }
    const conversation = this.deps.conversations.get(id);
    if (conversation === undefined) {
      this.notifyWarning('That conversation no longer exists.');
      this.postConversations();
      return;
    }
    this.cancelActive();
    this.requestSeq += 1;
    this.busy = false;
    this.conversation = conversation;
    this.storedMessages = [...conversation.messages];
    this.session.load(
      conversation.messages
        .filter((message) => message.localOnly !== true)
        .map((message) => ({ role: message.role, content: message.text })),
    );
    this.refreshHistoryState(conversation, 'switch');
    this.attachments = [];
    this.pendingDraft = undefined;
    await this.deps.conversations.setActive(id);
    this.post({ type: 'attachments', attachments: [] });
    this.post({ type: 'busy', busy: false });
    this.post({
      type: 'conversation',
      id: conversation.id,
      title: conversation.title,
      transcript: this.transcript(),
      history: this.history,
    });
    this.postHistory();
    for (const warning of this.restoreWarnings) {
      this.post({ type: 'notice', level: 'warn', message: warning });
    }
    this.postConversations();
  }

  /** Empties the active conversation only, after an explicit confirmation. */
  private async clearCurrentConversation(): Promise<void> {
    if (this.busy) {
      this.notifyWarning('Wait for the current request to finish before clearing a conversation.');
      return;
    }
    const conversation = this.conversation;
    if (conversation === undefined || this.storedMessages.length === 0) {
      this.notifyWarning('This conversation is already empty.');
      return;
    }
    if (!(await this.confirmDestructive(
      `Clear this conversation? Its ${this.storedMessages.length} message(s) are removed. Other conversations are not affected.`,
    ))) {
      return;
    }

    this.requestSeq += 1;
    this.cancelActive();
    this.busy = false;
    const cleared = await this.deps.conversations.clear(conversation.id);
    this.conversation = cleared ?? { ...conversation, messages: [] };
    this.storedMessages = [...this.conversation.messages];
    this.session.clear();
    this.historySourceId = this.conversation.id;
    this.history = { ...EMPTY_HISTORY, conversationId: this.conversation.id };
    this.restoreWarnings = [];
    this.attachments = [];
    this.pendingDraft = undefined;
    this.post({ type: 'clear' });
    this.post({ type: 'attachments', attachments: [] });
    this.post({ type: 'busy', busy: false });
    this.postHistory();
    this.postConversations();
    this.deps.logger.info(
      `conversation cleared id=${conversation.id.slice(0, 24)} remainingConversations=${this.deps.conversations.list().length}`,
    );
  }

  /**
   * Opens the conversation selected in the history dropdown. Without a selection
   * it falls back to the most recently updated conversation that still has
   * messages, so the action can never land on an empty New Chat placeholder.
   */
  private async restorePreviousConversation(id?: string): Promise<void> {
    if (id !== undefined && id === this.conversation?.id) {
      this.notifyInfo('That conversation is already open.');
      return;
    }
    const target =
      id !== undefined
        ? this.deps.conversations.get(id)
        : this.deps.conversations.mostRecent(this.conversation?.id);
    if (target === undefined) {
      this.notifyWarning(
        id !== undefined
          ? 'That conversation no longer exists.'
          : 'No other stored conversation is available to restore.',
      );
      this.postConversations();
      return;
    }
    if (target.messages.length === 0) {
      this.notifyWarning('That conversation is empty, so there is nothing to restore.');
      return;
    }
    await this.switchConversation(target.id);
  }

  private async confirmDestructive(message: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      `QuantsMind: ${message}`,
      { modal: true },
      'Yes, do it',
    );
    return choice === 'Yes, do it';
  }

  private async deleteConversation(id: string): Promise<void> {
    if (this.busy) {
      this.notifyWarning('Wait for the current request to finish before deleting a conversation.');
      return;
    }
    if (!(await this.confirmDestructive('Delete this conversation permanently? This cannot be undone.'))) {
      return;
    }
    const wasActive = this.conversation?.id === id;
    await this.deps.conversations.delete(id);
    if (wasActive) {
      this.resetConversationState();
      await this.ensureConversation();
      this.post({ type: 'clear' });
      this.post({ type: 'attachments', attachments: [] });
      const active = this.activeConversation();
      this.post({
        type: 'conversation',
        id: active?.id ?? '',
        title: active?.title ?? 'New chat',
        transcript: this.transcript(),
        history: this.history,
      });
      this.postHistory();
    }
    this.postConversations();
  }

  private resetConversationState(): void {
    this.conversation = undefined;
    this.storedMessages = [];
    this.session.clear();
    this.attachments = [];
    this.historySourceId = undefined;
    this.history = EMPTY_HISTORY;
    this.restoreWarnings = [];
  }

  private activeConversation(): Conversation | undefined {
    return this.conversation;
  }

  private async summarizeWorkspace(): Promise<void> {
    if (!this.requireTrust('summarize the workspace')) {
      return;
    }
    try {
      const summary = await this.deps.workspaceIndex.summarize();
      this.post({
        type: 'workspaceSummary',
        text: summary.text,
        fileCount: summary.fileCount,
        truncated: false,
      });
      await this.recordAssistant(
        `Workspace summary (local index; nothing was sent):\n\n${summary.text}`,
        false,
        true,
      );
    } catch (error) {
      this.deps.logger.error('workspace summary failed', error);
      this.post({
        type: 'notice',
        level: 'error',
        message: 'Could not summarize the workspace. See the QuantsMind log.',
      });
    }
  }

  private async inspectRepository(): Promise<void> {
    if (!this.requireTrust('inspect the repository')) {
      return;
    }
    try {
      const overview = await this.deps.workspaceIndex.repositoryOverview();
      if (overview === undefined) {
        this.post({
          type: 'notice',
          level: 'warn',
          message: 'Repository inspection is unavailable while the workspace is restricted.',
        });
        return;
      }
      const [architecture, karkainSummary, karkainGraph] = await Promise.all([
        this.deps.workspaceIndex.architectureAnalysis(),
        this.deps.workspaceIndex.karkainProject(),
        this.deps.workspaceIndex.karkainGraph(),
      ]);
      const graph = await this.deps.workspaceIndex.dependencyGraph();
      const dependents = new Map<string, number>();
      const dependencies = new Map<string, number>();
      for (const edge of graph?.edges ?? []) {
        dependents.set(edge.to, (dependents.get(edge.to) ?? 0) + 1);
        dependencies.set(edge.from, (dependencies.get(edge.from) ?? 0) + 1);
      }
      const hotspots = (graph?.nodes ?? [])
        .map((node) => ({
          path: node.path,
          dependents: dependents.get(node.path) ?? 0,
          dependencies: dependencies.get(node.path) ?? 0,
          publicApi: node.publicApi,
        }))
        .sort(
          (left, right) =>
            right.dependents - left.dependents ||
            right.dependencies - left.dependencies ||
            left.path.localeCompare(right.path),
        )
        .slice(0, 12);
      const repository: RepositoryView = {
        overview,
        summary: architectureSummary(overview),
        architecture,
        karkain:
          karkainSummary === undefined || karkainGraph === undefined
            ? undefined
            : { summary: karkainSummary, graph: karkainGraph },
        dependencies: {
          nodeCount: graph?.stats.nodeCount ?? 0,
          edgeCount: graph?.stats.edgeCount ?? 0,
          heuristicEdges: graph?.stats.heuristicEdges ?? 0,
          unresolvedCount: graph?.stats.unresolvedCount ?? 0,
          cycleCount: graph?.stats.cycleCount ?? 0,
          truncated: graph?.stats.truncated ?? false,
          hotspots,
          cycles: (graph?.cycles ?? []).slice(0, 8).map((cycle) => cycle.slice(0, 12)),
          unresolved: (graph?.unresolved ?? []).slice(0, 20).map((reference) => ({
            from: reference.from,
            specifier: reference.specifier,
            reason: reference.reason,
            confidence: reference.confidence,
          })),
        },
      };
      this.post({ type: 'repository', repository });
    } catch (error) {
      this.deps.logger.error('repository inspection failed', error);
      this.post({
        type: 'notice',
        level: 'error',
        message: 'Could not inspect the repository. See the QuantsMind log.',
      });
    }
  }

  private async inspectGitStatus(): Promise<void> {
    if (!this.requireTrust('inspect Git status')) {
      return;
    }
    const root = this.workspaceRoot();
    if (root === undefined) {
      this.notifyWarning('Open a workspace folder to inspect Git status.');
      return;
    }
    const rootPath = root.uri.fsPath;
    try {
      const info = await repoInfo(rootPath);
      if (!info.isRepository || info.root === undefined) {
        this.notifyWarning('This workspace is not a Git repository.');
        return;
      }
      const [entries, recent, state] = await Promise.all([
        status(rootPath),
        log(rootPath, 5),
        inProgressState(rootPath),
      ]);
      const staged = entries.filter((entry) => entry.staged).length;
      const modified = entries.filter((entry) => entry.unstaged).length;
      const untracked = entries.filter((entry) => entry.untracked).length;
      const deleted = entries.filter((entry) => entry.deleted).length;
      const conflicts = entries.filter((entry) => entry.conflict).length;

      // Best-effort GitHub counts. Local Git works without a credential; the GitHub
      // section is simply omitted when unavailable.
      let github: GitStatusView['github'] | undefined;
      if (info.defaultRemote !== undefined) {
        try {
          const remotes = await listRemotes(rootPath);
          const remoteUrl = remotes.find((remote) => remote.name === info.defaultRemote)?.url;
          const parsed = remoteUrl === undefined ? undefined : parseRemote(remoteUrl);
          const session = await vscode.authentication.getSession('github', ['repo', 'read:user'], {
            createIfNone: false,
          });
          if (parsed !== undefined && session !== undefined) {
            const [issues, pulls] = await Promise.all([
              this.githubArrayCount(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/issues?state=open&per_page=100`),
              this.githubArrayCount(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls?state=open&per_page=100`),
            ]);
            github = { openIssues: issues, openPullRequests: pulls, connected: true };
          }
        } catch {
          github = { openIssues: 0, openPullRequests: 0, connected: false };
        }
      }

      const snapshot: GitStatusView = {
        root: info.root,
        branch: info.branch ?? '(detached HEAD)',
        ...(info.headShort !== undefined ? { headShort: info.headShort } : {}),
        ...(info.defaultRemote !== undefined ? { remote: info.defaultRemote } : {}),
        staged,
        modified,
        untracked,
        deleted,
        conflicts,
        clean: entries.length === 0,
        mergeInProgress: state.merge,
        rebaseInProgress: state.rebase,
        entries: entries.map((entry) => ({ path: entry.path, state: entry.state })),
        log: recent.map((entry) => ({
          shortSha: entry.shortSha,
          subject: entry.subject,
          author: entry.author,
          date: entry.date,
        })),
        checkpoints: this.deps.agentRuntime.checkpointService.list().slice(0, 10).map((checkpoint) => ({
          id: checkpoint.id,
          taskId: checkpoint.taskId,
          ...(checkpoint.label !== undefined ? { label: checkpoint.label } : {}),
          fileCount: checkpoint.files.length,
          createdAt: checkpoint.createdAt,
        })),
        ...(github !== undefined ? { github } : {}),
      };
      this.post({ type: 'gitSnapshot', snapshot });
    } catch (error) {
      this.deps.logger.error('git status inspection failed', error);
      this.post({
        type: 'notice',
        level: 'error',
        message: 'Could not inspect Git status. See the QuantsMind log.',
      });
    }
  }

  private async githubArrayCount(url: string): Promise<number> {
    const session = await vscode.authentication.getSession('github', ['repo', 'read:user'], {
      createIfNone: false,
    });
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'QuantsMind-VSCode-AI-Coder',
        ...(session !== undefined ? { Authorization: `Bearer ${session.accessToken}` } : {}),
      },
    });
    if (!response.ok) {
      return 0;
    }
    const body = (await response.json().catch(() => [])) as unknown;
    return Array.isArray(body) ? body.length : 0;
  }

  private async explainRepositoryContext(query: string): Promise<void> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      this.notifyWarning('Type a request first so context selection can be explained.');
      return;
    }
    if (!this.requireTrust('explain context selection')) {
      return;
    }
    try {
      const workspaceSettings = this.deps.settings.getWorkspaceSettings();
      const contextSettings = this.deps.settings.getContextSettings();
      const selection = await this.deps.workspaceIndex.selectRepositoryContext(trimmed, {
        maxFiles: workspaceSettings.maxRetrievedFiles,
        maxChars: Math.min(workspaceSettings.retrievalMaxChars, contextSettings.maxTotalChars),
      });
      if (selection === undefined) {
        this.post({
          type: 'notice',
          level: 'warn',
          message: 'Context selection is unavailable while the workspace is restricted.',
        });
        return;
      }
      this.post({
        type: 'contextSelection',
        query: trimmed,
        selections: selection.selections,
        truncated: selection.truncated,
        text: explainContextSelection(selection),
      });
    } catch (error) {
      this.deps.logger.error('context selection explanation failed', error);
      this.post({
        type: 'notice',
        level: 'error',
        message: 'Could not explain context selection. See the QuantsMind log.',
      });
    }
  }

  private async attachRelevantFiles(query: string): Promise<void> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      this.notifyWarning('Type a request first so relevant files can be selected.');
      return;
    }
    if (!this.requireTrust('select relevant files')) {
      return;
    }
    try {
      const secret = await this.currentSecret();
      const retrieval = await this.deps.workspaceIndex.retrieve(trimmed, secret);
      let added = 0;
      for (const item of retrieval.items) {
        if (this.attachments.length >= this.deps.settings.getContextSettings().maxFiles) {
          break;
        }
        this.attachments.push({
          id: `attachment-${++this.attachmentSeq}`,
          path: item.path,
          content: item.content,
          languageId: item.languageId,
          isSelection: item.isSelection === true,
          startLine: item.startLine,
          endLine: item.endLine,
          redactions: item.redactions,
          source: 'workspace',
        });
        added += 1;
      }
      this.postAttachments();
      this.post({
        type: 'notice',
        level: added > 0 ? 'info' : 'warn',
        message:
          added > 0
            ? `Attached ${added} relevant file(s). Review them before sending.`
            : 'No relevant files were found. Attach files manually or refine the request.',
      });
    } catch (error) {
      this.deps.logger.error('relevant file retrieval failed', error);
      this.post({
        type: 'notice',
        level: 'error',
        message: 'Could not retrieve workspace files. See the QuantsMind log.',
      });
    }
  }

  private summarizeSession(view: AgentSessionView): SessionSummary {
    const completedTasks = view.tasks.filter((task) => task.status === 'completed').length;
    return {
      id: view.id,
      state: view.state,
      requirement: view.requirement.text,
      updatedAt: view.updatedAt,
      needsReview: view.needsReview,
      pausedFrom: view.pausedFrom,
      taskCount: view.tasks.length,
      completedTasks,
      pendingApproval: view.pendingApproval?.kind,
      reportOutcome: view.report?.outcome,
      activity: view.progress.activity,
      validation: view.progress.validation,
    };
  }

  private postSessions(): void {
    this.post({
      type: 'sessions',
      sessions: this.deps.agentRuntime.controller.list().map((view) => this.summarizeSession(view)),
      activeSessionId: this.activeSessionId,
    });
  }

  private setActiveSession(view: AgentSessionView): void {
    this.activeSessionId = view.id;
    this.post({ type: 'session', session: view });
    this.postSessions();
  }

  /**
   * Only the session currently displayed in this conversation is streamed to
   * the webview. Other sessions stay visible through the refreshable list.
   */
  private onSessionUpdate(view: AgentSessionView): void {
    if (this.activeSessionId === undefined || this.activeSessionId === view.id) {
      this.activeSessionId = view.id;
      this.post({ type: 'session', session: view });
    }
    this.postSessions();
  }

  private notifyWarning(message: string): void {
    if (this.ready) {
      this.post({ type: 'notice', level: 'warn', message });
    } else {
      void vscode.window.showWarningMessage(`QuantsMind: ${message}`);
    }
  }

  private notifyInfo(message: string): void {
    if (this.ready) {
      this.post({ type: 'notice', level: 'info', message });
    } else {
      void vscode.window.showInformationMessage(`QuantsMind: ${message}`);
    }
  }

  private post(message: HostToWebviewMessage): void {
    const view = this.view;
    if (view === undefined || !this.ready) {
      return;
    }
    void view.webview.postMessage(message).then(undefined, (error: unknown) => {
      this.deps.logger.warn(`webview message delivery failed: ${String(error)}`);
    });
  }

  private postAttachments(): void {
    this.post({
      type: 'attachments',
      attachments: this.attachments.map((attachment) => this.toSummary(attachment)),
    });
  }

  private toSummary(attachment: AttachmentBuffer): AttachmentSummary {
    return {
      id: attachment.id,
      path: attachment.path,
      languageId: attachment.languageId,
      isSelection: attachment.isSelection,
      startLine: attachment.startLine,
      endLine: attachment.endLine,
      chars: attachment.content.length,
      redactions: attachment.redactions,
      origin: attachment.source,
    };
  }

  private summaryFromItem(item: RedactedContextItem, index: number): AttachmentSummary {
    return {
      id: `sent-${index}`,
      path: item.path,
      languageId: item.languageId,
      isSelection: item.isSelection === true,
      startLine: item.startLine,
      endLine: item.endLine,
      chars: item.content.length,
      redactions: item.redactions,
      origin: item.origin,
    };
  }

  private async handleMessage(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        await this.sendInit();
        this.sendDraft();
        this.postExecutionHistory();
        break;
      case 'send':
        await this.handleSend(message.prompt, message.mode);
        break;
      case 'stop':
        if (this.sessionSource !== undefined && this.activeSessionId !== undefined) {
          this.sessionSource.cancel();
          await this.cancelSession(this.activeSessionId);
        } else {
          this.cancelActive();
        }
        break;
      case 'newChat':
        await this.startNewChat();
        break;
      case 'attachSelection': {
        const result = await this.attachFromEditor('selection');
        if (result.added === 0 && this.attachments.length === 0) {
          this.notifyWarning(
            `The selection could not be attached (${result.skipped[0] ?? 'no usable content'}).`,
          );
        }
        break;
      }
      case 'attachActiveFile': {
        const result = await this.attachFromEditor('file');
        if (result.added === 0 && this.attachments.length === 0) {
          this.notifyWarning(
            `The active file could not be attached (${result.skipped[0] ?? 'no usable content'}).`,
          );
        }
        break;
      }
      case 'attachFiles':
        await this.pickFiles();
        break;
      case 'removeAttachment':
        this.attachments = this.attachments.filter(
          (attachment) => attachment.id !== message.id,
        );
        this.postAttachments();
        break;
      case 'clearAttachments':
        this.attachments = [];
        this.postAttachments();
        break;
      case 'explainSelection':
        await this.requestSelection('explain', 'Explain the selected code.');
        break;
      case 'setApiKey':
        await vscode.commands.executeCommand(COMMANDS.setApiKey);
        await this.refreshStatus();
        break;
      case 'clearApiKey':
        await vscode.commands.executeCommand(COMMANDS.clearApiKey);
        await this.refreshStatus();
        break;
      case 'openSettings':
        await vscode.commands.executeCommand(COMMANDS.configureProvider);
        break;
      case 'showLog':
        await vscode.commands.executeCommand(COMMANDS.showLog);
        break;
      case 'refreshStatus':
        await this.refreshStatus();
        break;
      case 'selectProvider':
        await vscode.commands.executeCommand(COMMANDS.selectProvider);
        await this.refreshStatus();
        break;
      case 'selectModel':
        await vscode.commands.executeCommand(COMMANDS.selectModel);
        await this.refreshStatus();
        break;
      case 'startSession':
        await this.startSession(message.requirement);
        break;
      case 'approvePlan':
        if (!this.requireTrust('approve an agent plan')) {
          break;
        }
        await this.runSessionStep(
          message.sessionId,
          (token) =>
            this.deps.agentRuntime.controller.approvePlan(
              message.sessionId,
              token,
              message.requestId,
            ),
        );
        break;
      case 'rejectPlan':
        await this.runSessionAction(message.sessionId, () =>
          this.deps.agentRuntime.controller.rejectPlan(message.sessionId, message.requestId),
        );
        break;
      case 'approveChangeSet':
        if (!this.requireTrust('apply file changes')) {
          break;
        }
        await this.runSessionStep(
          message.sessionId,
          (token) =>
            this.deps.agentRuntime.controller.approveChanges(
              message.sessionId,
              message.ids,
              token,
              message.requestId,
            ),
        );
        break;
      case 'rejectChangeSet':
        await this.runSessionAction(message.sessionId, () =>
          this.deps.agentRuntime.controller.rejectChanges(message.sessionId, message.requestId),
        );
        break;
      case 'approveRepair':
        if (!this.requireTrust('apply repair changes')) {
          break;
        }
        await this.runSessionStep(
          message.sessionId,
          (token) =>
            this.deps.agentRuntime.controller.approveRepair(
              message.sessionId,
              message.ids,
              token,
              message.requestId,
            ),
        );
        break;
      case 'rejectRepair':
        await this.runSessionAction(message.sessionId, () =>
          this.deps.agentRuntime.controller.rejectRepair(message.sessionId, message.requestId),
        );
        break;
      case 'generateRepair':
        if (!this.requireTrust('request a repair')) {
          break;
        }
        await this.runSessionStep(
          message.sessionId,
          (token) =>
            this.deps.agentRuntime.controller.generateRepair(message.sessionId, token),
        );
        break;
      case 'requestValidation':
        if (!this.requireTrust('run validation commands')) {
          break;
        }
        await this.runSessionAction(message.sessionId, () =>
          this.deps.agentRuntime.controller.requestValidation(message.sessionId, message.command),
        );
        break;
      case 'approveValidation':
        if (!this.requireTrust('run the approved validation command')) {
          break;
        }
        await this.runApprovedValidation(message.sessionId, message.requestId);
        break;
      case 'rejectValidation':
        await this.runSessionAction(message.sessionId, () =>
          this.deps.agentRuntime.controller.rejectValidation(
            message.sessionId,
            message.requestId,
          ),
        );
        break;
      case 'pauseSession':
        await this.runSessionAction(message.sessionId, () =>
          this.deps.agentRuntime.controller.pause(message.sessionId),
        );
        break;
      case 'resumeSession':
        if (!this.requireTrust('resume an agent session')) {
          break;
        }
        await this.runSessionStep(
          message.sessionId,
          (token) => this.deps.agentRuntime.controller.resume(message.sessionId, token),
        );
        break;
      case 'cancelSession':
        await this.cancelSession(message.sessionId);
        break;
      case 'restoreSession':
        await this.restoreSession(message.sessionId);
        break;
      case 'deleteSession':
        await this.deleteSession(message.sessionId);
        break;
      case 'focusSession':
        this.focusSession(message.sessionId);
        break;
      case 'undoSession':
        await this.undoSession(message.sessionId);
        break;
      case 'refreshSessions':
        this.postSessions();
        break;
      case 'newConversation':
        await this.startNewChat();
        break;
      case 'clearConversation':
        await this.clearCurrentConversation();
        break;
      case 'restorePreviousConversation':
        await this.restorePreviousConversation(message.id);
        break;
      case 'switchConversation':
        await this.switchConversation(message.id);
        break;
      case 'deleteConversation':
        await this.deleteConversation(message.id);
        break;
      case 'summarizeWorkspace':
        await this.summarizeWorkspace();
        break;
      case 'inspectGitStatus':
        await this.inspectGitStatus();
        break;
      case 'inspectRepository':
        await this.inspectRepository();
        break;
      case 'explainRepositoryContext':
        await this.explainRepositoryContext(message.query);
        break;
      case 'attachRelevantFiles':
        await this.attachRelevantFiles(message.query);
        break;
      default:
        break;
    }
  }

  private async sendInit(): Promise<void> {
    try {
      await this.ensureConversation();
      if (!this.sessionsLoaded) {
        try {
          await this.deps.agentRuntime.controller.loadStoredSessions();
          this.sessionsLoaded = true;
        } catch (error) {
          this.deps.logger.error('failed to load stored agent sessions', error);
        }
      }
      const status = await this.deps.completion.getStatus();
      this.post({
        type: 'init',
        status,
        attachments: this.attachments.map((attachment) => this.toSummary(attachment)),
        maxPromptChars: LIMITS.maxPromptChars,
        version: this.deps.version,
        conversations: this.historyEntries(),
        activeConversationId: this.conversation?.id ?? '',
        transcript: this.transcript(),
        validationCommands: this.deps.settings.getCommandSettings().allowlist,
        workspaceName: this.workspaceRoot()?.name,
        sessions: this.deps.agentRuntime.controller
          .list()
          .map((view) => this.summarizeSession(view)),
        activeSessionId: this.activeSessionId,
        history: this.history,
      });
      for (const warning of this.restoreWarnings) {
        this.post({ type: 'notice', level: 'warn', message: warning });
      }
      if (this.activeSessionId !== undefined) {
        const view = this.deps.agentRuntime.controller.view(this.activeSessionId);
        if (view !== undefined) {
          this.post({ type: 'session', session: view });
        }
      }
      if (!this.trustState()) {
        this.post({
          type: 'notice',
          level: 'warn',
          message: RESTRICTED_MODE_FEATURE_NOTICE,
        });
      }
    } catch (error) {
      this.deps.logger.error('failed to build initial chat state', error);
      this.post({
        type: 'notice',
        level: 'error',
        message: 'Could not read provider configuration. See the QuantsMind log.',
      });
    }
  }

  private sendDraft(): void {
    if (!this.ready || this.pendingDraft === undefined) {
      return;
    }
    const draft = this.pendingDraft;
    this.pendingDraft = undefined;
    this.post({
      type: 'draft',
      prompt: draft.prompt,
      mode: draft.mode,
      attachments: this.attachments.map((attachment) => this.toSummary(attachment)),
    });
  }

  private async attachFromEditor(kind: 'selection' | 'file'): Promise<AddResult> {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      this.notifyWarning('Open a text editor first.');
      return { added: 0, skipped: ['no active editor'] };
    }

    const candidate =
      kind === 'selection'
        ? this.deps.contextService.fromSelection(editor)
        : this.deps.contextService.fromActiveFile(editor);

    if (candidate === undefined) {
      const reason = kind === 'selection' ? 'no non-empty selection' : 'empty editor';
      this.notifyWarning(
        kind === 'selection' ? 'Select some code first.' : 'The active editor is empty.',
      );
      return { added: 0, skipped: [reason] };
    }

    return this.addCandidates([candidate], 'user');
  }

  private async addCandidates(
    candidates: readonly ContextCandidate[],
    source: AttachmentOrigin,
  ): Promise<AddResult> {
    const secret = await this.currentSecret();
    const contextSettings = this.deps.settings.getContextSettings();
    const skipped: string[] = [];
    let added = 0;

    for (const candidate of candidates) {
      if (this.attachments.length >= contextSettings.maxFiles) {
        skipped.push(SKIP_LABELS.limit_files);
        break;
      }
      if (this.isDuplicate(candidate)) {
        skipped.push(SKIP_LABELS.duplicate);
        continue;
      }

      const built = await this.deps.contextService.build([candidate], secret);
      if (built.items.length === 0) {
        const reason = built.skipped[0]?.reason ?? 'empty';
        skipped.push(SKIP_LABELS[reason]);
        continue;
      }

      const item = built.items[0];
      const currentChars = this.attachments.reduce(
        (total, attachment) => total + attachment.content.length,
        0,
      );
      if (currentChars + item.content.length > contextSettings.maxTotalChars) {
        skipped.push(SKIP_LABELS.limit_chars);
        continue;
      }

      this.attachments.push({
        id: `attachment-${++this.attachmentSeq}`,
        path: item.path,
        content: item.content,
        languageId: item.languageId,
        isSelection: item.isSelection === true,
        startLine: item.startLine,
        endLine: item.endLine,
        redactions: item.redactions,
        source,
      });
      added += 1;
    }

    if (skipped.length > 0) {
      const unique = [...new Set(skipped)];
      this.post({
        type: 'notice',
        level: 'warn',
        message: `Skipped ${skipped.length} attachment(s): ${unique.join(', ')}.`,
      });
    }

    if (added > 0) {
      this.postAttachments();
    }

    return { added, skipped };
  }

  private isDuplicate(candidate: ContextCandidate): boolean {
    const path = normalizeContextPath(candidate.path);
    return this.attachments.some(
      (attachment) =>
        normalizeContextPath(attachment.path) === path &&
        attachment.isSelection === (candidate.isSelection === true) &&
        attachment.startLine === candidate.startLine &&
        attachment.endLine === candidate.endLine,
    );
  }

  private async pickFiles(): Promise<void> {
    if (!this.requireTrust('list workspace files')) {
      return;
    }
    let files: vscode.Uri[];
    try {
      files = await this.deps.contextService.listAttachableFiles();
    } catch (error) {
      this.deps.logger.error('failed to list workspace files', error);
      this.notifyWarning('Could not list workspace files. See the QuantsMind log.');
      return;
    }

    if (files.length === 0) {
      this.notifyWarning('No attachable workspace files were found.');
      return;
    }

    interface FilePickItem extends vscode.QuickPickItem {
      readonly uri: vscode.Uri;
    }

    const items: FilePickItem[] = files.map((uri) => ({
      label: this.deps.contextService.displayPath(uri),
      uri,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: 'Attach files to QuantsMind',
      placeHolder: 'Sensitive paths, dependencies, and build output are excluded',
      matchOnDescription: true,
    });

    if (picked === undefined || picked.length === 0) {
      return;
    }

    const read = await this.deps.contextService.readUris(picked.map((item) => item.uri));
    if (read.failures.length > 0) {
      this.deps.logger.warn(
        `failed to read ${read.failures.length} selected file(s) for context`,
      );
      this.post({
        type: 'notice',
        level: 'warn',
        message: `Could not read ${read.failures.length} selected file(s). See the QuantsMind log.`,
      });
    }

    await this.addCandidates(read.candidates, 'user');
  }

  private async providerReadiness(): Promise<ProviderStatus | undefined> {
    let status: ProviderStatus;
    try {
      status = await this.deps.completion.getStatus();
    } catch (error) {
      this.deps.logger.error('failed to read provider status before send', error);
      this.post({
        type: 'error',
        message: 'Could not read the provider configuration.',
        hint: 'Open the QuantsMind provider settings or show the log.',
        code: 'configuration',
      });
      return undefined;
    }
    if (status.configurationError !== undefined) {
      this.post({
        type: 'error',
        message: status.configurationError,
        hint: errorHint('configuration'),
        code: 'configuration',
      });
      return undefined;
    }
    if (!status.ready) {
      this.post({
        type: 'error',
        message: 'No API key is configured for this provider.',
        hint: errorHint('authentication'),
        code: 'authentication',
      });
      return undefined;
    }
    return status;
  }

  private async startSession(rawPrompt: string): Promise<void> {
    if (this.busy || this.sessionSource !== undefined) {
      this.post({ type: 'notice', level: 'warn', message: 'A request is already running.' });
      return;
    }
    const requirement = rawPrompt.trim();
    if (requirement.length === 0) {
      this.post({
        type: 'notice',
        level: 'warn',
        message: 'Describe the requirement before starting an agent session.',
      });
      return;
    }
    if (requirement.length > LIMITS.maxPromptChars) {
      this.post({
        type: 'notice',
        level: 'warn',
        message: `The requirement exceeds the ${LIMITS.maxPromptChars.toLocaleString()} character limit.`,
      });
      return;
    }
    if (this.workspaceRoot() === undefined) {
      this.post({
        type: 'error',
        message: 'Open a workspace folder before using agent mode.',
        hint: 'Agent mode needs a workspace to inspect, retrieve context from, and apply approved changes to.',
        code: 'configuration',
      });
      return;
    }
    if (!this.trustState()) {
      this.post({
        type: 'error',
        message: 'Workspace trust is required before starting an agent session.',
        hint: 'Restricted Mode blocks workspace inspection, file changes, repairs, and validation commands. Chat with files you attach yourself still works.',
        code: 'configuration',
      });
      return;
    }

    const status = await this.providerReadiness();
    if (status === undefined) {
      return;
    }

    this.attachments = [];
    this.post({ type: 'attachments', attachments: [] });
    await this.ensureConversation();
    this.busy = true;
    this.post({ type: 'busy', busy: true });
    await this.recordUser(requirement, []);
    this.session.addUser(requirement);
    this.post({ type: 'userMessage', text: requirement, attachments: [] });

    await this.runSessionStep(undefined, (token) =>
      this.deps.agentRuntime.controller.start(requirement, token),
    );
  }

  private async runSessionStep(
    sessionId: string | undefined,
    action: (token: vscode.CancellationToken) => Promise<AgentSessionView>,
  ): Promise<void> {
    if (this.sessionSource !== undefined) {
      this.post({
        type: 'notice',
        level: 'warn',
        message: 'The previous agent step is still running.',
      });
      return;
    }

    const source = new vscode.CancellationTokenSource();
    this.sessionSource = source;
    this.busy = true;
    this.post({ type: 'busy', busy: true });

    const timeoutMs = this.deps.settings.getAgentSettings().timeoutMs;
    this.sessionTimer = setTimeout(() => {
      source.cancel();
      if (sessionId !== undefined) {
        void this.deps.agentRuntime.controller
          .cancel(sessionId)
          .then((view) => this.setActiveSession(view))
          .catch((error: unknown) => {
            this.deps.logger.warn(`session cancellation after timeout failed: ${String(error)}`);
          });
      }
      this.post({
        type: 'notice',
        level: 'warn',
        message: `The agent step exceeded the ${timeoutMs.toLocaleString()} ms limit and was stopped.`,
      });
    }, timeoutMs);

    try {
      const view = await action(source.token);
      this.setActiveSession(view);
      if (view.state === 'failed' && view.error !== undefined) {
        this.post({
          type: 'sessionError',
          sessionId: view.id,
          message: view.error,
          hint: 'Review the session timeline and evidence, then adjust the configuration or requirement.',
        });
      }
    } catch (error) {
      this.postSessionError(error, sessionId);
    } finally {
      if (this.sessionTimer !== undefined) {
        clearTimeout(this.sessionTimer);
        this.sessionTimer = undefined;
      }
      if (this.sessionSource === source) {
        this.sessionSource = undefined;
      }
      source.dispose();
      this.busy = false;
      this.post({ type: 'busy', busy: false });
    }
  }

  private async runSessionAction(
    _sessionId: string,
    action: () => Promise<AgentSessionView>,
  ): Promise<void> {
    if (this.sessionSource !== undefined) {
      this.post({
        type: 'notice',
        level: 'warn',
        message: 'The previous agent step is still running.',
      });
      return;
    }
    this.busy = true;
    this.post({ type: 'busy', busy: true });
    try {
      this.setActiveSession(await action());
    } catch (error) {
      this.postSessionError(error, _sessionId);
    } finally {
      this.busy = false;
      this.post({ type: 'busy', busy: false });
    }
  }

  private async cancelSession(sessionId: string): Promise<void> {
    if (sessionId.length === 0) {
      return;
    }
    try {
      this.sessionSource?.cancel();
      this.setActiveSession(await this.deps.agentRuntime.controller.cancel(sessionId));
    } catch (error) {
      this.postSessionError(error, sessionId);
    }
  }

  private async restoreSession(sessionId: string): Promise<void> {
    if (this.sessionSource !== undefined) {
      this.post({
        type: 'notice',
        level: 'warn',
        message: 'Wait for the running agent step before restoring a session.',
      });
      return;
    }
    this.busy = true;
    this.post({ type: 'busy', busy: true });
    try {
      const view = await this.deps.agentRuntime.controller.restore(sessionId);
      if (view === undefined) {
        this.post({
          type: 'sessionError',
          sessionId,
          message: 'The stored session could not be restored in this workspace.',
        });
        return;
      }
      this.setActiveSession(view);
      if (view.needsReview) {
        this.post({
          type: 'notice',
          level: 'warn',
          message:
            view.error ??
            'The session state needs review before it can continue. Applied files are revalidated before resume.',
        });
      }
    } catch (error) {
      this.postSessionError(error, sessionId);
    } finally {
      this.busy = false;
      this.post({ type: 'busy', busy: false });
    }
  }

  private async deleteSession(sessionId: string): Promise<void> {
    try {
      await this.deps.agentRuntime.controller.remove(sessionId);
      if (this.activeSessionId === sessionId) {
        this.activeSessionId = undefined;
        this.post({ type: 'sessionRemoved', id: sessionId });
      }
      this.postSessions();
    } catch (error) {
      this.postSessionError(error, sessionId);
    }
  }

  private focusSession(sessionId: string): void {
    const view = this.deps.agentRuntime.controller.view(sessionId);
    if (view === undefined) {
      this.post({
        type: 'sessionError',
        sessionId,
        message: 'That session is not loaded. Restore it from storage first.',
      });
      return;
    }
    this.setActiveSession(view);
  }

  private async undoSession(sessionId: string): Promise<void> {
    if (!this.requireTrust('undo file changes')) {
      return;
    }
    const view = this.deps.agentRuntime.controller.view(sessionId);
    const execution = view?.executions
      .filter((entry) => entry.historyTaskId !== undefined)
      .slice(-1)[0];
    if (execution?.historyTaskId === undefined) {
      this.post({
        type: 'notice',
        level: 'warn',
        message: 'This session has no applied change set with backups to restore.',
      });
      return;
    }
    try {
      const outcome = await this.deps.changeService.undo(execution.historyTaskId);
      if (outcome === undefined) {
        this.post({
          type: 'notice',
          level: 'warn',
          message: 'The change history has no backups for this session.',
        });
        return;
      }
      this.post({
        type: 'undoResult',
        taskId: execution.historyTaskId,
        restored: outcome.restored,
        conflicts: outcome.conflicts,
        messages: outcome.results
          .filter((entry) => entry.message !== undefined)
          .map((entry) => entry.message as string),
      });
      this.post({
        type: 'notice',
        level: outcome.conflicts === 0 ? 'info' : 'warn',
        message:
          outcome.conflicts === 0
            ? 'The applied files were restored from backups. The session report keeps its original evidence.'
            : 'Some files could not be restored because they changed after apply.',
      });
    } catch (error) {
      this.deps.logger.error('session undo failed', error);
      this.post({
        type: 'notice',
        level: 'error',
        message: 'Undo failed. See the QuantsMind log.',
      });
    }
  }

  private async runApprovedValidation(sessionId: string, requestId: string): Promise<void> {
    if (this.sessionSource !== undefined) {
      this.post({
        type: 'notice',
        level: 'warn',
        message: 'The previous agent step is still running.',
      });
      return;
    }
    const controller = new AbortController();
    const timeoutMs = this.deps.settings.getCommandSettings().timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs + 5_000);
    this.busy = true;
    this.post({ type: 'busy', busy: true });
    try {
      const view = await this.deps.agentRuntime.controller.approveValidation(
        sessionId,
        requestId,
        controller.signal,
      );
      this.setActiveSession(view);
      const run = view.validationRuns[view.validationRuns.length - 1];
      const evidence = run?.evidence;
      if (run !== undefined && run.outcome === 'passed' && view.state === 'validating') {
        this.post({
          type: 'notice',
          level: 'warn',
          message:
            'The command passed, but the result does not match the change set it would verify, so the session did not advance.',
        });
      }
      if (run !== undefined && evidence === undefined) {
        this.post({
          type: 'notice',
          level: 'warn',
          message: `Validation ${run.outcome}: ${run.detail ?? 'no command was executed.'}`,
        });
      } else if (evidence !== undefined) {
        this.post({
          type: 'commandOutput',
          command: evidence.command,
          cwd: this.workspaceRoot()?.uri.fsPath ?? '.',
          output: evidence.output,
          exitCode: evidence.exitCode,
          timedOut: evidence.timedOut,
          cancelled: evidence.cancelled,
        });
      }
    } catch (error) {
      this.postSessionError(error, sessionId);
    } finally {
      clearTimeout(timer);
      this.busy = false;
      this.post({ type: 'busy', busy: false });
    }
  }

  private postSessionError(error: unknown, sessionId?: string): void {
    if (error instanceof AgentSessionError) {
      this.post({ type: 'sessionError', sessionId, message: error.message });
      return;
    }
    const providerError = isProviderError(error) ? error : normalizeThrownError(error);
    if (providerError.code === 'cancelled') {
      return;
    }
    this.post({
      type: 'sessionError',
      sessionId,
      message: providerError.message,
      hint: errorHint(providerError.code),
    });
  }

  private async handleSend(rawPrompt: string, mode: ChatMode): Promise<void> {
    if (isAgentMode(mode)) {
      await this.runCodingAgentAndReveal(rawPrompt);
      return;
    }
    if (this.busy) {
      this.post({ type: 'notice', level: 'warn', message: 'A request is already running.' });
      return;
    }

    // Discovery can only have run while the workspace was trusted. If trust was
    // withdrawn since, the buffered content must not reach the provider even
    // though the user never removed it by hand.
    if (!this.trustState()) {
      const discovered = this.attachments.filter((attachment) => attachment.source === 'workspace');
      if (discovered.length > 0) {
        this.attachments = this.attachments.filter(
          (attachment) => attachment.source !== 'workspace',
        );
        this.postAttachments();
        this.notifyWarning(
          `${discovered.length} automatically discovered attachment(s) were removed because this workspace is in Restricted Mode. Attach files yourself, or trust the workspace to use discovery.`,
        );
      }
    }

    const prompt = rawPrompt.trim();
    if (prompt.length > LIMITS.maxPromptChars) {
      this.post({
        type: 'notice',
        level: 'warn',
        message: `The prompt exceeds the ${LIMITS.maxPromptChars.toLocaleString()} character limit.`,
      });
      return;
    }
    if (prompt.length === 0 && this.attachments.length === 0) {
      this.post({
        type: 'notice',
        level: 'warn',
        message: 'Add a question or attach code first.',
      });
      return;
    }

    const status = await this.providerReadiness();
    if (status === undefined) {
      return;
    }

    const secret = await this.currentSecret();
    const built = await this.deps.contextService.build(
      this.attachments.map((attachment) => ({
        path: attachment.path,
        content: attachment.content,
        languageId: attachment.languageId,
        isSelection: attachment.isSelection,
        startLine: attachment.startLine,
        endLine: attachment.endLine,
        origin: attachment.source,
      })),
      secret,
    );

    if (built.skipped.length > 0) {
      const reasons = [...new Set(built.skipped.map((item) => SKIP_LABELS[item.reason]))];
      this.post({
        type: 'notice',
        level: 'warn',
        message: `Skipped ${built.skipped.length} attachment(s) at send time: ${reasons.join(', ')}.`,
      });
    }

    await this.ensureConversation();
    this.syncHistoryBeforeSend();

    const messages = buildMessages({
      mode,
      question: prompt,
      attachments: built.items,
      history: this.session.snapshot(),
    });
    const userContent = messages[messages.length - 1]?.content ?? prompt;
    this.session.addUser(userContent);

    const displayPrompt = prompt.length > 0 ? prompt : DEFAULT_QUESTIONS[mode];
    const attachmentLabels = built.items.map((item) =>
      item.isSelection === true && item.startLine !== undefined
        ? `${item.path}:${item.startLine}-${item.endLine ?? item.startLine}`
        : item.path,
    );
    const captured = captureAttachments(built.items, new Date().toISOString());
    await this.recordUser(displayPrompt, attachmentLabels, prompt, captured.captured);
    if (captured.dropped.length > 0) {
      this.notifyWarning(droppedContentNotice(captured.dropped));
    }

    const breakdown = measureRequest(messages, {
      promptChars: prompt.length,
      attachmentItems: built.items.length,
      attachmentChars: built.items.reduce((sum, item) => sum + item.content.length, 0),
    });
    const requestId = ++this.requestSeq;
    this.deps.logger.info(
      `request context id=${requestId} provider=${status.providerType} model=${status.model} mode=${mode} stream=${this.deps.settings.getProviderSettings().stream ? 'on' : 'off'} ${formatRequestBreakdown(breakdown)} capturedAttachments=${captured.captured.length} capturedChars=${captured.chars} dropped=${captured.dropped.length}`,
    );
    this.post({
      type: 'requestContext',
      id: `request-${requestId}`,
      breakdown,
      attachments: displaysForStoredAttachments(captured.captured, []),
    });

    const assistantId = `assistant-${requestId}`;
    this.attachments = [];
    this.postAttachments();
    this.busy = true;
    this.post({ type: 'busy', busy: true });
    this.post({
      type: 'userMessage',
      text: displayPrompt,
      attachments: built.items.map((item, index) => this.summaryFromItem(item, index)),
    });
    this.post({ type: 'assistantStart', id: assistantId, model: status.model });

    const source = new vscode.CancellationTokenSource();
    this.cancelSource = source;

    try {
      const result = await this.deps.completion.complete(messages, {
        token: source.token,
        onDelta: (delta: string) => {
          if (requestId === this.requestSeq) {
            this.post({ type: 'assistantDelta', id: assistantId, delta });
          }
        },
      });

      if (requestId !== this.requestSeq) {
        return;
      }

      await this.recordAssistant(result.text);
      this.post({
        type: 'assistantEnd',
        id: assistantId,
        finishReason: result.finishReason,
        usage: result.usage,
      });
    } catch (error) {
      if (requestId !== this.requestSeq) {
        return;
      }

      const providerError = isProviderError(error)
        ? error
        : normalizeThrownError(error);
      if (providerError.code === 'cancelled') {
        this.post({ type: 'assistantCancelled', id: assistantId });
      } else {
        this.post({
          type: 'error',
          message: providerError.message,
          hint: errorHint(providerError.code),
          code: providerError.code,
        });
      }
    } finally {
      source.dispose();
      if (this.cancelSource === source) {
        this.cancelSource = undefined;
      }
      if (requestId === this.requestSeq) {
        this.busy = false;
        this.post({ type: 'busy', busy: false });
      }
    }
  }
}
