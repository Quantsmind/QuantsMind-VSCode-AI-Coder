import type { AgentTaskView } from '../agent/taskRunner';
import type { ProviderStatus } from '../providers/completionService';
import { isChatMode, type ChatMode } from './prompts';

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly messageCount: number;
}

export interface TranscriptMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly attachments: readonly string[];
}

export interface AttachmentSummary {
  readonly id: string;
  readonly path: string;
  readonly languageId?: string;
  readonly isSelection: boolean;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly chars: number;
  readonly redactions: number;
}

export type WebviewToHostMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'send'; readonly prompt: string; readonly mode: ChatMode }
  | { readonly type: 'stop' }
  | { readonly type: 'newChat' }
  | { readonly type: 'attachSelection' }
  | { readonly type: 'attachActiveFile' }
  | { readonly type: 'attachFiles' }
  | { readonly type: 'removeAttachment'; readonly id: string }
  | { readonly type: 'clearAttachments' }
  | { readonly type: 'explainSelection' }
  | { readonly type: 'setApiKey' }
  | { readonly type: 'clearApiKey' }
  | { readonly type: 'openSettings' }
  | { readonly type: 'showLog' }
  | { readonly type: 'refreshStatus' }
  | { readonly type: 'startTask'; readonly prompt: string }
  | { readonly type: 'approveChanges'; readonly taskId: string; readonly ids: readonly string[] }
  | { readonly type: 'rejectChanges'; readonly taskId: string }
  | { readonly type: 'undoChanges'; readonly taskId: string }
  | { readonly type: 'runValidation'; readonly taskId: string; readonly command: string }
  | { readonly type: 'requestRepair'; readonly taskId: string }
  | { readonly type: 'cancelTask'; readonly taskId: string }
  | { readonly type: 'newConversation' }
  | { readonly type: 'switchConversation'; readonly id: string }
  | { readonly type: 'deleteConversation'; readonly id: string }
  | { readonly type: 'summarizeWorkspace' }
  | { readonly type: 'attachRelevantFiles'; readonly query: string };

export type HostToWebviewMessage =
  | {
      readonly type: 'init';
      readonly status: ProviderStatus;
      readonly attachments: readonly AttachmentSummary[];
      readonly maxPromptChars: number;
      readonly version: string;
      readonly conversations: readonly ConversationSummary[];
      readonly activeConversationId: string;
      readonly transcript: readonly TranscriptMessage[];
      readonly validationCommands: readonly string[];
      readonly workspaceName?: string;
    }
  | { readonly type: 'status'; readonly status: ProviderStatus }
  | { readonly type: 'attachments'; readonly attachments: readonly AttachmentSummary[] }
  | {
      readonly type: 'draft';
      readonly prompt: string;
      readonly mode: ChatMode;
      readonly attachments: readonly AttachmentSummary[];
    }
  | {
      readonly type: 'userMessage';
      readonly text: string;
      readonly attachments: readonly AttachmentSummary[];
    }
  | { readonly type: 'assistantStart'; readonly id: string; readonly model: string }
  | { readonly type: 'assistantDelta'; readonly id: string; readonly delta: string }
  | {
      readonly type: 'assistantEnd';
      readonly id: string;
      readonly finishReason?: string;
      readonly usage?: {
        readonly promptTokens?: number;
        readonly completionTokens?: number;
        readonly totalTokens?: number;
      };
    }
  | { readonly type: 'assistantCancelled'; readonly id: string }
  | {
      readonly type: 'error';
      readonly message: string;
      readonly hint?: string;
      readonly code?: string;
    }
  | { readonly type: 'busy'; readonly busy: boolean }
  | { readonly type: 'notice'; readonly level: 'info' | 'warn' | 'error'; readonly message: string }
  | { readonly type: 'clear' }
  | {
      readonly type: 'conversations';
      readonly conversations: readonly ConversationSummary[];
      readonly activeConversationId: string;
    }
  | {
      readonly type: 'conversation';
      readonly id: string;
      readonly title: string;
      readonly transcript: readonly TranscriptMessage[];
    }
  | { readonly type: 'task'; readonly task: AgentTaskView }
  | {
      readonly type: 'workspaceSummary';
      readonly text: string;
      readonly fileCount: number;
      readonly truncated: boolean;
    }
  | {
      readonly type: 'undoResult';
      readonly taskId: string;
      readonly restored: number;
      readonly conflicts: number;
      readonly messages: readonly string[];
    }
  | {
      readonly type: 'commandOutput';
      readonly command: string;
      readonly cwd: string;
      readonly output: string;
      readonly exitCode: number | null;
      readonly timedOut: boolean;
      readonly cancelled: boolean;
    };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

/**
 * Strictly parses messages received from the webview. Unknown or malformed
 * messages are ignored rather than trusted.
 */
export function parseWebviewMessage(raw: unknown): WebviewToHostMessage | undefined {
  const record = asRecord(raw);
  if (record === undefined) {
    return undefined;
  }

  switch (record.type) {
    case 'ready':
    case 'stop':
    case 'newChat':
    case 'attachSelection':
    case 'attachActiveFile':
    case 'attachFiles':
    case 'clearAttachments':
    case 'explainSelection':
    case 'setApiKey':
    case 'clearApiKey':
    case 'openSettings':
    case 'showLog':
    case 'refreshStatus':
    case 'newConversation':
    case 'summarizeWorkspace':
      return { type: record.type };
    case 'startTask':
      if (typeof record.prompt !== 'string') {
        return undefined;
      }
      return { type: 'startTask', prompt: record.prompt };
    case 'rejectChanges':
    case 'cancelTask':
      if (!isId(record.taskId)) {
        return undefined;
      }
      return { type: record.type, taskId: record.taskId };
    case 'undoChanges':
      if (!isId(record.taskId)) {
        return undefined;
      }
      return { type: 'undoChanges', taskId: record.taskId };
    case 'requestRepair':
      if (!isId(record.taskId)) {
        return undefined;
      }
      return { type: 'requestRepair', taskId: record.taskId };
    case 'runValidation':
      if (!isId(record.taskId) || typeof record.command !== 'string') {
        return undefined;
      }
      return { type: 'runValidation', taskId: record.taskId, command: record.command };
    case 'approveChanges': {
      if (!isId(record.taskId) || !Array.isArray(record.ids)) {
        return undefined;
      }
      const ids = record.ids.filter(isId).slice(0, 100);
      return { type: 'approveChanges', taskId: record.taskId, ids };
    }
    case 'switchConversation':
    case 'deleteConversation':
      if (!isId(record.id)) {
        return undefined;
      }
      return { type: record.type, id: record.id };
    case 'attachRelevantFiles':
      if (typeof record.query !== 'string') {
        return undefined;
      }
      return { type: 'attachRelevantFiles', query: record.query };
    case 'send': {
      if (typeof record.prompt !== 'string') {
        return undefined;
      }
      return {
        type: 'send',
        prompt: record.prompt,
        mode: isChatMode(record.mode) ? record.mode : 'ask',
      };
    }
    case 'removeAttachment': {
      if (typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 100) {
        return undefined;
      }
      return { type: 'removeAttachment', id: record.id };
    }
    default:
      return undefined;
  }
}
