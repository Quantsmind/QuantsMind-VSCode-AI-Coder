export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
  readonly toolCalls?: readonly CompletionToolCall[];
  readonly toolCallId?: string;
}

export interface CompletionToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface CompletionToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface CompletionRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly stream: boolean;
  readonly tools?: readonly CompletionToolDefinition[];
}

export interface CompletionUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

export interface CompletionResult {
  readonly text: string;
  readonly model?: string;
  readonly finishReason?: string;
  readonly usage?: CompletionUsage;
  readonly toolCalls?: readonly CompletionToolCall[];
}

export interface DisposableLike {
  dispose(): void;
}

/** Structural equivalent of vscode.CancellationToken. */
export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): DisposableLike;
}

export interface CompletionOptions {
  readonly token?: CancellationTokenLike;
  readonly timeoutMs?: number;
  readonly onDelta?: (delta: string) => void;
  readonly tools?: readonly CompletionToolDefinition[];
  readonly stream?: boolean;
}

/**
 * Provider-neutral contract. Future providers implement this interface without
 * changes to the chat layer.
 */
export interface AiProvider {
  readonly id: string;
  readonly displayName: string;
  complete(request: CompletionRequest, options?: CompletionOptions): Promise<CompletionResult>;
}

export type IProvider = AiProvider;
