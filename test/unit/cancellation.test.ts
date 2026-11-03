import { expect } from 'chai';
import { withAbort } from '../../src/providers/cancellation';
import { ProviderError } from '../../src/providers/errors';
import { TestCancellationToken } from './helpers';

function expectProviderCode(error: unknown, code: string): void {
  expect(error).to.be.instanceOf(ProviderError);
  expect((error as ProviderError).code).to.equal(code);
}

suite('cancellation and timeout scope', () => {
  test('rejects immediately when the token is already cancelled', async () => {
    const token = new TestCancellationToken();
    token.cancel();
    let executed = false;

    let failure: unknown;
    try {
      await withAbort(
        async () => {
          executed = true;
          return 'done';
        },
        { token, timeoutMs: 1000 },
      );
    } catch (error) {
      failure = error;
    }

    expectProviderCode(failure, 'cancelled');
    expect(executed).to.equal(false);
  });

  test('runs the operation and clears its timer and listener on success', async () => {
    const token = new TestCancellationToken();
    const result = await withAbort(async () => 'ok', { token, timeoutMs: 1000 });
    expect(result).to.equal('ok');
    expect(token.listenerCount).to.equal(0);
  });

  test('aborts the operation when the token is cancelled mid-flight', async () => {
    const token = new TestCancellationToken();

    const pending = withAbort(
      async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('aborted');
      },
      { token, timeoutMs: 1000 },
    );
    setTimeout(() => token.cancel(), 5);

    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }

    expectProviderCode(failure, 'cancelled');
    expect(token.listenerCount).to.equal(0);
  });

  test('cancellation takes precedence over a simultaneous timeout', async () => {
    const token = new TestCancellationToken();

    let failure: unknown;
    try {
      await withAbort(
        async (signal) => {
          setTimeout(() => token.cancel(), 5);
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          throw new Error('aborted');
        },
        { token, timeoutMs: 25 },
      );
    } catch (error) {
      failure = error;
    }

    expectProviderCode(failure, 'cancelled');
  });

  test('reports a timeout when the operation exceeds the deadline', async () => {
    let failure: unknown;
    try {
      await withAbort(
        async (signal) => {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          throw new Error('aborted');
        },
        { timeoutMs: 20 },
      );
    } catch (error) {
      failure = error;
    }

    expectProviderCode(failure, 'timeout');
  });

  test('rejects non-positive timeouts as configuration errors', async () => {
    let failure: unknown;
    try {
      await withAbort(async () => 'never', { timeoutMs: 0 });
    } catch (error) {
      failure = error;
    }
    expectProviderCode(failure, 'configuration');
  });
});
