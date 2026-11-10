import { expect } from 'chai';
import {
  isLoopbackHost,
  isLoopbackOrPrivateHost,
  isPrivateIPv4,
  normalizeBaseUrl,
} from '../../src/providers/endpoint';
import { ProviderError } from '../../src/providers/errors';

function expectConfigError(fn: () => unknown, code: string): void {
  let failure: unknown;
  try {
    fn();
  } catch (error) {
    failure = error;
  }
  expect(failure).to.be.instanceOf(ProviderError);
  expect((failure as ProviderError).code).to.equal(code);
}

suite('endpoint validation for profiles', () => {
  test('identifies private IPv4 ranges', () => {
    expect(isPrivateIPv4('10.0.0.5')).to.equal(true);
    expect(isPrivateIPv4('192.168.1.50')).to.equal(true);
    expect(isPrivateIPv4('172.16.0.1')).to.equal(true);
    expect(isPrivateIPv4('172.31.255.255')).to.equal(true);
    expect(isPrivateIPv4('172.32.0.1')).to.equal(false);
    expect(isPrivateIPv4('8.8.8.8')).to.equal(false);
    expect(isPrivateIPv4('api.openai.com')).to.equal(false);
  });

  test('treats only loopback and private literals as local/LAN (B1 boundary)', () => {
    expect(isLoopbackOrPrivateHost('localhost')).to.equal(true);
    expect(isLoopbackOrPrivateHost('127.0.0.1')).to.equal(true);
    expect(isLoopbackOrPrivateHost('192.168.1.50')).to.equal(true);
    expect(isLoopbackOrPrivateHost('10.0.0.5')).to.equal(true);
    expect(isLoopbackOrPrivateHost('[::1]')).to.equal(true);
    // B1: single-label and .local hosts are NOT treated as private without
    // DNS resolution. They may resolve to a public address via DNS search
    // domains and are therefore not allowed for plain HTTP.
    expect(isLoopbackOrPrivateHost('ollama')).to.equal(false);
    expect(isLoopbackOrPrivateHost('myserver.local')).to.equal(false);
    expect(isLoopbackOrPrivateHost('api.openai.com')).to.equal(false);
    expect(isLoopbackOrPrivateHost('8.8.8.8')).to.equal(false);
    expect(isLoopbackHost('192.168.1.50')).to.equal(false);
  });

  test('allows HTTP LAN endpoints when insecure localhost is enabled', () => {
    expect(
      normalizeBaseUrl('http://192.168.1.50:11434/v1', { allowInsecureLocalhost: true }),
    ).to.equal('http://192.168.1.50:11434/v1');
    expect(
      normalizeBaseUrl('http://10.0.0.5:8080/v1', { allowInsecureLocalhost: true }),
    ).to.equal('http://10.0.0.5:8080/v1');
    expect(
      normalizeBaseUrl('http://127.0.0.1:11434/v1', { allowInsecureLocalhost: true }),
    ).to.equal('http://127.0.0.1:11434/v1');
  });

  test('rejects plain HTTP to public hosts', () => {
    expectConfigError(
      () => normalizeBaseUrl('http://example.com/v1', { allowInsecureLocalhost: true }),
      'configuration',
    );
    expectConfigError(
      () => normalizeBaseUrl('http://8.8.8.8:9999/v1', { allowInsecureLocalhost: true }),
      'configuration',
    );
    // A single-label hostname is not private by literal address; it could
    // resolve via DNS search to a public host, so plain HTTP is rejected.
    expectConfigError(
      () => normalizeBaseUrl('http://ollama:11434/v1', { allowInsecureLocalhost: true }),
      'configuration',
    );
    // An .local hostname needs DNS/mDNS resolution; not treated as private.
    expectConfigError(
      () => normalizeBaseUrl('http://myserver.local:11434/v1', { allowInsecureLocalhost: true }),
      'configuration',
    );
    // Even if the label looks innocuous, the hostname still needs HTTPS.
    expectConfigError(
      () => normalizeBaseUrl('http://public-host:8080/v1', { allowInsecureLocalhost: true }),
      'configuration',
    );
  });

  test('allows HTTPS for single-label and .local hostnames', () => {
    expect(
      normalizeBaseUrl('https://ollama:11434/v1', { allowInsecureLocalhost: true }),
    ).to.equal('https://ollama:11434/v1');
    expect(
      normalizeBaseUrl('https://myserver.local/v1', { allowInsecureLocalhost: true }),
    ).to.equal('https://myserver.local/v1');
  });

  test('rejects HTTP LAN endpoints when insecure flag is disabled', () => {
    expectConfigError(
      () => normalizeBaseUrl('http://192.168.1.50:11434/v1', { allowInsecureLocalhost: false }),
      'configuration',
    );
    expectConfigError(
      () => normalizeBaseUrl('http://127.0.0.1:11434/v1', { allowInsecureLocalhost: false }),
      'configuration',
    );
  });

  test('allows HTTPS for any host', () => {
    expect(
      normalizeBaseUrl('https://api.groq.com/openai/v1', { allowInsecureLocalhost: false }),
    ).to.equal('https://api.groq.com/openai/v1');
  });

  test('rejects embedded credentials, query and fragment regardless of LAN', () => {
    expectConfigError(
      () => normalizeBaseUrl('http://user:pass@192.168.1.50/v1', { allowInsecureLocalhost: true }),
      'configuration',
    );
    expectConfigError(
      () => normalizeBaseUrl('http://192.168.1.50/v1?key=1', { allowInsecureLocalhost: true }),
      'configuration',
    );
    expectConfigError(
      () => normalizeBaseUrl('https://api.openai.com/v1#frag', { allowInsecureLocalhost: true }),
      'configuration',
    );
    expectConfigError(
      () => normalizeBaseUrl('http://user:pass@ollama/v1', { allowInsecureLocalhost: true }),
      'configuration',
    );
  });

  test('rejects unsupported schemes and malformed URLs', () => {
    expectConfigError(() => normalizeBaseUrl('ftp://192.168.1.50/v1', { allowInsecureLocalhost: true }), 'configuration');
    expectConfigError(() => normalizeBaseUrl('not a url', { allowInsecureLocalhost: true }), 'configuration');
  });

  test('strips trailing slashes and validates explicit ports', () => {
    expect(
      normalizeBaseUrl('http://localhost:11434/v1/', { allowInsecureLocalhost: true }),
    ).to.equal('http://localhost:11434/v1');
  });
});
