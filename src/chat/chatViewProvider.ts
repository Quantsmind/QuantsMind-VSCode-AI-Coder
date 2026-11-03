import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
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
  type ChatMode,
} from './prompts';
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

  constructor(private readonly deps: ChatViewDependencies) {}

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

  startNewChat(): void {
    this.requestSeq += 1;
    this.cancelActive();
    this.busy = false;
    this.session.clear();
    this.attachments = [];
    this.pendingDraft = undefined;
    this.post({ type: 'busy', busy: false });
    this.post({ type: 'attachments', attachments: [] });
    this.post({ type: 'clear' });
    void this.refreshStatus();
  }

  dispose(): void {
    this.requestSeq += 1;
    this.cancelActive();
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
      default:
        break;
    }
  }

  private async sendInit(): Promise<void> {
    try {
      const status = await this.deps.completion.getStatus();
      this.post({
        type: 'init',
        status,
        attachments: this.attachments.map((attachment) => this.toSummary(attachment)),
        maxPromptChars: LIMITS.maxPromptChars,
        version: this.deps.version,
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

  private async handleSend(rawPrompt: string, mode: ChatMode): Promise<void> {
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
      return;
    }

    if (status.configurationError !== undefined) {
      this.post({
        type: 'error',
        message: status.configurationError,
        hint: errorHint('configuration'),
        code: 'configuration',
      });
      return;
    }

    if (!status.ready) {
      this.post({
        type: 'error',
        message: 'No API key is configured for this provider.',
        hint: errorHint('authentication'),
        code: 'authentication',
      });
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

    const requestId = ++this.requestSeq;
    const assistantId = `assistant-${requestId}`;
    this.attachments = [];
    this.postAttachments();
    this.busy = true;
    this.post({ type: 'busy', busy: true });
    this.post({
      type: 'userMessage',
      text: prompt.length > 0 ? prompt : DEFAULT_QUESTIONS[mode],
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

      this.session.addAssistant(result.text);
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
