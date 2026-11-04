import {
  CONVERSATION_SCHEMA_VERSION,
  CONVERSATION_STORAGE_KEY,
  MAX_CONVERSATION_CHARS,
  MAX_CONVERSATIONS,
} from '../config/defaults';
import {
  enforceAttachmentBudget,
  parseAttachmentContext,
  type RestorableMessage,
  type StoredAttachment,
} from './attachmentContext';

const ACTIVE_KEY = 'quantsmind.chat.activeConversation.v1';
const UNREADABLE_KEY = `${CONVERSATION_STORAGE_KEY}.unreadable.v1`;
const MAX_MESSAGES = 200;

export interface ConversationMemento {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface StoredMessage extends RestorableMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  /**
   * Legacy v1 field: path labels only. Kept on write so an older build can
   * still read a v2 transcript.
   */
  readonly attachments: readonly string[];
  /** The exact question text sent to the provider, when it differs from `text`. */
  readonly question?: string;
  /** Captured attachment context, in attachment order. */
  readonly attachmentContext?: readonly StoredAttachment[];
  /** Assistant text produced locally (e.g. a workspace summary); never sent. */
  readonly localOnly?: boolean;
  readonly createdAt: string;
}

export interface Conversation {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Absent on records written before v0.3.4; v2 writes always stamp it. */
  readonly schema?: number;
  readonly messages: readonly StoredMessage[];
}

export interface ConversationMeta {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly messageCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMessage(value: unknown): StoredMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const item = value;
  if (item.role !== 'user' && item.role !== 'assistant') {
    return undefined;
  }
  if (typeof item.text !== 'string') {
    return undefined;
  }

  const attachments = Array.isArray(item.attachments)
    ? item.attachments
        .filter((entry): entry is string => typeof entry === 'string')
        .slice(0, 50)
    : [];
  const attachmentContext = parseAttachmentContext(item.attachmentContext);
  const question =
    typeof item.question === 'string' && item.question.length > 0
      ? item.question.slice(0, MAX_CONVERSATION_CHARS)
      : undefined;

  const parsed: StoredMessage = {
    role: item.role,
    text: item.text.slice(0, MAX_CONVERSATION_CHARS),
    attachments,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
    ...(attachmentContext.length > 0 ? { attachmentContext } : {}),
    ...(question === undefined ? {} : { question }),
    ...(item.localOnly === true ? { localOnly: true } : {}),
  };

  return parsed;
}

function parseConversation(value: unknown): Conversation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.createdAt !== 'string' ||
    !Array.isArray(value.messages)
  ) {
    return undefined;
  }

  const messages: StoredMessage[] = [];
  for (const item of value.messages) {
    const message = parseMessage(item);
    if (message !== undefined) {
      messages.push(message);
    }
  }

  const schema =
    typeof value.schema === 'number' && Number.isFinite(value.schema)
      ? Math.trunc(value.schema)
      : 1;

  return {
    id: value.id,
    title: value.title.slice(0, 120),
    createdAt: value.createdAt,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : value.createdAt,
    schema,
    messages,
  };
}

function toRecord(value: Conversation): Record<string, unknown> {
  return {
    id: value.id,
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    schema: CONVERSATION_SCHEMA_VERSION,
    messages: value.messages,
  };
}


export class ConversationStore {
  constructor(private readonly memento: ConversationMemento) {}

  private read(): { conversations: Conversation[]; unreadable: unknown[] } {
    const raw = this.memento.get(CONVERSATION_STORAGE_KEY);
    if (!Array.isArray(raw)) {
      return { conversations: [], unreadable: [] };
    }
    const conversations: Conversation[] = [];
    const unreadable: unknown[] = [];
    for (const item of raw) {
      const parsed = parseConversation(item);
      if (parsed === undefined) {
        unreadable.push(item);
        continue;
      }
      conversations.push(parsed);
    }
    conversations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return { conversations: conversations.slice(0, MAX_CONVERSATIONS), unreadable };
  }

