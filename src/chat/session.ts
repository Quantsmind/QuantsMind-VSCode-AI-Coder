import { DEFAULT_HISTORY_CHARS } from '../config/defaults';
import type { ChatMessage } from '../providers/types';

/**
 * Bounded provider history for one conversation. Durable transcripts live in
 * ConversationStore; this class only controls what is sent to the provider.
 */
export class ChatSession {
  private messages: ChatMessage[] = [];

  constructor(private readonly maxChars: number = DEFAULT_HISTORY_CHARS) {}

  snapshot(): readonly ChatMessage[] {
    return this.messages.map((message) => ({ role: message.role, content: message.content }));
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
  }

  load(messages: readonly ChatMessage[]): void {
    this.messages = [];
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
    }
  }
}
