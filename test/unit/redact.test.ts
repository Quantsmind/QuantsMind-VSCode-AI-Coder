import { expect } from 'chai';
import { redactSecrets } from '../../src/security/redact';

suite('secret redaction', () => {
  test('redacts an exact configured credential', () => {
    const secret = 'custom-token-value-123456';
    const result = redactSecrets(`Authorization uses ${secret} here.`, [secret]);
    expect(result.text).to.not.contain(secret);
    expect(result.text).to.contain('[REDACTED]');
    expect(result.count).to.be.greaterThan(0);
  });

  test('ignores empty and very short secrets', () => {
    const result = redactSecrets('abc', ['', '  ', 'ab', undefined, null]);
    expect(result.text).to.equal('abc');
    expect(result.count).to.equal(0);
  });

  test('redacts well-known API key shapes', () => {
    const samples = [
      'sk-proj-abcdefghijklmnop1234567890',
      'ghp_abcdefghijklmnopqrstuvwxyz123456',
      'github_pat_abcdefghijklmnopqrstuvwxyz_1234567890',
      'AKIAABCDEFGHIJKLMNOP',
      'xoxb-1234567890-abcdefghij',
      'AIzaabcdefghijklmnopqrstuvwxyz0123456789',
    ];
    for (const sample of samples) {
      const result = redactSecrets(`token=${sample} end`);
      expect(result.text, sample).to.not.contain(sample);
      expect(result.count, sample).to.be.greaterThan(0);
    }
  });

  test('redacts provider-masked key fragments', () => {
    const samples = [
      'sk-proj-abcd***wxyz',
      'sk-or-v1-1234****9876',
      'sk-...abcd',
      'sk-live-****1234',
      'abcd****wxyz',
    ];
    for (const sample of samples) {
      const result = redactSecrets(`The provider rejected key ${sample}.`);
      expect(result.text, sample).to.not.contain(sample);
      expect(result.text, sample).to.contain('[REDACTED]');
      expect(result.count, sample).to.be.greaterThan(0);
    }
  });

  test('redacts masked credentials in headers, assignments and JSON', () => {
    const bearer = redactSecrets('Authorization: Bearer sk-proj-abcd***wxyz');
    expect(bearer.text).to.contain('Bearer [REDACTED]');
    expect(bearer.text).to.not.contain('abcd');

    const assigned = redactSecrets('api_key = "abcd****wxyz"');
    expect(assigned.text).to.contain('[REDACTED]');
    expect(assigned.text).to.not.contain('wxyz');

    const json = redactSecrets('{"apiKey":"sk-proj-****1234"}');
    expect(json.text).to.contain('[REDACTED]');
    expect(json.text).to.not.contain('1234');

    const header = redactSecrets('x-api-key: masked-value-1234');
    expect(header.text).to.contain('[REDACTED]');
    expect(header.text).to.not.contain('masked-value-1234');
  });

  test('redacts JWTs and URL credentials', () => {
    const jwt =
      'eyJhbGciOiJub25lIn0.eyJzdWIiOiJkZW1vLXVzZXIifQ.abcdefghijklmnop';
    const token = redactSecrets(`token ${jwt}`);
    expect(token.text).to.not.contain(jwt);
    expect(token.text).to.contain('[REDACTED]');

    const url = redactSecrets('https://demo-user:demo-pass@example.test/path');
    expect(url.text).to.not.contain('demo-pass');
    expect(url.text).to.contain('https://[REDACTED]@example.test/path');
  });

  test('redacts private key blocks', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const result = redactSecrets(`before\n${pem}\nafter`);
    expect(result.text).to.equal('before\n[REDACTED PRIVATE KEY]\nafter');
  });

  test('redacts bearer tokens and authorization headers', () => {
    const bearer = redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz');
    expect(bearer.text).to.contain('Bearer [REDACTED]');
    expect(bearer.text).to.not.contain('abcdefghijklmnopqrstuvwxyz');

    const header = redactSecrets('Authorization: Basic dXNlcjpwYXNzd29yZA==');
    expect(header.text).to.contain('[REDACTED]');
    expect(header.text).to.not.contain('dXNlcjpwYXNzd29yZA==');
  });

  test('redacts assignment and JSON secrets', () => {
    const assigned = redactSecrets(`api_key = "supersecretvalue"`);
    expect(assigned.text).to.contain('[REDACTED]');
    expect(assigned.text).to.not.contain('supersecretvalue');

    const json = redactSecrets('{"password": "another-secret-value"}');
    expect(json.text).to.contain('[REDACTED]');
    expect(json.text).to.not.contain('another-secret-value');
  });

  test('handles empty input and preserves unrelated text', () => {
    expect(redactSecrets('').text).to.equal('');
    const unchanged = redactSecrets('function add(a, b) { return a + b; }');
    expect(unchanged.text).to.equal('function add(a, b) { return a + b; }');
    expect(unchanged.count).to.equal(0);
  });
});