  /**
   * Records that could not be parsed are copied aside before the list is
   * rewritten, so an interrupted or partially written save never destroys data.
   */
  private async salvage(unreadable: readonly unknown[]): Promise<void> {
    if (unreadable.length === 0) {
      return;
    }
    const existing = this.memento.get(UNREADABLE_KEY);
    const already = Array.isArray(existing) ? existing : [];
    if (already.length >= unreadable.length) {
      return;
    }
    await this.memento.update(UNREADABLE_KEY, unreadable.slice(0, MAX_CONVERSATIONS));
  }

  list(): ConversationMeta[] {
    return this.read().conversations.map((entry) => ({
      id: entry.id,
      title: entry.title,
      updatedAt: entry.updatedAt,
      messageCount: entry.messages.length,
    }));
  }

  get(id: string): Conversation | undefined {
    return this.read().conversations.find((entry) => entry.id === id);
  }

  /**
   * The most recently updated conversation other than `exceptId` that still has
   * messages. Empty records — New Chat placeholders and cleared conversations —
   * are skipped so a restore can never land on a blank transcript.
   */
  mostRecent(exceptId?: string): Conversation | undefined {
    return this.read().conversations.find(
      (entry) => entry.id !== exceptId && entry.messages.length > 0,
    );
  }

  create(): Conversation {
    const now = new Date().toISOString();
    return {
      id: `conversation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      schema: CONVERSATION_SCHEMA_VERSION,
      messages: [],
    };
  }

  async save(conversation: Conversation): Promise<Conversation> {
    const messages = trimMessages(conversation.messages);
    const firstUser = messages.find((message) => message.role === 'user');
    const title =
      firstUser !== undefined
        ? firstUser.text.replace(/\s+/g, ' ').trim().slice(0, 80) || 'New chat'
        : conversation.title;

    const { conversations, unreadable } = this.read();
    await this.salvage(unreadable);

    // An empty conversation must not jump the queue: keeping its previous stamp
    // stops a New Chat placeholder or a cleared conversation from becoming the
    // newest record every time it is re-saved.
    const previous = conversations.find((entry) => entry.id === conversation.id);
    const updatedAt =
      messages.length === 0 && previous !== undefined
        ? previous.updatedAt
        : new Date().toISOString();

    const saved: Conversation = {
      ...conversation,
      title,
      schema: CONVERSATION_SCHEMA_VERSION,
      updatedAt,
      messages,
    };

    const next = [saved, ...conversations.filter((entry) => entry.id !== saved.id)].slice(
      0,
      MAX_CONVERSATIONS,
    );
    await this.memento.update(CONVERSATION_STORAGE_KEY, next.map(toRecord));
    await this.setActive(saved.id);
    return saved;
  }

  /** Empties one conversation. Other conversations are never touched. */
  async clear(id: string): Promise<Conversation | undefined> {
    const target = this.get(id);
    if (target === undefined) {
      return undefined;
    }
    return this.save({
      ...target,
      title: 'New chat',
      messages: [],
    });
  }

  async delete(id: string): Promise<void> {
    const { conversations, unreadable } = this.read();
    await this.salvage(unreadable);
    const next = conversations.filter((entry) => entry.id !== id);
    await this.memento.update(CONVERSATION_STORAGE_KEY, next.map(toRecord));
    if (this.activeId() === id) {
      await this.setActive(next[0]?.id);
    }
  }

  activeId(): string | undefined {
    const value = this.memento.get(ACTIVE_KEY);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  async setActive(id: string | undefined): Promise<void> {
    await this.memento.update(ACTIVE_KEY, id ?? '');
  }
}

function trimMessages(messages: readonly StoredMessage[]): StoredMessage[] {
  const limited = messages.slice(-MAX_MESSAGES);
  let total = limited.reduce((sum, message) => sum + message.text.length, 0);
  let start = 0;
  while (total > MAX_CONVERSATION_CHARS && start < limited.length - 1) {
    total -= limited[start].text.length;
    start += 1;
  }
  return enforceAttachmentBudget(limited.slice(start)).messages.map((message) => ({ ...message }));
}
