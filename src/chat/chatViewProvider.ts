import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { AgentRuntime } from '../agent/runtime';
import type { AgentSessionView } from '../agent/models';
import { AgentSessionError } from '../agent/orchestrator';
import type { ChangeService } from '../changes/changeService';
import type { WorkspaceIndexService } from '../workspace/indexService';
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
  buildMessages,
  DEFAULT_QUESTIONS,
  isAgentMode,
  type ChatMode,
} from './prompts';
import {
  ConversationStore,
  type Conversation,
  type StoredMessage,
} from './persistence';
import {
  parseWebviewMessage,
  type AttachmentSummary,
  type HostToWebviewMessage,
  type SessionSummary,
  type WebviewToHostMessage,
} from './protocol';
import { ChatSession } from './session';
import { renderChatHtml } from './webviewHtml';

interface AttachmentBuffer {
  readonly id: string;
  readonly path: string;
  readonly content: string;
  readonly languageId?: string;
  readonly isSelection: boolean;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly redactions: number;
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
  private readonly sessionSubscription: { dispose(): void };

  constructor(private readonly deps: ChatViewDependencies) {
    this.sessionSubscription = deps.agentRuntime.subscribe((view) => this.onSessionUpdate(view));
  }

  private workspaceRoot(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
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

    const result = await this.addCandidates([candidate]);
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
    const conversation = this.deps.conversations.create();
    this.conversation = await this.deps.conversations.save(conversation);
    this.post({ type: 'busy', busy: false });
    this.post({ type: 'attachments', attachments: [] });
    this.post({ type: 'clear' });
    this.postConversations();
    this.postSessions();
    void this.refreshStatus();
  }

