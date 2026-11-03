import { ProviderError } from './errors';
import type { CancellationTokenLike } from './types';

export interface AbortScopeOptions {
  readonly token?: CancellationTokenLike;
  readonly timeoutMs: number;
}

/**
 * Runs an abortable operation with cancellation-token and total-timeout
 * support. Cancellation always wins over a simultaneous timeout so the UI can
 * distinguish a user stop from an expired request.
 */
export async function withAbort<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: AbortScopeOptions,
): Promise<T> {
  const { token, timeoutMs } = options;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ProviderError('configuration', 'The provider request timeout must be a positive number.');
  }

  if (token?.isCancellationRequested) {
    throw new ProviderError('cancelled', 'The request was cancelled.');
  }

  const controller = new AbortController();
  let cancelled = false;
  let timedOut = false;

  const listener = token?.onCancellationRequested(() => {
    cancelled = true;
    controller.abort();
  });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    if (cancelled || token?.isCancellationRequested) {
      throw new ProviderError('cancelled', 'The request was cancelled.');
    }
    if (timedOut) {
      throw new ProviderError(
        'timeout',
        `The request timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    listener?.dispose();
  }
}
