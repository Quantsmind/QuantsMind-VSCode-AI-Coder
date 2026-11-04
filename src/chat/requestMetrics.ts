import type { ChatMessage } from '../providers/types';
import type { RequestBreakdown } from './protocol';

export interface RequestParts {
  readonly promptChars: number;
  readonly attachmentItems: number;
  readonly attachmentChars: number;
}

/**
 * Measures the parts of a provider request from the messages that are actually
 * about to be sent: system instructions, replayed history, the current prompt
 * and the attachment context inside it. Sizes only, never content.
 */
export function measureRequest(
  messages: readonly ChatMessage[],
  parts: RequestParts,
): RequestBreakdown {
  let systemChars = 0;
  let historyMessages = 0;
  let historyChars = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const isLast = index === messages.length - 1;
    if (message.role === 'system') {
      systemChars += message.content.length;
      continue;
    }
    if (isLast) {
      continue;
    }
    historyMessages += 1;
    historyChars += message.content.length;
  }

  const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);

  return {
    messages: messages.length,
    systemChars,
    historyMessages,
    historyChars,
    promptChars: parts.promptChars,
    attachmentItems: parts.attachmentItems,
    attachmentChars: parts.attachmentChars,
    totalChars,
  };
}

/** Compact single-line summary for the Output channel. Contains no content. */
export function formatRequestBreakdown(breakdown: RequestBreakdown): string {
  return (
    `messages=${breakdown.messages} systemChars=${breakdown.systemChars}` +
    ` historyMessages=${breakdown.historyMessages} historyChars=${breakdown.historyChars}` +
    ` promptChars=${breakdown.promptChars} attachmentItems=${breakdown.attachmentItems}` +
    ` attachmentChars=${breakdown.attachmentChars} totalChars=${breakdown.totalChars}`
  );
}
