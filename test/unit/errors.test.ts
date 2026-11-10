import { expect } from 'chai';
import {
  ProviderError,
  errorHint,
  isProviderError,
  normalizeHttpError,
  normalizeThrownError,
  shouldRetryProviderError,
} from '../../src/providers/errors';

suite('provider error normalization', () => {
  test('creates a normalized error with a stable code and metadata', () => {
    const error = new ProviderError('server', 'boom', { status: 503, retryable: true });
    expect(error.name).to.equal('ProviderError');
    expect(error.code).to.equal('server');
    expect(error.status).to.equal(503);
    expect(error.retryable).to.equal(true);
    expect(isProviderError(error)).to.equal(true);
    expect(isProviderError(new Error('plain'))).to.equal(false);
  });

  test('sanitizes control characters and truncates long messages', () => {
    const noisy = new ProviderError('http', `line\u0000one\u0007 two\nthree   ${'x'.repeat(900)}`);
    expect(noisy.message.includes('\u0000')).to.equal(false);
    expect(noisy.message.includes('\u0007')).to.equal(false);
    expect(noisy.message.includes('\n')).to.equal(false);
    expect(noisy.message.length).to.be.lessThan(510);
    expect(noisy.message.endsWith('…')).to.equal(true);
  });

  test('maps authentication failures', () => {
    const error = normalizeHttpError(401, '{"error":{"message":"invalid key"}}');
    expect(error.code).to.equal('authentication');
    expect(error.status).to.equal(401);
    expect(error.retryable).to.equal(false);
    expect(error.message).to.contain('invalid key');
  });

  test('maps rate limits and server failures as retryable', () => {
    const rateLimit = normalizeHttpError(429, '');
    expect(rateLimit.code).to.equal('rate_limit');
    expect(rateLimit.retryable).to.equal(true);

    const serverError = normalizeHttpError(503, '{"message":"overloaded"}');
    expect(serverError.code).to.equal('server');
    expect(serverError.status).to.equal(503);
    expect(serverError.retryable).to.equal(true);
    expect(serverError.message).to.contain('overloaded');
  });

  test('maps request timeouts and not-found responses', () => {
    expect(normalizeHttpError(408, '').code).to.equal('timeout');
    expect(normalizeHttpError(408, '').retryable).to.equal(false);
    expect(normalizeHttpError(404, '').code).to.equal('http');
    expect(normalizeHttpError(400, '').code).to.equal('http');
  });

  test('redacts credentials echoed in provider error bodies', () => {
    const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz012345';
    const error = normalizeHttpError(
      401,
      JSON.stringify({ error: { message: `Incorrect key ${secret}` } }),
      secret,
    );
    expect(error.message).to.not.contain(secret);
    expect(error.message).to.contain('[REDACTED]');
  });

  test('redacts provider-masked key fragments echoed in failure bodies', () => {
    const fragments = ['sk-proj-abcd***wxyz', 'sk-...1234', 'sk-live-****9876', 'abcd****wxyz'];
    for (const fragment of fragments) {
      const error = normalizeHttpError(
        401,
        JSON.stringify({ error: { message: `Incorrect API key provided: ${fragment}` } }),
      );
      expect(error.message, fragment).to.not.contain(fragment);
      expect(error.message, fragment).to.contain('[REDACTED]');
      expect(error.code, fragment).to.equal('authentication');
      expect(error.message, fragment).to.contain('Check the API key');
    }
  });

  test('scrubs credentials from every constructed provider error', () => {
    const error = new ProviderError('http', 'Request failed for sk-proj-abcd***wxyz');
    expect(error.message).to.not.contain('abcd');
    expect(error.message).to.contain('[REDACTED]');
  });

  test('does not surface HTML error pages or oversized plain bodies', () => {
    expect(normalizeHttpError(502, '<html><body>Bad gateway</body></html>').message).to.not.contain(
      '<html>',
    );
    const huge = 'a'.repeat(1000);
    expect(normalizeHttpError(400, huge).message).to.not.contain(huge);
  });

  test('normalizes abort and network exceptions', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(normalizeThrownError(abort).code).to.equal('cancelled');

    const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz012345';
    const network = normalizeThrownError(new Error(`connect ECONNREFUSED ${secret}`), secret);
    expect(network.code).to.equal('network');
    expect(network.message).to.not.contain(secret);
    expect(network.message).to.contain('Could not reach the AI provider');
  });

  test('passes normalized errors through unchanged', () => {
    const original = new ProviderError('timeout', 'slow');
    expect(normalizeThrownError(original)).to.equal(original);
  });

  test('returns actionable hints per error code', () => {
    expect(errorHint('authentication')).to.contain('Set API Key');
    expect(errorHint('rate_limit')).to.be.a('string');
    expect(errorHint('cancelled')).to.equal(undefined);
    expect(errorHint('quota')).to.contain('billing');
    expect(errorHint('timeout')).to.contain('not retried automatically');
    expect(errorHint('server')).to.contain('502 and 503');
  });
});

