import { DEFAULT_HISTORY_CHARS } from '../config/defaults';
import type { ChatMessage } from '../providers/types';

/**
 * Bounded provider history for one conversation. Durable transcripts live in
 * ConversationStore; this class only controls what is sent to the provider.
 */
export class ChatSession {
  private messages: ChatMessage[] = [];
  /** Messages and characters released since the last load or reset, for transparency. */
  private released = { messages: 0, chars: 0 };

  constructor(private readonly maxChars: number = DEFAULT_HISTORY_CHARS) {}

  snapshot(): readonly ChatMessage[] {
    return this.messages.map((message) => ({ role: message.role, content: message.content }));
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
    return this.messages.reduce((total, message) => total + message.content.length, 0);
  }

  addUser(content: string): void {
    if (content.length > 0) {
      this.push({ role: 'user', content });
    }
  }

  addAssistant(content: string): void {
    if (content.trim().length > 0) {
      this.push({ role: 'assistant', content });
    }
  }

  clear(): void {
    this.messages = [];
    this.released = { messages: 0, chars: 0 };
  }

  load(messages: readonly ChatMessage[]): void {
    this.messages = [];
    this.released = { messages: 0, chars: 0 };
    for (const message of messages) {
      if (message.content.length === 0) {
        continue;
      }
      this.messages.push({ role: message.role, content: message.content });
    }
    this.trim();
  }

  private push(message: ChatMessage): void {
    this.messages.push(message);
    this.trim();
  }

  private trim(): void {
    let total = this.charCount;
    while (total > this.maxChars && this.messages.length > 1) {
      const removed = this.messages.shift();
      if (removed === undefined) {
        break;
      }
      total -= removed.content.length;
      this.released = {
        messages: this.released.messages + 1,
        chars: this.released.chars + removed.content.length,
      };
    }
  }
}
