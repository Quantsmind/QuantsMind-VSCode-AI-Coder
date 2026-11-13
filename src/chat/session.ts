import { DEFAULT_HISTORY_CHARS } from '../config/defaults';
import type { ChatMessage } from '../providers/types';

/** The chat mode a provider-recorded message belongs to; used to isolate Ask and Agent replay. */
export type SessionMode = 'ask' | 'agent';

interface SessionEntry {
  readonly message: ChatMessage;
  readonly mode: SessionMode;
}

/**
 * Bounded provider history for one conversation, tagged by chat mode. Durable
 * transcripts live in ConversationStore; this class only controls what is
 * sent to the provider. Mode-scoped snapshots keep Ask and Agent provider
 * replay strictly isolated.
 */
export class ChatSession {
  private entries: SessionEntry[] = [];
  /** Messages and characters released since the last load or reset, for transparency. */
  private released = { messages: 0, chars: 0 };

  constructor(private readonly maxChars: number = DEFAULT_HISTORY_CHARS) {}

  snapshot(): readonly ChatMessage[] {
    return this.entries.map((entry) => ({ ...entry.message }));
  }

  snapshotFor(mode: SessionMode): readonly ChatMessage[] {
    return this.entries
      .filter((entry) => entry.mode === mode)
      .map((entry) => ({ ...entry.message }));
  }

  /** How many replayed messages were released to fit the budget. */
  get releasedMessages(): number {
    return this.released.messages;
  }

  /** How many characters of replayed history were released to fit the budget. */
  get releasedChars(): number {
    return this.released.chars;
  }

  resetReleased(): void {
    this.released = { messages: 0, chars: 0 };
  }

  get charCount(): number {
    return this.entries.reduce((total, entry) => total + entry.message.content.length, 0);
  }

  addUser(content: string, mode: SessionMode = 'ask'): void {
    if (content.length > 0) {
      this.push({ role: 'user', content }, mode);
    }
  }

  addAssistant(content: string, mode: SessionMode = 'ask'): void {
    if (content.trim().length > 0) {
      this.push({ role: 'assistant', content }, mode);
    }
  }

  clear(): void {
    this.entries = [];
    this.released = { messages: 0, chars: 0 };
  }

  /** Messages loaded from persistence carry an optional mode; missing means legacy ask. */
  load(messages: readonly (ChatMessage & { readonly mode?: SessionMode })[]): void {
    this.entries = [];
    this.released = { messages: 0, chars: 0 };
    for (const message of messages) {
      if (message.content.length === 0) {
        continue;
      }
      this.entries.push({
        message: { role: message.role, content: message.content },
        mode: message.mode ?? 'ask',
      });
    }
    this.trim();
  }

  clearTransient(mode: SessionMode): void {
    this.entries = this.entries.filter((entry) => entry.mode !== mode);
  }

  private push(message: ChatMessage, mode: SessionMode): void {
    this.entries.push({ message, mode });
    this.trim();
  }

  private trim(): void {
    let total = this.charCount;
    while (total > this.maxChars && this.entries.length > 1) {
      const removed = this.entries.shift();
      if (removed === undefined) {
        break;
      }
      total -= removed.message.content.length;
      this.released = {
        messages: this.released.messages + 1,
        chars: this.released.chars + removed.message.content.length,
      };
    }
  }
}
