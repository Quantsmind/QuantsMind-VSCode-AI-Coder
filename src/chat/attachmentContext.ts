import { createHash } from 'node:crypto';
import {
  ATTACHMENT_DROPPED_MARKER,
  ATTACHMENT_TRUNCATION_MARKER,
  MAX_ATTACHMENT_CONTEXT_CHARS_PER_CONVERSATION,
  MAX_ATTACHMENT_CONTEXT_CHARS_PER_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from '../config/defaults';
import type { RedactedContextItem } from '../context/filters';
import { buildUserContent } from './prompts';

/**
 * One attachment exactly as it was supplied to the provider: already path
 * filtered, size limited and secret redacted at capture time. `content` is
 * empty when the storage budget could not keep it, which is why `chars` and
 * `checksum` are recorded separately.
 */
export interface StoredAttachment {
  readonly path: string;
  readonly content: string;
  readonly chars: number;
  readonly checksum: string;
  readonly languageId?: string;
  readonly isSelection: boolean;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly redactions: number;
  readonly capturedAt: string;
}

/** The subset of a stored conversation message needed to rebuild provider history. */
export interface RestorableMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly question?: string;
  readonly attachmentContext?: readonly StoredAttachment[];
  readonly localOnly?: boolean;
}

export interface CaptureResult {
  readonly captured: StoredAttachment[];
  readonly dropped: readonly string[];
  readonly chars: number;
}

export interface RestoreResult {
  readonly items: RedactedContextItem[];
  readonly unavailable: readonly StoredAttachment[];
  readonly chars: number;
}

export type AttachmentDisplayStatus = 'captured' | 'unavailable' | 'legacy';

export interface AttachmentDisplay {
  readonly path: string;
  readonly chars: number;
  readonly status: AttachmentDisplayStatus;
  readonly isSelection: boolean;
  readonly startLine?: number;
  readonly redactions: number;
}

export function checksumOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function boundedContent(content: string, budget: number): string {
  if (budget <= 0) {
    return '';
  }
  if (content.length <= budget) {
    return content;
  }
  if (budget <= ATTACHMENT_TRUNCATION_MARKER.length + 200) {
    return '';
  }
  return (
    content.slice(0, budget - ATTACHMENT_TRUNCATION_MARKER.length) + ATTACHMENT_TRUNCATION_MARKER
  );
}

/**
 * Freezes the context that was actually sent so a restored conversation can
 * replay it later. Capture never re-filters or re-redacts: it stores what the
 * provider already saw.
 */
export function captureAttachments(
  items: readonly RedactedContextItem[],
  capturedAt: string,
  budgetPerMessage: number = MAX_ATTACHMENT_CONTEXT_CHARS_PER_MESSAGE,
): CaptureResult {
  const captured: StoredAttachment[] = [];
  const dropped: string[] = [];
  let used = 0;

  const eligible = items.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  for (const overflow of items.slice(eligible.length)) {
    dropped.push(overflow.path);
  }

  for (const item of eligible) {
    const content = boundedContent(item.content, budgetPerMessage - used);
    if (content.length === 0) {
      dropped.push(item.path);
      continue;
    }
    used += content.length;
    captured.push({
      path: item.path,
      content,
      chars: item.content.length,
      checksum: checksumOf(content),
      languageId: item.languageId,
      isSelection: item.isSelection === true,
      startLine: item.startLine,
      endLine: item.endLine,
      redactions: item.redactions,
      capturedAt,
    });
  }

  return { captured, dropped, chars: used };
}

function optionalPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
}

/** Strict, order-preserving parse. Malformed entries are dropped, not trusted. */
export function parseStoredAttachment(value: unknown): StoredAttachment | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const path = boundedString(record.path, 500);
  if (path === undefined) {
    return undefined;
  }
  const content = typeof record.content === 'string' ? record.content : '';
  const chars =
    typeof record.chars === 'number' && Number.isFinite(record.chars) && record.chars >= 0
      ? Math.trunc(record.chars)
      : content.length;
  const checksum =
    typeof record.checksum === 'string' && /^[0-9a-f]{8,64}$/.test(record.checksum)
      ? record.checksum
      : content.length > 0
        ? checksumOf(content)
        : '';

  return {
    path,
    content,
    chars,
    checksum,
    languageId: boundedString(record.languageId, 60),
    isSelection: record.isSelection === true,
    startLine: optionalPositiveInt(record.startLine),
    endLine: optionalPositiveInt(record.endLine),
    redactions:
      typeof record.redactions === 'number' &&
      Number.isFinite(record.redactions) &&
      record.redactions >= 0
        ? Math.trunc(record.redactions)
        : 0,
    capturedAt:
      typeof record.capturedAt === 'string' ? record.capturedAt.slice(0, 40) : new Date(0).toISOString(),
  };
}

export function parseAttachmentContext(value: unknown): StoredAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const parsed: StoredAttachment[] = [];
  for (const entry of value.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
    const attachment = parseStoredAttachment(entry);
    if (attachment !== undefined) {
      parsed.push(attachment);
    }
  }
  return parsed;
}

/**
 * Rebuilds the context items for a stored turn. Anything whose content could
 * not be preserved is reported separately so the UI can warn instead of
 * implying the model still has it.
 */
export function restoreAttachmentContext(
  stored: readonly StoredAttachment[],
): RestoreResult {
  const items: RedactedContextItem[] = [];
  const unavailable: StoredAttachment[] = [];
  let chars = 0;

  for (const attachment of stored) {
    if (attachment.content.length === 0) {
      unavailable.push(attachment);
      continue;
    }
    chars += attachment.content.length;
    items.push({
      path: attachment.path,
      content: attachment.content,
      languageId: attachment.languageId,
      isSelection: attachment.isSelection,
      startLine: attachment.startLine,
      endLine: attachment.endLine,
      sizeBytes: Buffer.byteLength(attachment.content, 'utf8'),
      redactions: attachment.redactions,
    });
  }

  return { items, unavailable, chars };
}

