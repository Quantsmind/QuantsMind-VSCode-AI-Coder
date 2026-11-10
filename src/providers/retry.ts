import { ProviderError, isProviderError, shouldRetryProviderError } from './errors';
import type { CancellationTokenLike } from './types';

export const MAX_COMPLETION_RETRIES = 1;
export const MAX_RETRY_DELAY_MS = 2_000;

/**
 * Interruptible delay that honours an AbortSignal. Rejects with a cancelled
 * ProviderError if the signal aborts during the wait.
 */
export async function sleepRequiringSignal(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw new ProviderError('cancelled', 'The request was cancelled.');
  }
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ProviderError('cancelled', 'The request was cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RetryOptions {
  /** Extra attempts after the first one. Bounded to 1 for completions. */
  readonly maxRetries?: number;
  /** Whether any streaming delta was emitted; retries after streaming are forbidden. */
  readonly streamStarted?: boolean | (() => boolean);
  readonly token?: CancellationTokenLike;
}

/**
 * Bounded retry loop for justifiable cases only.
 *
 * - Never retries user cancellation, authentication, configuration,
 *   invalid_response, timeout or any non-retryable code.
 * - `streamStarted === true` forbids retry (would duplicate generation).
 * - At most `maxRetries` extra attempts (default 1) with `Retry-After` honoured
 *   (capped at 2s) as the delay.
 */
export async function withProviderRetry<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: RetryOptions,
  signal: AbortSignal,
): Promise<T> {
  const maxRetries = options.maxRetries ?? MAX_COMPLETION_RETRIES;
  const bounded = Math.max(0, Math.min(maxRetries, 2));
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await operation(signal);
    } catch (error) {
      if (!isProviderError(error)) {
        throw error;
      }
      const started =
        typeof options.streamStarted === 'function'
          ? options.streamStarted()
          : options.streamStarted === true;
      if (started) {
        throw error;
      }
      if (attempt > bounded) {
        throw error;
      }
      if (!shouldRetryProviderError(error)) {
        throw error;
      }
      const delayMs = Math.min(
        Math.max(error.retryAfterMs ?? 500, 0),
        MAX_RETRY_DELAY_MS,
      );
      await sleepRequiringSignal(delayMs, signal);
      // Loop continues as the single permitted retry.
    }
  }
}
