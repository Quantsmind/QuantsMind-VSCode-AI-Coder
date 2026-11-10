/**
 * WP1 — Provider/secret/credential unit tests (no `vscode` dependency).
 *
 * Verifies SecretStore key isolation, credential masking, and provider
 * profile classification without booting an extension host.
 */

import { expect } from 'chai';
import { SecretStore } from '../../src/security/secretStore';
import { MemorySecretStorage } from '../unit/helpers';

suite('WP1 — SecretStore credential isolation', () => {
  test('creates distinct canonical keys per provider', () => {
    const storage = new MemorySecretStorage();
    const openaiCompatible = SecretStore.forProvider(storage, 'openai-compatible');
    const openai = SecretStore.forProvider(storage, 'openai');
    const groq = SecretStore.forProvider(storage, 'groq');
    const gemini = SecretStore.forProvider(storage, 'gemini');

    expect(openaiCompatible.key).to.equal('quantsmind.provider.openai-compatible.apiKey');
    expect(openai.key).to.equal('quantsmind.provider.openai.apiKey');
    expect(groq.key).to.equal('quantsmind.provider.groq.apiKey');
    expect(gemini.key).to.equal('quantsmind.provider.gemini.apiKey');
    expect(openaiCompatible.key).to.not.equal(openai.key);
    expect(openai.key).to.not.equal(groq.key);
    expect(groq.key).to.not.equal(gemini.key);
  });

  test('treats missing entries as absent', async () => {
    const storage = new MemorySecretStorage();
    const secrets = new SecretStore(storage);

    expect(await secrets.has()).to.equal(false);
    expect(await secrets.get()).to.equal(undefined);
  });

  test('stores and retrieves credentials per provider', async () => {
    const storage = new MemorySecretStorage();
    const pollinations = SecretStore.forProvider(storage, 'pollinations');
    const openai = SecretStore.forProvider(storage, 'openai');

    expect(await pollinations.get()).to.equal(undefined);
    await pollinations.set('test-key-pollinations');
    const retrieved = await pollinations.get();
    expect(retrieved).to.equal('test-key-pollinations');

    // openai should not see pollinations' key
    expect(await openai.get()).to.equal(undefined);

    await pollinations.clear();
    expect(await pollinations.has()).to.equal(false);
  });

  test('SecretStore falls back to legacy key for openai-compatible only', async () => {
    const storage = new MemorySecretStorage();
    const legacyKey = 'quantsmind.provider.openaiCompatible.apiKey';
    await storage.store(legacyKey, 'legacy-key-value');

    // openai-compatible can see the legacy key
    const compatible = SecretStore.forProvider(storage, 'openai-compatible');
    expect(await compatible.get()).to.equal('legacy-key-value');

    // openai should NOT see the legacy key
    const openai = SecretStore.forProvider(storage, 'openai');
    expect(await openai.get()).to.equal(undefined);

    // groq should NOT see the legacy key
    const groq = SecretStore.forProvider(storage, 'groq');
    expect(await groq.get()).to.equal(undefined);
  });

  test('clearing one provider preserves unrelated credentials', async () => {
    const storage = new MemorySecretStorage();
    const groq = SecretStore.forProvider(storage, 'groq');
    const openai = SecretStore.forProvider(storage, 'openai');

    await groq.set('groq-key-123');
    await openai.set('openai-key-456');

    await groq.clear();
    expect(await groq.has()).to.equal(false);
    expect(await openai.has()).to.equal(true);
    expect(await openai.get()).to.equal('openai-key-456');
  });
});
