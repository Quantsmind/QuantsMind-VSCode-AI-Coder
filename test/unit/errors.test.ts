import { expect } from 'chai';
import {
  ProviderError,
  errorHint,
  isProviderError,
  normalizeHttpError,
  normalizeThrownError,
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
    expect(normalizeHttpError(408, '').retryable).to.equal(true);
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
  });
});
