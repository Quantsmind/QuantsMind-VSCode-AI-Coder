import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { AgentTaskView, TaskStatus } from '../agent/taskRunner';
import { AgentTaskRunner } from '../agent/taskRunner';
import type { ChangeService } from '../changes/changeService';
import type { WorkspaceIndexService } from '../workspace/indexService';
import { runApprovedCommand } from '../commands/runner';
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
  private activeTaskId: string | undefined;
  private taskSource: vscode.CancellationTokenSource | undefined;
  private taskTimer: NodeJS.Timeout | undefined;
  private readonly lastTaskStatus = new Map<string, TaskStatus>();
  private readonly taskRunner: AgentTaskRunner;

  constructor(private readonly deps: ChatViewDependencies) {
    this.taskRunner = new AgentTaskRunner({
      complete: (messages, token) =>
        this.deps.completion.complete(messages, {
          token,
        }),
      retrieve: async (query, token) => {
        void token;
        const secret = await this.currentSecret();
        return this.deps.workspaceIndex.retrieve(query, secret);
      },
      changes: deps.changeService,
      runCommand: async (command, signal) => {
        const root = this.workspaceRoot();
        if (root === undefined) {
          throw new Error('Open a workspace folder before running validation.');
        }
        const commandSettings = this.deps.settings.getCommandSettings();
        return runApprovedCommand(command, {
          cwd: root.uri.fsPath,
          workspaceRoot: root.uri.fsPath,
          allowlist: commandSettings.allowlist,
          timeoutMs: commandSettings.timeoutMs,
          maxOutputChars: commandSettings.maxOutputChars,
          secret: await this.currentSecret(),
          signal,
        });
      },
      agentSettings: () => this.deps.settings.getAgentSettings(),
      logger: this.deps.logger,
      onChange: (task) => this.onTaskUpdate(task),
    });
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
    await this.startTask(prompt);
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
    if (this.activeTaskId !== undefined && this.lastTaskStatus.get(this.activeTaskId) === 'awaiting-approval') {
      this.notifyWarning('Approve or reject the pending change review first.');
      return;
    }
    this.requestSeq += 1;
    this.cancelActive();
    this.cancelTask();
    this.busy = false;
    this.session.clear();
    this.storedMessages = [];
    this.attachments = [];
    this.pendingDraft = undefined;
    this.activeTaskId = undefined;
    const conversation = this.deps.conversations.create();
    this.conversation = await this.deps.conversations.save(conversation);
    this.post({ type: 'busy', busy: false });
    this.post({ type: 'attachments', attachments: [] });
    this.post({ type: 'clear' });
    this.postConversations();
    void this.refreshStatus();
  }

  dispose(): void {
    this.requestSeq += 1;
    this.cancelActive();
    this.cancelTask();
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

  private cancelTask(): void {
    if (this.taskTimer !== undefined) {
      clearTimeout(this.taskTimer);
      this.taskTimer = undefined;
    }
    const source = this.taskSource;
    this.taskSource = undefined;
    source?.cancel();
    source?.dispose();
    if (this.activeTaskId !== undefined) {
      this.taskRunner.cancel(this.activeTaskId);
    }
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
    if (this.activeTaskId !== undefined && this.lastTaskStatus.get(this.activeTaskId) === 'awaiting-approval') {
      this.notifyWarning('Approve or reject the pending change review first.');
      return;
    }
    const conversation = this.deps.conversations.get(id);
    if (conversation === undefined) {
      this.notifyWarning('That conversation no longer exists.');
      this.postConversations();
      return;
    }
    this.cancelActive();
    this.cancelTask();
    this.requestSeq += 1;
    this.busy = false;
    this.conversation = conversation;
    this.storedMessages = [...conversation.messages];
    this.session.load(
      conversation.messages.map((message) => ({ role: message.role, content: message.text })),
    );
    this.attachments = [];
    this.pendingDraft = undefined;
    this.activeTaskId = undefined;
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
    this.cancelTask();
    this.activeTaskId = undefined;
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

  private onTaskUpdate(task: AgentTaskView): void {
    if (this.activeTaskId === undefined || this.activeTaskId !== task.id) {
      this.activeTaskId = task.id;
    }
    const previous = this.lastTaskStatus.get(task.id);
    this.lastTaskStatus.set(task.id, task.status);

    if (this.taskSource !== undefined && this.taskTimer === undefined && task.status === 'running') {
      const timeoutMs = this.deps.settings.getAgentSettings().timeoutMs;
      this.taskTimer = setTimeout(() => {
        this.taskRunner.cancel(task.id);
        this.taskSource?.cancel();
        this.post({
          type: 'notice',
          level: 'warn',
          message: `The agent task exceeded the ${timeoutMs.toLocaleString()} ms limit and was stopped.`,
        });
      }, timeoutMs);
    }

    this.post({ type: 'task', task });

    if (task.status === 'awaiting-approval' && previous !== 'awaiting-approval') {
      const files =
        task.review.length > 0
          ? task.review.map((change) => `- ${change.kind}: ${change.path}`).join('\n')
          : '(no file changes)';
      void this.recordAssistant(
        [
          `Change plan ready for review: ${task.planSummary ?? 'proposed changes'}`,
          files,
          'No files have been modified. Review the diff cards and approve the files you want to apply.',
        ].join('\n\n'),
      );
    }

    if (task.status === 'applied' && previous !== 'applied') {
      void this.recordAssistant(
        'Applied the approved changes. Validation has not run yet; use an allowlisted validation command to verify.',
        false,
      );
    }

    if (task.status === 'failed' && previous !== 'failed') {
      void this.recordAssistant(
        `The agent task failed: ${task.error ?? 'unknown error'}${task.hint !== undefined ? `\n${task.hint}` : ''}`,
        false,
      );
    }

    if (task.status !== 'running' && this.taskTimer !== undefined) {
      clearTimeout(this.taskTimer);
      this.taskTimer = undefined;
    }
    this.post({ type: 'busy', busy: task.status === 'running' });
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
        this.cancelActive();
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
      case 'startTask':
        await this.startTask(message.prompt);
        break;
      case 'approveChanges':
        await this.runTaskPhase(message.taskId, (token) =>
          this.taskRunner.approve(message.taskId, message.ids, token),
        );
        break;
      case 'rejectChanges':
        await this.runTaskPhase(message.taskId, (token) =>
          this.taskRunner.approve(message.taskId, [], token),
        );
        break;
      case 'cancelTask':
        if (message.taskId === this.activeTaskId) {
          this.cancelTask();
        } else {
          this.taskRunner.cancel(message.taskId);
        }
        break;
      case 'runValidation':
        await this.validateTask(message.taskId, message.command);
        break;
      case 'requestRepair':
        await this.runTaskPhase(message.taskId, (token) =>
          this.taskRunner.repair(message.taskId, token),
        );
        break;
      case 'undoChanges': {
        try {
          const result = await this.taskRunner.undo(message.taskId);
          if (result === undefined) {
            this.post({
              type: 'notice',
              level: 'warn',
              message: 'There is no applied change set to undo.',
            });
          } else {
            const { outcome } = result;
            this.post({
              type: 'undoResult',
              taskId: message.taskId,
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
                  ? 'The applied changes were restored from backups.'
                  : 'Some files could not be restored because they changed after apply.',
            });
          }
        } catch (error) {
          this.deps.logger.error('undo failed', error);
          this.post({ type: 'notice', level: 'error', message: 'Undo failed. See the QuantsMind log.' });
        }
        break;
      }
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
      });
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

  private postTaskError(error: unknown): void {
    const providerError = isProviderError(error) ? error : normalizeThrownError(error);
    if (providerError.code === 'cancelled') {
      return;
    }
    this.post({
      type: 'error',
      message: providerError.message,
      hint: errorHint(providerError.code),
      code: providerError.code,
    });
  }

  private async startTask(rawPrompt: string): Promise<void> {
    if (this.busy) {
      this.post({ type: 'notice', level: 'warn', message: 'A request is already running.' });
      return;
    }
    const prompt = rawPrompt.trim();
    if (prompt.length === 0) {
      this.post({
        type: 'notice',
        level: 'warn',
        message: 'Describe the change you want before starting an agent task.',
      });
      return;
    }
    if (prompt.length > LIMITS.maxPromptChars) {
      this.post({
        type: 'notice',
        level: 'warn',
        message: `The prompt exceeds the ${LIMITS.maxPromptChars.toLocaleString()} character limit.`,
      });
      return;
    }
    if (this.workspaceRoot() === undefined) {
      this.post({
        type: 'error',
        message: 'Open a workspace folder before using agent mode.',
        hint: 'Agent mode needs a workspace to index and to apply approved changes.',
        code: 'configuration',
      });
      return;
    }
    const activeStatus =
      this.activeTaskId !== undefined ? this.lastTaskStatus.get(this.activeTaskId) : undefined;
    if (
      activeStatus === 'running' ||
      activeStatus === 'awaiting-approval' ||
      activeStatus === 'validation-failed'
    ) {
      this.post({
        type: 'notice',
        level: 'warn',
        message: 'Finish the current change review or validation before starting another task.',
      });
      return;
    }

    const status = await this.providerReadiness();
    if (status === undefined) {
      return;
    }

    this.cancelTask();
    this.activeTaskId = undefined;
    this.attachments = [];
    this.post({ type: 'attachments', attachments: [] });
    await this.ensureConversation();
    await this.recordUser(prompt, []);
    this.session.addUser(prompt);
    this.post({ type: 'userMessage', text: prompt, attachments: [] });
    this.busy = true;
    this.post({ type: 'busy', busy: true });

    const source = new vscode.CancellationTokenSource();
    this.taskSource = source;
    try {
      const task = await this.taskRunner.start(prompt, source.token);
      if (task.status === 'failed') {
        this.post({
          type: 'error',
          message: task.error ?? 'The agent task failed.',
          hint: task.hint,
          code: 'agent',
        });
      }
    } catch (error) {
      this.postTaskError(error);
    } finally {
      this.busy = false;
      this.post({ type: 'busy', busy: false });
      if (this.taskSource === source) {
        this.taskSource = undefined;
      }
      source.dispose();
      if (this.taskTimer !== undefined) {
        clearTimeout(this.taskTimer);
        this.taskTimer = undefined;
      }
    }
  }

  private async runTaskPhase(
    taskId: string,
    action: (token: vscode.CancellationToken) => Promise<AgentTaskView>,
  ): Promise<void> {
    if (taskId !== this.activeTaskId) {
      this.post({
        type: 'notice',
        level: 'warn',
        message: 'That task is no longer active in this conversation.',
      });
      return;
    }
    if (this.taskSource !== undefined) {
      this.post({
        type: 'notice',
        level: 'warn',
        message: 'The previous task step is still running.',
      });
      return;
    }

    const source = new vscode.CancellationTokenSource();
    this.taskSource = source;
    const timeoutMs = this.deps.settings.getAgentSettings().timeoutMs;
    this.taskTimer = setTimeout(() => {
      this.taskRunner.cancel(taskId);
      source.cancel();
      this.post({
        type: 'notice',
        level: 'warn',
        message: `The agent task exceeded the ${timeoutMs.toLocaleString()} ms limit and was stopped.`,
      });
    }, timeoutMs);

    try {
      const task = await action(source.token);
      if (task.status === 'failed') {
        this.post({
          type: 'error',
          message: task.error ?? 'The agent task failed.',
          hint: task.hint,
          code: 'agent',
        });
      }
    } catch (error) {
      this.postTaskError(error);
    } finally {
      if (this.taskTimer !== undefined) {
        clearTimeout(this.taskTimer);
        this.taskTimer = undefined;
      }
      if (this.taskSource === source) {
        this.taskSource = undefined;
      }
      source.dispose();
    }
  }

  private async validateTask(taskId: string, command: string): Promise<void> {
    if (taskId !== this.activeTaskId) {
      this.post({
        type: 'notice',
        level: 'warn',
        message: 'That task is no longer active in this conversation.',
      });
      return;
    }
    const controller = new AbortController();
    const timeoutMs = this.deps.settings.getCommandSettings().timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs + 5_000);
    try {
      const task = await this.taskRunner.validate(taskId, command, controller.signal);
      if (task.validation !== undefined) {
        this.post({
          type: 'commandOutput',
          command: task.validation.command,
          cwd: this.workspaceRoot()?.uri.fsPath ?? '.',
          output: task.validation.output,
          exitCode: task.validation.exitCode,
          timedOut: task.validation.timedOut,
          cancelled: task.validation.cancelled,
        });
      }
    } catch (error) {
      this.post({
        type: 'notice',
        level: 'error',
        message: error instanceof Error ? error.message : 'Validation could not run.',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async handleSend(rawPrompt: string, mode: ChatMode): Promise<void> {
    if (isAgentMode(mode)) {
      await this.startTask(rawPrompt);
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

    const secret = await this.currentSecret();
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
