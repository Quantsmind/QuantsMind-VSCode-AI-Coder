import {
  CONVERSATION_STORAGE_KEY,
  MAX_CONVERSATION_CHARS,
  MAX_CONVERSATIONS,
} from '../config/defaults';

const ACTIVE_KEY = 'quantsmind.chat.activeConversation.v1';
const MAX_MESSAGES = 200;

export interface ConversationMemento {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface StoredMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly attachments: readonly string[];
  readonly createdAt: string;
}

export interface Conversation {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
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
    if (!isRecord(item)) {
      continue;
    }
    if (item.role !== 'user' && item.role !== 'assistant') {
      continue;
    }
    if (typeof item.text !== 'string') {
      continue;
    }
    messages.push({
      role: item.role,
      text: item.text.slice(0, MAX_CONVERSATION_CHARS),
      attachments: Array.isArray(item.attachments)
        ? item.attachments
            .filter((entry): entry is string => typeof entry === 'string')
            .slice(0, 50)
        : [],
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
    });
  }

  return {
    id: value.id,
    title: value.title.slice(0, 120),
    createdAt: value.createdAt,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : value.createdAt,
    messages,
  };
}

export class ConversationStore {
  constructor(private readonly memento: ConversationMemento) {}

  list(): ConversationMeta[] {
    const raw = this.memento.get(CONVERSATION_STORAGE_KEY);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map(parseConversation)
      .filter((entry): entry is Conversation => entry !== undefined)
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        updatedAt: entry.updatedAt,
        messageCount: entry.messages.length,
      }))
      .slice(0, MAX_CONVERSATIONS);
  }

  get(id: string): Conversation | undefined {
    const raw = this.memento.get(CONVERSATION_STORAGE_KEY);
    if (!Array.isArray(raw)) {
      return undefined;
    }
    for (const item of raw) {
      const conversation = parseConversation(item);
      if (conversation?.id === id) {
        return conversation;
      }
    }
    return undefined;
  }

  create(): Conversation {
    const now = new Date().toISOString();
    return {
      id: `conversation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
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
    const saved: Conversation = {
      ...conversation,
      title,
      updatedAt: new Date().toISOString(),
      messages,
    };

    const existing: Conversation[] = [];
    const raw = this.memento.get(CONVERSATION_STORAGE_KEY);
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const parsed = parseConversation(item);
        if (parsed !== undefined && parsed.id !== saved.id) {
          existing.push(parsed);
        }
      }
    }

    existing.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const next = [saved, ...existing].slice(0, MAX_CONVERSATIONS);
    await this.memento.update(CONVERSATION_STORAGE_KEY, next);
    await this.setActive(saved.id);
    return saved;
  }

  async delete(id: string): Promise<void> {
    const raw = this.memento.get(CONVERSATION_STORAGE_KEY);
    if (!Array.isArray(raw)) {
      return;
    }
    const next = raw
      .map(parseConversation)
      .filter((entry): entry is Conversation => entry !== undefined && entry.id !== id);
    await this.memento.update(CONVERSATION_STORAGE_KEY, next);
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
  return limited.slice(start).map((message) => ({ ...message }));
}
