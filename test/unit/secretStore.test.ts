import { expect } from 'chai';
import { CredentialValidationError } from '../../src/security/credential';
import {
  API_KEY_SECRET_KEY,
  LEGACY_API_KEY_SECRET_KEY,
  SecretStore,
  isProviderApiKeySecretKey,
  secretKeyForProvider,
} from '../../src/security/secretStore';
import { MemorySecretStorage } from './helpers';

suite('secret storage', () => {
  test('stores and retrieves a validated credential under the namespaced key', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);

    await store.set('  sk-test-value  ');

    expect(storage.values.get(API_KEY_SECRET_KEY)).to.equal('sk-test-value');
    expect(await store.get()).to.equal('sk-test-value');
    expect(await store.has()).to.equal(true);
  });

  test('treats missing and empty entries as absent', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);

    expect(await store.get()).to.equal(undefined);
    expect(await store.has()).to.equal(false);

    storage.values.set(API_KEY_SECRET_KEY, '');
    expect(await store.get()).to.equal(undefined);
  });

  test('rejects invalid credentials without writing to storage', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);

    let failure: unknown;
    try {
      await store.set('invalid key with spaces');
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(CredentialValidationError);
    expect(storage.values.size).to.equal(0);
  });

  test('clears the stored credential', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);

    await store.set('sk-test-value');
    await store.clear();

    expect(await store.has()).to.equal(false);
  });

  test('supports a custom secret key', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage, 'custom.key');

    await store.set('sk-test-value');

    expect(storage.values.get('custom.key')).to.equal('sk-test-value');
    expect(storage.values.has(API_KEY_SECRET_KEY)).to.equal(false);
  });
});

suite('provider-specific secret isolation', () => {
  test('generates provider-specific keys', () => {
    expect(secretKeyForProvider('openai-compatible')).to.equal(
      'quantsmind.provider.openai-compatible.apiKey',
    );
    expect(secretKeyForProvider('gemini')).to.equal('quantsmind.provider.gemini.apiKey');
    expect(isProviderApiKeySecretKey('quantsmind.provider.gemini.apiKey')).to.equal(true);
    expect(isProviderApiKeySecretKey('quantsmind.provider.openaiCompatible.apiKey')).to.equal(true);
    expect(isProviderApiKeySecretKey('other.key')).to.equal(false);
  });

  test('isolates openai-compatible and gemini credentials', async () => {
    const storage = new MemorySecretStorage();
    const base = new SecretStore(storage);
    const openai = base.forProvider('openai-compatible');
    const gemini = base.forProvider('gemini');

    await openai.set('sk-openai-value');
    await gemini.set('AQ-gemini-value');

    expect(storage.values.get('quantsmind.provider.openai-compatible.apiKey')).to.equal('sk-openai-value');
    expect(storage.values.get('quantsmind.provider.gemini.apiKey')).to.equal('AQ-gemini-value');
    expect(await openai.get()).to.equal('sk-openai-value');
    expect(await gemini.get()).to.equal('AQ-gemini-value');

    await gemini.clear();
    expect(await gemini.has()).to.equal(false);
    expect(await openai.get()).to.equal('sk-openai-value');
  });

  test('does not overwrite one provider credential when saving another', async () => {
    const storage = new MemorySecretStorage();
    const base = new SecretStore(storage);
    const gemini = base.forProvider('gemini');
    const openai = base.forProvider('openai-compatible');

    await gemini.set('AQ-gemini-value');
    await openai.set('sk-openai-value');

    expect(await gemini.get()).to.equal('AQ-gemini-value');
    expect(await openai.get()).to.equal('sk-openai-value');
  });

  test('falls back to legacy openaiCompatible key for backward compatibility', async () => {
    const storage = new MemorySecretStorage();
    storage.values.set(LEGACY_API_KEY_SECRET_KEY, 'sk-legacy-value');

    const openai = new SecretStore(storage).forProvider('openai-compatible');
    expect(await openai.get()).to.equal('sk-legacy-value');
    expect(await openai.has()).to.equal(true);
  });

  test('does not fall back to legacy key for gemini', async () => {
    const storage = new MemorySecretStorage();
    storage.values.set(LEGACY_API_KEY_SECRET_KEY, 'sk-legacy-value');

    const gemini = new SecretStore(storage).forProvider('gemini');
    expect(await gemini.get()).to.equal(undefined);
    expect(await gemini.has()).to.equal(false);
  });

  test('prefers canonical key over legacy key', async () => {
    const storage = new MemorySecretStorage();
    storage.values.set(LEGACY_API_KEY_SECRET_KEY, 'sk-legacy-value');
    storage.values.set('quantsmind.provider.openai-compatible.apiKey', 'sk-canonical-value');

    const openai = new SecretStore(storage).forProvider('openai-compatible');
    expect(await openai.get()).to.equal('sk-canonical-value');
  });

  test('migrates legacy key on set and removes stale legacy entry', async () => {
    const storage = new MemorySecretStorage();
    storage.values.set(LEGACY_API_KEY_SECRET_KEY, 'sk-legacy-value');

    const openai = new SecretStore(storage).forProvider('openai-compatible');
    await openai.set('sk-new-value');

    expect(storage.values.get('quantsmind.provider.openai-compatible.apiKey')).to.equal('sk-new-value');
    expect(storage.values.has(LEGACY_API_KEY_SECRET_KEY)).to.equal(false);
    expect(await openai.get()).to.equal('sk-new-value');
  });

  test('clear removes both canonical and legacy keys for openai-compatible', async () => {
    const storage = new MemorySecretStorage();
    storage.values.set(LEGACY_API_KEY_SECRET_KEY, 'sk-legacy-value');
    storage.values.set('quantsmind.provider.openai-compatible.apiKey', 'sk-canonical-value');

    const openai = new SecretStore(storage).forProvider('openai-compatible');
    await openai.clear();

    expect(storage.values.has(LEGACY_API_KEY_SECRET_KEY)).to.equal(false);
    expect(storage.values.has('quantsmind.provider.openai-compatible.apiKey')).to.equal(false);
    expect(await openai.has()).to.equal(false);
  });

  test('gemini clear does not remove openai credentials', async () => {
    const storage = new MemorySecretStorage();
    const base = new SecretStore(storage);
    const openai = base.forProvider('openai-compatible');
    const gemini = base.forProvider('gemini');

    await openai.set('sk-openai-value');
    await gemini.set('AQ-gemini-value');
    await gemini.clear();

    expect(await openai.get()).to.equal('sk-openai-value');
  });
});
