import { expect } from 'chai';
import {
  buildChatCompletionsUrl,
  describeEndpointHost,
  isLoopbackHost,
  normalizeBaseUrl,
} from '../../src/providers/endpoint';
import { ProviderError } from '../../src/providers/errors';

function expectConfigurationError(fn: () => unknown): ProviderError {
  try {
    fn();
  } catch (error) {
    expect(error).to.be.instanceOf(ProviderError);
    expect((error as ProviderError).code).to.equal('configuration');
    return error as ProviderError;
  }
  throw new Error('Expected a ProviderError to be thrown.');
}

suite('endpoint validation', () => {
  test('accepts HTTPS endpoints and strips trailing slashes', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1/')).to.equal('https://api.openai.com/v1');
    expect(normalizeBaseUrl('  https://example.com  ')).to.equal('https://example.com');
  });

  test('accepts loopback HTTP when explicitly enabled', () => {
    expect(normalizeBaseUrl('http://localhost:11434/v1')).to.equal('http://localhost:11434/v1');
    expect(normalizeBaseUrl('http://127.0.0.1:1234/v1')).to.equal('http://127.0.0.1:1234/v1');
    expect(normalizeBaseUrl('http://[::1]:8080/v1')).to.equal('http://[::1]:8080/v1');
  });

  test('rejects loopback HTTP when insecure localhost is disabled', () => {
    expectConfigurationError(() =>
      normalizeBaseUrl('http://127.0.0.1:11434/v1', { allowInsecureLocalhost: false }),
    );
  });

  test('rejects plain HTTP to a remote host', () => {
    expectConfigurationError(() => normalizeBaseUrl('http://example.com/v1'));
  });

  test('rejects unsupported schemes', () => {
    expectConfigurationError(() => normalizeBaseUrl('ftp://example.com/v1'));
    expectConfigurationError(() => normalizeBaseUrl('file:///tmp/model'));
  });

  test('rejects empty and malformed URLs', () => {
    expectConfigurationError(() => normalizeBaseUrl(''));
    expectConfigurationError(() => normalizeBaseUrl('   '));
    expectConfigurationError(() => normalizeBaseUrl('not-a-url'));
  });

  test('rejects embedded credentials, query strings and fragments', () => {
    expectConfigurationError(() => normalizeBaseUrl('https://user:pass@example.com/v1'));
    expectConfigurationError(() => normalizeBaseUrl('https://example.com/v1?key=abc'));
    expectConfigurationError(() => normalizeBaseUrl('https://example.com/v1#fragment'));
  });

  test('identifies loopback hosts case-insensitively', () => {
    expect(isLoopbackHost('LOCALHOST')).to.equal(true);
    expect(isLoopbackHost('127.0.0.1')).to.equal(true);
    expect(isLoopbackHost('[::1]')).to.equal(true);
    expect(isLoopbackHost('::1')).to.equal(true);
    expect(isLoopbackHost('localhost.example.com')).to.equal(false);
    expect(isLoopbackHost('10.0.0.1')).to.equal(false);
  });
});

suite('chat completions URL', () => {
  test('appends the path exactly once', () => {
    expect(buildChatCompletionsUrl('https://api.openai.com/v1')).to.equal(
      'https://api.openai.com/v1/chat/completions',
    );
    expect(buildChatCompletionsUrl('https://api.openai.com/v1/')).to.equal(
      'https://api.openai.com/v1/chat/completions',
    );
    expect(buildChatCompletionsUrl('https://api.openai.com/v1/chat/completions')).to.equal(
      'https://api.openai.com/v1/chat/completions',
    );
  });

  test('reports the endpoint host without credentials', () => {
    expect(describeEndpointHost('https://api.example.com/v1')).to.equal('api.example.com');
    expect(describeEndpointHost('http://127.0.0.1:11434/v1')).to.equal('127.0.0.1:11434');
    expect(describeEndpointHost('not a url')).to.equal('invalid endpoint');
  });
});