suite('quota exhaustion classification (D6)', () => {
  test('HTTP 402 is non-retryable quota exhaustion', () => {
    const error = normalizeHttpError(402, '');
    expect(error.code).to.equal('quota');
    expect(error.status).to.equal(402);
    expect(error.retryable).to.equal(false);
    expect(shouldRetryProviderError(error)).to.equal(false);
    expect(error.message).to.contain('exhausted quota or billing limits');
    expect(error.message).to.contain('Automatic retries are disabled');
  });

  test('403 insufficient_quota is quota, not authentication', () => {
    const body = JSON.stringify({
      error: { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' },
    });
    const error = normalizeHttpError(403, body);
    expect(error.code).to.equal('quota');
    expect(error.status).to.equal(403);
    expect(error.retryable).to.equal(false);
    expect(shouldRetryProviderError(error)).to.equal(false);
  });

  test('an ordinary 403 stays an authentication failure', () => {
    const error = normalizeHttpError(
      403,
      JSON.stringify({ error: { message: 'The API key does not have access to this model.' } }),
    );
    expect(error.code).to.equal('authentication');
    expect(error.retryable).to.equal(false);
    expect(error.message).to.contain('Check the API key');
  });

  test('401 stays authentication even when the body mentions billing', () => {
    const error = normalizeHttpError(
      401,
      JSON.stringify({ error: { message: 'Incorrect API key provided.', code: 'insufficient_quota' } }),
    );
    expect(error.code).to.equal('authentication');
    expect(error.status).to.equal(401);
    expect(error.retryable).to.equal(false);
  });

  test('429 insufficient_quota is quota rather than a retryable rate limit', () => {
    const error = normalizeHttpError(
      429,
      JSON.stringify({ error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota' } }),
    );
    expect(error.code).to.equal('quota');
    expect(error.retryable).to.equal(false);
    expect(shouldRetryProviderError(error)).to.equal(false);
  });

  test('an ordinary 429 remains a retryable rate limit', () => {
    const error = normalizeHttpError(429, JSON.stringify({ error: { message: 'Rate limit reached for requests.' } }));
    expect(error.code).to.equal('rate_limit');
    expect(error.retryable).to.equal(true);
    expect(shouldRetryProviderError(error)).to.equal(true);
  });

  test('recognizes billing and credit markers in structured and plain bodies', () => {
    const bodies = [
      JSON.stringify({ error: { code: 'billing_hard_limit_reached', message: 'limit reached' } }),
      JSON.stringify({ error: { message: 'Your credit balance is too low to access the API.' } }),
      JSON.stringify({ code: 'insufficient_credits', message: 'add credits' }),
      JSON.stringify({ message: 'The organization has no remaining credits.' }),
      'quota exceeded for this project',
    ];
    for (const body of bodies) {
      const error = normalizeHttpError(400, body);
      expect(error.code, body).to.equal('quota');
      expect(error.retryable, body).to.equal(false);
    }
  });

  test('does not treat an HTML billing page or an unrelated body as quota', () => {
    expect(normalizeHttpError(502, '<html><body>billing quota exceeded</body></html>').code).to.equal('server');
    expect(normalizeHttpError(400, JSON.stringify({ error: { message: 'max_tokens must be positive' } })).code).to.equal('http');
  });

  test('quota guidance is actionable and credentials stay redacted', () => {
    const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz012345';
    const error = normalizeHttpError(
      402,
      JSON.stringify({ error: { message: `No quota left for ${secret}` } }),
      secret,
    );
    expect(error.code).to.equal('quota');
    expect(error.message).to.not.contain(secret);
    expect(error.message).to.contain('[REDACTED]');
    expect(errorHint(error.code)).to.contain('local provider');
  });
});

suite('retry metadata and Retry-After passthrough (D8, D9)', () => {
  test('retryable metadata agrees with the retry policy', () => {
    const cases: ReadonlyArray<{ status: number; retryable: boolean; code: string }> = [
      { status: 408, retryable: false, code: 'timeout' },
      { status: 500, retryable: false, code: 'server' },
      { status: 502, retryable: true, code: 'server' },
      { status: 503, retryable: true, code: 'server' },
      { status: 504, retryable: false, code: 'server' },
      { status: 429, retryable: true, code: 'rate_limit' },
      { status: 401, retryable: false, code: 'authentication' },
      { status: 404, retryable: false, code: 'http' },
    ];
    for (const entry of cases) {
      const error = normalizeHttpError(entry.status, '');
      expect(error.code, `HTTP ${entry.status}`).to.equal(entry.code);
      expect(error.retryable, `HTTP ${entry.status} metadata`).to.equal(entry.retryable);
      expect(shouldRetryProviderError(error), `HTTP ${entry.status} policy`).to.equal(entry.retryable);
    }
  });

  test('server guidance matches the retry decision', () => {
    expect(normalizeHttpError(500, '').message).to.contain('not retried automatically');
    expect(normalizeHttpError(504, '').message).to.contain('not retried automatically');
    expect(normalizeHttpError(502, '').message).to.contain('may be retried automatically once');
    expect(normalizeHttpError(503, '').message).to.contain('may be retried automatically once');
    expect(normalizeHttpError(408, '').message).to.contain('not retried automatically');
  });

  test('shouldRetryProviderError ignores non-provider errors and explicit flags', () => {
    expect(shouldRetryProviderError(new Error('boom'))).to.equal(false);
    expect(shouldRetryProviderError(undefined)).to.equal(false);
    expect(shouldRetryProviderError(new ProviderError('server', 'manual', { status: 500, retryable: true }))).to.equal(false);
    expect(shouldRetryProviderError(new ProviderError('timeout', 'slow', { retryable: true }))).to.equal(false);
  });

  test('429 Retry-After headers reach the normalized error', () => {
    const error = normalizeHttpError(429, '', undefined, { 'retry-after': '7' });
    expect(error.retryAfterMs).to.equal(7_000);
    const capped = normalizeHttpError(429, '', undefined, new Headers({ 'retry-after': '600' }));
    expect(capped.retryAfterMs).to.equal(60_000);
    const missing = normalizeHttpError(429, '');
    expect(missing.retryAfterMs).to.equal(500);
  });

  test('503 Retry-After headers reach the normalized error', () => {
    const error = normalizeHttpError(503, '', undefined, new Map([['Retry-After', '3']]));
    expect(error.code).to.equal('server');
    expect(error.retryable).to.equal(true);
    expect(error.retryAfterMs).to.equal(3_000);
    expect(normalizeHttpError(503, '', undefined, new Map([['retry-after', '2']])).retryAfterMs).to.equal(2_000);
    expect(normalizeHttpError(503, '', undefined, { 'Retry-After': '4' }).retryAfterMs).to.equal(4_000);
    expect(normalizeHttpError(503, '').retryAfterMs).to.equal(500);
  });

  test('Retry-After is not applied to statuses the policy never retries', () => {
    expect(normalizeHttpError(500, '', undefined, { 'retry-after': '9' }).retryAfterMs).to.equal(undefined);
    expect(normalizeHttpError(408, '', undefined, { 'retry-after': '9' }).retryAfterMs).to.equal(undefined);
    expect(normalizeHttpError(401, '', undefined, { 'retry-after': '9' }).retryAfterMs).to.equal(undefined);
  });
});