  dispose(): void {
    this.requestSeq += 1;
    this.cancelActive();
    this.cancelSessionStep();
    this.sessionSubscription.dispose();
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
        existing.messages.map((message) => ({ role: message.role, content: message.text })),
      );
      return;
    }
    const created = this.deps.conversations.create();
    this.conversation = await this.deps.conversations.save(created);
    this.storedMessages = [];
    this.session.clear();
  }

  private transcript(): { role: 'user' | 'assistant'; text: string; attachments: readonly string[] }[] {
    return this.storedMessages.map((message) => ({
      role: message.role,
      text: message.text,
      attachments: message.attachments,
    }));
  }

  private postConversations(): void {
    this.post({
      type: 'conversations',
      conversations: this.deps.conversations.list(),
      activeConversationId: this.conversation?.id ?? '',
    });
  }

  private async persistConversation(): Promise<void> {
    if (this.conversation === undefined) {
      return;
    }
    this.conversation = await this.deps.conversations.save({
      ...this.conversation,
      messages: this.storedMessages,
    });
    this.postConversations();
  }

  private async recordUser(text: string, attachments: readonly string[]): Promise<void> {
    this.storedMessages.push({
      role: 'user',
      text,
      attachments,
      createdAt: new Date().toISOString(),
    });
    await this.persistConversation();
  }

  private async recordAssistant(text: string, addToSession = true): Promise<void> {
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
    });
    await this.persistConversation();
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
      conversation.messages.map((message) => ({ role: message.role, content: message.text })),
    );
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
    });
    this.postConversations();
  }

  private async deleteConversation(id: string): Promise<void> {
    if (this.busy) {
      this.notifyWarning('Wait for the current request to finish before deleting a conversation.');
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
      });
    }
    this.postConversations();
  }

  private resetConversationState(): void {
    this.conversation = undefined;
    this.storedMessages = [];
    this.session.clear();
    this.attachments = [];
  }

  private activeConversation(): Conversation | undefined {
    return this.conversation;
  }

  private async summarizeWorkspace(): Promise<void> {
    try {
      const summary = await this.deps.workspaceIndex.summarize();
      this.post({
        type: 'workspaceSummary',
        text: summary.text,
        fileCount: summary.fileCount,
        truncated: false,
      });
      await this.recordAssistant(`Workspace summary (local index; nothing was sent):\n\n${summary.text}`, false);
    } catch (error) {
      this.deps.logger.error('workspace summary failed', error);
      this.post({
        type: 'notice',
        level: 'error',
        message: 'Could not summarize the workspace. See the QuantsMind log.',
      });
    }
  }

  private async attachRelevantFiles(query: string): Promise<void> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      this.notifyWarning('Type a request first so relevant files can be selected.');
      return;
    }
    try {
      const secret = await this.deps.secrets.get();
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
    };
  }

  private async handleMessage(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        await this.sendInit();
        this.sendDraft();
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
        this.startNewChat();
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
      case 'startSession':
        await this.startSession(message.requirement);
        break;
      case 'approvePlan':
        await this.runSessionStep(
          message.sessionId,
          (token) => this.deps.agentRuntime.controller.approvePlan(message.sessionId, token),
        );
        break;
      case 'rejectPlan':
        await this.runSessionAction(message.sessionId, () =>
          this.deps.agentRuntime.controller.rejectPlan(message.sessionId),
        );
        break;
      case 'approveChangeSet':
        await this.runSessionStep(
          message.sessionId,
          (token) =>
            this.deps.agentRuntime.controller.approveChanges(
              message.sessionId,
              message.ids,
              token,
            ),
        );
        break;
      case 'rejectChangeSet':
        await this.runSessionAction(message.sessionId, () =>
          this.deps.agentRuntime.controller.rejectChanges(message.sessionId),
        );
        break;
      case 'approveRepair':
        await this.runSessionStep(
          message.sessionId,
          (token) =>
            this.deps.agentRuntime.controller.approveRepair(
              message.sessionId,
              message.ids,
              token,
            ),
        );
        break;
      case 'rejectRepair':
        await this.runSessionAction(message.sessionId, () =>
          this.deps.agentRuntime.controller.rejectRepair(message.sessionId),
        );
        break;
      case 'generateRepair':
        await this.runSessionStep(
          message.sessionId,
          (token) =>
            this.deps.agentRuntime.controller.generateRepair(message.sessionId, token),
        );
        break;
      case 'validateSession':
        await this.validateSession(message.sessionId, message.command);
        break;
      case 'pauseSession':
        await this.runSessionAction(message.sessionId, () =>
          this.deps.agentRuntime.controller.pause(message.sessionId),
        );
        break;
      case 'resumeSession':
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
      case 'switchConversation':
        await this.switchConversation(message.id);
        break;
      case 'deleteConversation':
        await this.deleteConversation(message.id);
        break;
      case 'summarizeWorkspace':
        await this.summarizeWorkspace();
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
        conversations: this.deps.conversations.list(),
        activeConversationId: this.conversation?.id ?? '',
        transcript: this.transcript(),
        validationCommands: this.deps.settings.getCommandSettings().allowlist,
        workspaceName: this.workspaceRoot()?.name,
        sessions: this.deps.agentRuntime.controller
          .list()
          .map((view) => this.summarizeSession(view)),
        activeSessionId: this.activeSessionId,
      });
      if (this.activeSessionId !== undefined) {
        const view = this.deps.agentRuntime.controller.view(this.activeSessionId);
        if (view !== undefined) {
          this.post({ type: 'session', session: view });
        }
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

    return this.addCandidates([candidate]);
  }

  private async addCandidates(candidates: readonly ContextCandidate[]): Promise<AddResult> {
    const secret = await this.deps.secrets.get();
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

    await this.addCandidates(read.candidates);
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

  private async validateSession(sessionId: string, command: string): Promise<void> {
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
      const view = await this.deps.agentRuntime.controller.validate(
        sessionId,
        command,
        controller.signal,
      );
      this.setActiveSession(view);
      const run = view.validationRuns[view.validationRuns.length - 1];
      if (run !== undefined) {
        this.post({
          type: 'commandOutput',
          command: run.evidence.command,
          cwd: this.workspaceRoot()?.uri.fsPath ?? '.',
          output: run.evidence.output,
          exitCode: run.evidence.exitCode,
          timedOut: run.evidence.timedOut,
          cancelled: run.evidence.cancelled,
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
      await this.startSession(rawPrompt);
      return;
    }
    if (this.busy) {
      this.post({ type: 'notice', level: 'warn', message: 'A request is already running.' });
      return;
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

    const secret = await this.deps.secrets.get();
    const built = await this.deps.contextService.build(
      this.attachments.map((attachment) => ({
        path: attachment.path,
        content: attachment.content,
        languageId: attachment.languageId,
        isSelection: attachment.isSelection,
        startLine: attachment.startLine,
        endLine: attachment.endLine,
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
    await this.ensureConversation();
    await this.recordUser(displayPrompt, attachmentLabels);

    const requestId = ++this.requestSeq;
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
