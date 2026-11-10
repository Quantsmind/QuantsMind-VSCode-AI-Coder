import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listProviderProfileIds } from '../../src/providers/profiles';
import {
  API_KEY_SECRET_KEY,
  LEGACY_API_KEY_SECRET_KEY,
  isProviderApiKeySecretKey,
  secretKeyForProvider,
} from '../../src/security/secretStore';

const CREDENTIAL_PROFILES: readonly string[] = [
  'openai-compatible',
  'openai',
  'groq',
  'openrouter',
  'ollama',
  'lm-studio',
  'llama-cpp',
  'vllm',
  'gemini',
  'pollinations',
];

suite('provider API key secret-change detection (D10)', () => {
  test('covers all nine registered credential profiles', () => {
    expect([...listProviderProfileIds()].sort()).to.deep.equal([...CREDENTIAL_PROFILES].sort());
  });

  test('recognises the canonical secret key of every provider profile', () => {
    for (const type of CREDENTIAL_PROFILES) {
      const key = secretKeyForProvider(type);
      expect(key, type).to.equal(`quantsmind.provider.${type}.apiKey`);
      expect(isProviderApiKeySecretKey(key), key).to.equal(true);
    }
  });

  test('recognises the legacy camelCase key', () => {
    expect(LEGACY_API_KEY_SECRET_KEY).to.equal('quantsmind.provider.openaiCompatible.apiKey');
    expect(API_KEY_SECRET_KEY).to.equal(LEGACY_API_KEY_SECRET_KEY);
    expect(isProviderApiKeySecretKey(LEGACY_API_KEY_SECRET_KEY)).to.equal(true);
    expect(isProviderApiKeySecretKey('quantsmind.provider.openaiCompatible.apiKey')).to.equal(true);
  });

  test('detects groq, openai and gemini rotations the legacy equality check missed', () => {
    for (const type of ['groq', 'openai', 'gemini']) {
      const key = secretKeyForProvider(type);
      expect(isProviderApiKeySecretKey(key), key).to.equal(true);
      // The old handler compared against this single key, so these never refreshed.
      expect(key, type).to.not.equal(API_KEY_SECRET_KEY);
    }
  });

  test('ignores keys that are not provider credentials', () => {
    const unrelated = [
      'quantsmind.provider.openai.baseUrl',
      'quantsmind.other.apiKey',
      '',
      'quantsmind.provider.gemini.apiKey.extra',
      'other-extension.provider.openai.apiKey',
      'quantsmind.provider.groq.apiKey ',
      'quantsmind.provider.openai.apikey',
      'apiKey',
    ];
    for (const key of unrelated) {
      expect(isProviderApiKeySecretKey(key), `"${key}"`).to.equal(false);
    }
  });

  test('falls back to the legacy key for an empty or blank provider type', () => {
    expect(secretKeyForProvider('')).to.equal(LEGACY_API_KEY_SECRET_KEY);
    expect(secretKeyForProvider('   ')).to.equal(LEGACY_API_KEY_SECRET_KEY);
    expect(secretKeyForProvider('\t\n')).to.equal(LEGACY_API_KEY_SECRET_KEY);
  });

  test('trims whitespace around the provider type', () => {
    expect(secretKeyForProvider('  groq  ')).to.equal('quantsmind.provider.groq.apiKey');
    expect(secretKeyForProvider(' gemini ')).to.equal(secretKeyForProvider('gemini'));
    expect(isProviderApiKeySecretKey(secretKeyForProvider('  groq  '))).to.equal(true);
  });

  test('builds a distinct canonical key per profile so a rotation is attributable', () => {
    const keys = CREDENTIAL_PROFILES.map((type) => secretKeyForProvider(type));
    expect(new Set(keys).size).to.equal(CREDENTIAL_PROFILES.length);
    expect(keys).to.not.include(LEGACY_API_KEY_SECRET_KEY);
  });
});

// Source contract, not behaviour: extension.ts imports `vscode` and the handler needs a real
// SecretStorage event, so the wiring is pinned here instead of probing the user's keychain.
suite('secret change refresh source contract (D10)', () => {
  function extensionSource(): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'src', 'extension.ts'), 'utf8');
  }

  function secretChangeHandler(): string {
    const source = extensionSource();
    const start = source.indexOf('context.secrets.onDidChange(');
    expect(start, 'the secrets.onDidChange handler must exist').to.be.at.least(0);
    const end = source.indexOf('\n  );', start);
    expect(end, 'the handler registration must be closed').to.be.greaterThan(start);
    return source.slice(start, end);
  }

  test('the secrets.onDidChange handler refreshes for any provider API key', () => {
    const handler = secretChangeHandler();
    expect(handler).to.contain('isProviderApiKeySecretKey(event.key)');
    expect(handler).to.contain('refreshAll()');
    expect(extensionSource()).to.match(
      /import \{[^}]*isProviderApiKeySecretKey[^}]*\} from '\.\/security\/secretStore'/,
    );
  });

  test('the handler no longer compares the event key against the single legacy key', () => {
    const handler = secretChangeHandler();
    expect(handler).to.not.contain('API_KEY_SECRET_KEY');
    expect(handler).to.not.contain('event.key ===');
    expect(extensionSource()).to.not.match(/event\.key\s*===\s*(?:LEGACY_)?API_KEY_SECRET_KEY/);
  });
});