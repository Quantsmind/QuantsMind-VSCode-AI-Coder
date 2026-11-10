import { expect } from 'chai';
import {
  MAX_COMPLETION_RETRIES,
  MAX_RETRY_DELAY_MS,
  sleepRequiringSignal,
  withProviderRetry,
} from '../../src/providers/retry';
import { ProviderError, isProviderError } from '../../src/providers/errors';

/**
 * Permanent regression coverage for the bounded provider retry loop (D5).
 *
 * The loop may retry exactly one justifiable failure (rate limit, or a 502/503
 * upstream), honours `Retry-After` within a hard cap, and refuses every other
 * classification, a started stream, or a cancellation. Nothing here touches a
 * provider, the filesystem or VS Code.
 */

function retryableError(retryAfterMs?: number): ProviderError {
  return new ProviderError('rate_limit', 'The provider rate-limited the request (HTTP 429).', {
    status: 429,
    retryable: true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function nonRetryableError(
  code: 'quota' | 'authentication' | 'server',
  status?: number,
): ProviderError {
  return new ProviderError(code, `The provider request failed (${code}).`, {
    ...(status === undefined ? {} : { status }),
    retryable: false,
  });
}

async function expectProviderFailure(
  action: () => Promise<unknown>,
  code: string,
  message: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(isProviderError(error), 'the failure must be a ProviderError').to.equal(true);
    const providerError = error as ProviderError;
    expect(providerError.code).to.equal(code);
    expect(providerError.message).to.contain(message);
    return;
  }
  throw new Error(`Expected a ProviderError with code "${code}".`);
}

suite('provider retry loop (D5)', () => {
  suite('bounded retries', () => {
    test('retries a retryable rate limit exactly once and then succeeds', async () => {
      let attempts = 0;
      const controller = new AbortController();

      const result = await withProviderRetry(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw retryableError(0);
          }
          return 'completed';
        },
        {},
        controller.signal,
      );

      expect(result).to.equal('completed');
      expect(attempts).to.equal(2);
    });

    test('gives up after the single permitted retry', async () => {
      let attempts = 0;
      const controller = new AbortController();

      await expectProviderFailure(
        () =>
          withProviderRetry(
            async () => {
              attempts += 1;
              throw retryableError(0);
            },
            {},
            controller.signal,
          ),
        'rate_limit',
        'rate-limited',
      );
      expect(attempts).to.equal(2);
    });

    test('honours an explicit zero-retry budget', async () => {
      let attempts = 0;
      const controller = new AbortController();

      await expectProviderFailure(
        () =>
          withProviderRetry(
            async () => {
              attempts += 1;
              throw retryableError(0);
            },
            { maxRetries: 0 },
            controller.signal,
          ),
        'rate_limit',
        'rate-limited',
      );
      expect(attempts).to.equal(1);
    });

    test('caps an oversized retry budget at two extra attempts', async () => {
      let attempts = 0;
      const controller = new AbortController();

      await expectProviderFailure(
        () =>
          withProviderRetry(
            async () => {
              attempts += 1;
              throw retryableError(0);
            },
            { maxRetries: 50 },
            controller.signal,
          ),
        'rate_limit',
        'rate-limited',
      );
      expect(attempts).to.equal(3);
    });

    test('the completion retry budget stays at one', () => {
      expect(MAX_COMPLETION_RETRIES).to.equal(1);
    });

    test('passes the same abort signal into every attempt', async () => {
      const controller = new AbortController();
      const seen: AbortSignal[] = [];
      let attempts = 0;

      await withProviderRetry(
        async (signal) => {
          seen.push(signal);
          attempts += 1;
          if (attempts === 1) {
            throw retryableError(0);
          }
          return 'ok';
        },
        {},
        controller.signal,
      );

      expect(seen).to.have.length(2);
      expect(seen[0]).to.equal(controller.signal);
      expect(seen[1]).to.equal(controller.signal);
    });
  });

  suite('failures that must never be retried', () => {
    test('a quota exhaustion is surfaced on the first attempt', async () => {
      let attempts = 0;
      const controller = new AbortController();

      await expectProviderFailure(
        () =>
          withProviderRetry(
            async () => {
              attempts += 1;
              throw nonRetryableError('quota');
            },
            {},
            controller.signal,
          ),
        'quota',
        'failed',
      );
      expect(attempts).to.equal(1);
    });

    test('an authentication failure is surfaced on the first attempt', async () => {
      let attempts = 0;
      const controller = new AbortController();

      await expectProviderFailure(
        () =>
          withProviderRetry(
            async () => {
              attempts += 1;
              throw nonRetryableError('authentication');
            },
            {},
            controller.signal,
          ),
        'authentication',
        'failed',
      );
      expect(attempts).to.equal(1);
    });

    test('a plain HTTP 500 server error is surfaced on the first attempt', async () => {
      let attempts = 0;
      const controller = new AbortController();

      await expectProviderFailure(
        () =>
          withProviderRetry(
            async () => {
              attempts += 1;
              throw nonRetryableError('server', 500);
            },
            {},
            controller.signal,
          ),
        'server',
        'failed',
      );
      expect(attempts).to.equal(1);
    });

    test('an upstream 502 is retried once, unlike a plain 500', async () => {
      let attempts = 0;
      const controller = new AbortController();

      const result = await withProviderRetry(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new ProviderError('server', 'Upstream unavailable (HTTP 502).', {
              status: 502,
              retryable: true,
              retryAfterMs: 0,
            });
          }
          return 'recovered';
        },
        {},
        controller.signal,
      );

      expect(result).to.equal('recovered');
      expect(attempts).to.equal(2);
    });

    test('a non-provider error is thrown through untouched', async () => {
      let attempts = 0;
      const controller = new AbortController();

      try {
        await withProviderRetry(
          async () => {
            attempts += 1;
            throw new TypeError('bug in the client');
          },
          {},
          controller.signal,
        );
        throw new Error('Expected the operation to reject.');
      } catch (error) {
        expect(error).to.be.instanceOf(TypeError);
        expect((error as Error).message).to.equal('bug in the client');
      }
      expect(attempts).to.equal(1);
    });

    test('a stream that already started forbids the retry', async () => {
      let attempts = 0;
      const controller = new AbortController();

      await expectProviderFailure(
        () =>
          withProviderRetry(
            async () => {
              attempts += 1;
              throw retryableError(0);
            },
            { streamStarted: true },
            controller.signal,
          ),
        'rate_limit',
        'rate-limited',
      );
      expect(attempts).to.equal(1);
    });

    test('streamStarted is re-evaluated as a function on each failure', async () => {
      let attempts = 0;
      let streaming = false;
      const controller = new AbortController();

      await expectProviderFailure(
        () =>
          withProviderRetry(
            async () => {
              attempts += 1;
              streaming = true;
              throw retryableError(0);
            },
            { streamStarted: () => streaming },
            controller.signal,
          ),
        'rate_limit',
        'rate-limited',
      );
      expect(attempts).to.equal(1);
    });
  });

  suite('delays and cancellation', () => {
    test('waits the default 500 ms when the provider sends no Retry-After', async () => {
      const controller = new AbortController();
      let attempts = 0;
      const startedAt = Date.now();

      await withProviderRetry(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new ProviderError('rate_limit', 'The provider rate-limited the request.', {
              status: 429,
              retryable: true,
            });
          }
          return 'ok';
        },
        {},
        controller.signal,
      );

      const elapsed = Date.now() - startedAt;
      expect(attempts).to.equal(2);
      expect(elapsed).to.be.at.least(400);
      expect(elapsed).to.be.lessThan(5_000);
    });

    test('caps a huge Retry-After at MAX_RETRY_DELAY_MS', async () => {
      const controller = new AbortController();
      let attempts = 0;
      const startedAt = Date.now();

      await withProviderRetry(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw retryableError(60_000);
          }
          return 'ok';
        },
        {},
        controller.signal,
      );

      const elapsed = Date.now() - startedAt;
      expect(attempts).to.equal(2);
      expect(elapsed).to.be.at.least(1_900);
      expect(elapsed).to.be.lessThan(MAX_RETRY_DELAY_MS + 3_000);
      expect(elapsed).to.be.lessThan(10_000);
    });

    test('a cancellation during the delay aborts the retry', async () => {
      const controller = new AbortController();
      let attempts = 0;
      const startedAt = Date.now();

      await expectProviderFailure(
        () =>
          withProviderRetry(
            async () => {
              attempts += 1;
              setTimeout(() => controller.abort(), 20);
              throw retryableError(10_000);
            },
            {},
            controller.signal,
          ),
        'cancelled',
        'The request was cancelled.',
      );

      const elapsed = Date.now() - startedAt;
      expect(attempts).to.equal(1);
      expect(elapsed).to.be.lessThan(5_000);
    });

    test('an already-aborted signal cancels before the wait', async () => {
      const controller = new AbortController();
      controller.abort();

      await expectProviderFailure(
        () => sleepRequiringSignal(500, controller.signal),
        'cancelled',
        'The request was cancelled.',
      );
    });

    test('a zero or negative delay resolves without waiting', async () => {
      const controller = new AbortController();
      const startedAt = Date.now();
      await sleepRequiringSignal(0, controller.signal);
      await sleepRequiringSignal(-100, controller.signal);
      expect(Date.now() - startedAt).to.be.lessThan(200);
    });

    test('the delay completes normally when nothing aborts', async () => {
      const controller = new AbortController();
      const startedAt = Date.now();
      await sleepRequiringSignal(50, controller.signal);
      expect(Date.now() - startedAt).to.be.at.least(30);
      expect(controller.signal.aborted).to.equal(false);
    });

    test('MAX_RETRY_DELAY_MS stays at the documented two seconds', () => {
      expect(MAX_RETRY_DELAY_MS).to.equal(2_000);
    });
  });
});
