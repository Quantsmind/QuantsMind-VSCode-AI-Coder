export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export interface CompletionRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly stream: boolean;
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