/**
 * Rebuilds the provider message for a stored turn. When the verbatim question
 * was captured, the message is re-rendered through the same `buildUserContent`
 * the live request used, so a restored conversation sends the same text the
 * model originally saw. Legacy records fall back to the display text. Local-only
 * messages never reach the provider.
 */
export function providerContentFor(message: RestorableMessage): string | undefined {
  if (message.localOnly === true) {
    return undefined;
  }
  if (message.role === 'assistant') {
    return message.text;
  }
  if (message.question !== undefined || (message.attachmentContext?.length ?? 0) > 0) {
    const { items } = restoreAttachmentContext(message.attachmentContext ?? []);
    return buildUserContent(message.question ?? message.text, items);
  }
  return message.text;
}

export function providerHistoryMessages(
  messages: readonly RestorableMessage[],
): { role: 'user' | 'assistant'; content: string }[] {
  const rebuilt: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const message of messages) {
    const content = providerContentFor(message);
    if (content === undefined || content.length === 0) {
      continue;
    }
    rebuilt.push({ role: message.role, content });
  }
  return rebuilt;
}

/**
 * Enforces the conversation-wide capture budget by releasing captured content,
 * oldest first. Metadata and ordering survive so the transcript stays honest
 * about what was attached; only the content is given up.
 */
export function enforceAttachmentBudget<
  T extends { attachmentContext?: readonly StoredAttachment[] },
>(
  messages: readonly T[],
  budget: number = MAX_ATTACHMENT_CONTEXT_CHARS_PER_CONVERSATION,
): { messages: T[]; releasedChars: number; releasedAttachments: number } {
  let total = 0;
  for (const message of messages) {
    for (const attachment of message.attachmentContext ?? []) {
      total += attachment.content.length;
    }
  }

  if (total <= budget) {
    return {
      messages: messages.map((message) => ({ ...message })),
      releasedChars: 0,
      releasedAttachments: 0,
    };
  }

  let released = 0;
  let releasedAttachments = 0;
  const result: T[] = [];

  for (const message of messages) {
    const stored = message.attachmentContext;
    if (stored === undefined || stored.length === 0 || total <= budget) {
      result.push({ ...message });
      continue;
    }
    const nextContext = stored.map((attachment) => {
      if (attachment.content.length === 0 || total <= budget) {
        return attachment;
      }
      total -= attachment.content.length;
      released += attachment.content.length;
      releasedAttachments += 1;
      return { ...attachment, content: '' };
    });
    result.push({ ...message, attachmentContext: nextContext });
  }

  return { messages: result, releasedChars: released, releasedAttachments };
}

export function displaysForStoredAttachments(
  stored: readonly StoredAttachment[],
  legacyLabels: readonly string[] = [],
): AttachmentDisplay[] {
  const displays: AttachmentDisplay[] = stored.map((attachment) => ({
    path: attachment.path,
    chars: attachment.content.length > 0 ? attachment.content.length : 0,
    status: attachment.content.length > 0 ? 'captured' : 'unavailable',
    isSelection: attachment.isSelection,
    startLine: attachment.startLine,
    redactions: attachment.redactions,
  }));

  const seen = new Set(displays.map((display) => display.path));
  for (const label of legacyLabels) {
    const path = typeof label === 'string' ? label.trim() : '';
    if (path.length === 0 || seen.has(path)) {
      continue;
    }
    seen.add(path);
    displays.push({
      path,
      chars: 0,
      status: 'legacy',
      isSelection: false,
      redactions: 0,
    });
  }

  return displays;
}

export function attachmentRestoreWarnings(displays: readonly AttachmentDisplay[]): string[] {
  const warnings: string[] = [];
  const unavailable = displays.filter((display) => display.status === 'unavailable');
  const legacy = displays.filter((display) => display.status === 'legacy');

  if (unavailable.length > 0) {
    warnings.push(
      `${unavailable.length} attached file context(s) from this conversation could not be restored and will not be sent: ${unavailable
        .map((display) => display.path)
        .slice(0, 5)
        .join(', ')}${unavailable.length > 5 ? ', …' : ''}.`,
    );
  }
  if (legacy.length > 0) {
    warnings.push(
      `${legacy.length} older attachment record(s) stored only a path, so their captured contents are unavailable: ${legacy
        .map((display) => display.path)
        .slice(0, 5)
        .join(', ')}${legacy.length > 5 ? ', …' : ''}.`,
    );
  }
  return warnings;
}

export type CaptureFreshness = 'unknown' | 'unchanged' | 'modified' | 'missing';

/**
 * Compares the file on disk with the context captured at the time of the
 * request. A changed file never silently replaces the original context; the
 * caller reports the difference instead.
 */
export function freshnessOf(captured: StoredAttachment, currentContent?: string): CaptureFreshness {
  if (captured.content.length === 0) {
    return 'unknown';
  }
  if (currentContent === undefined) {
    return 'missing';
  }
  return checksumOf(currentContent) === captured.checksum ? 'unchanged' : 'modified';
}

export function droppedContentNotice(paths: readonly string[]): string {
  return `${paths.length} attachment(s) exceeded the stored-context budget: ${paths
    .slice(0, 5)
    .join(', ')}${paths.length > 5 ? ', …' : ''}. ${ATTACHMENT_DROPPED_MARKER}`;
}
