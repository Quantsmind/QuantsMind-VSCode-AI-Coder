import type { ProviderStatus } from '../providers/completionService';
import { isChatMode, type ChatMode } from './prompts';

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
  | { readonly type: 'refreshStatus' };

export type HostToWebviewMessage =
  | {
      readonly type: 'init';
      readonly status: ProviderStatus;
      readonly attachments: readonly AttachmentSummary[];
      readonly maxPromptChars: number;
      readonly version: string;
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
  | { readonly type: 'clear' };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
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
      return { type: record.type };
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
