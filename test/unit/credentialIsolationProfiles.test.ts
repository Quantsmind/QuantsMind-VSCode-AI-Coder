import { expect } from 'chai';
import {
  API_KEY_SECRET_KEY,
  LEGACY_API_KEY_SECRET_KEY,
  SecretStore,
  secretKeyForProvider,
} from '../../src/security/secretStore';
import { MemorySecretStorage } from './helpers';

suite('credential isolation across provider profiles (B1)', () => {
  test('generates distinct keys for profiles sharing the openai adapter', () => {
    const keys = [
      'openai-compatible',
      'openai',
      'groq',
      'openrouter',
      'ollama',
      'lm-studio',
      'llama-cpp',
      'vllm',
    ].map((id) => secretKeyForProvider(id));
    expect(new Set(keys).size).to.equal(8);
    expect(secretKeyForProvider('ollama')).to.equal('quantsmind.provider.ollama.apiKey');
    expect(secretKeyForProvider('groq')).to.equal('quantsmind.provider.groq.apiKey');
    expect(secretKeyForProvider('openrouter')).to.equal('quantsmind.provider.openrouter.apiKey');
    expect(secretKeyForProvider('lm-studio')).to.equal('quantsmind.provider.lm-studio.apiKey');
    expect(secretKeyForProvider('vllm')).to.equal('quantsmind.provider.vllm.apiKey');
    expect(secretKeyForProvider('openai')).to.equal('quantsmind.provider.openai.apiKey');
  });

  test('isolates credentials across all profiles', async () => {
    const storage = new MemorySecretStorage();
    const base = new SecretStore(storage);

    await base.forProvider('openai').set('sk-openai');
    await base.forProvider('groq').set('gsk-groq');
    await base.forProvider('openrouter').set('sk-or-router');
    await base.forProvider('ollama').set('ollama-key');

    expect(await base.forProvider('openai').get()).to.equal('sk-openai');
    expect(await base.forProvider('groq').get()).to.equal('gsk-groq');
    expect(await base.forProvider('openrouter').get()).to.equal('sk-or-router');
    expect(await base.forProvider('ollama').get()).to.equal('ollama-key');

    // Clearing one profile does not affect the others.
    await base.forProvider('groq').clear();
    expect(await base.forProvider('groq').has()).to.equal(false);
    expect(await base.forProvider('openai').get()).to.equal('sk-openai');
    expect(await base.forProvider('openrouter').get()).to.equal('sk-or-router');
  });

  test('legacy key falls back only for openai-compatible (B1)', async () => {
    const storage = new MemorySecretStorage();
    storage.values.set(LEGACY_API_KEY_SECRET_KEY, 'sk-legacy-value');

    expect(await new SecretStore(storage).forProvider('openai-compatible').get()).to.equal(
      'sk-legacy-value',
    );

    // openai must use only its canonical key and never inherit legacy.
    expect(await new SecretStore(storage).forProvider('openai').get()).to.equal(undefined);

    // Groq/OpenRouter/Ollama must not inherit the legacy OpenAI key.
    expect(await new SecretStore(storage).forProvider('groq').get()).to.equal(undefined);
    expect(await new SecretStore(storage).forProvider('openrouter').get()).to.equal(undefined);
    expect(await new SecretStore(storage).forProvider('ollama').get()).to.equal(undefined);
    expect(await new SecretStore(storage).forProvider('lm-studio').get()).to.equal(undefined);
    expect(await new SecretStore(storage).forProvider('llama-cpp').get()).to.equal(undefined);
    expect(await new SecretStore(storage).forProvider('vllm').get()).to.equal(undefined);
    expect(await new SecretStore(storage).forProvider('gemini').get()).to.equal(undefined);
  });

  test('openai cannot retrieve legacy credential (regression)', async () => {
    const storage = new MemorySecretStorage();
    storage.values.set(LEGACY_API_KEY_SECRET_KEY, 'sk-legacy-value');

    const openai = new SecretStore(storage).forProvider('openai');
    expect(await openai.get()).to.equal(undefined);
    expect(await openai.has()).to.equal(false);

    // Setting an openai credential reads only its canonical key.
    await openai.set('sk-openai-new');
    expect(await openai.get()).to.equal('sk-openai-new');
    // Legacy entry is left untouched for openai-compatible.
    expect(storage.values.get(LEGACY_API_KEY_SECRET_KEY)).to.equal('sk-legacy-value');
    expect(await new SecretStore(storage).forProvider('openai-compatible').get()).to.equal(
      'sk-legacy-value',
    );
  });

  test('groq and openrouter cannot retrieve legacy credential (regression)', async () => {
    const storage = new MemorySecretStorage();
    storage.values.set(LEGACY_API_KEY_SECRET_KEY, 'sk-legacy-value');

    expect(await new SecretStore(storage).forProvider('groq').get()).to.equal(undefined);
    expect(await new SecretStore(storage).forProvider('openrouter').get()).to.equal(undefined);
  });

  test('canonical credentials remain isolated', async () => {
    const storage = new MemorySecretStorage();
    const base = new SecretStore(storage);

    await base.forProvider('openai-compatible').set('sk-openai-compatible');
    await base.forProvider('openai').set('sk-openai');
    await base.forProvider('groq').set('gsk-groq');
    await base.forProvider('openrouter').set('sk-or-router');
    await base.forProvider('gemini').set('AQ-gemini');

    expect(await base.forProvider('openai-compatible').get()).to.equal('sk-openai-compatible');
    expect(await base.forProvider('openai').get()).to.equal('sk-openai');
    expect(await base.forProvider('groq').get()).to.equal('gsk-groq');
    expect(await base.forProvider('openrouter').get()).to.equal('sk-or-router');
    expect(await base.forProvider('gemini').get()).to.equal('AQ-gemini');

    // Each profile's canonical key points at a distinct storage entry.
    expect(storage.values.get('quantsmind.provider.openai-compatible.apiKey')).to.equal(
      'sk-openai-compatible',
    );
    expect(storage.values.get('quantsmind.provider.openai.apiKey')).to.equal('sk-openai');
    expect(storage.values.get('quantsmind.provider.groq.apiKey')).to.equal('gsk-groq');
    expect(storage.values.get('quantsmind.provider.openrouter.apiKey')).to.equal('sk-or-router');
    expect(storage.values.get('quantsmind.provider.gemini.apiKey')).to.equal('AQ-gemini');
  });

  test('clearing one profile preserves all unrelated credentials', async () => {
    const storage = new MemorySecretStorage();
    storage.values.set(LEGACY_API_KEY_SECRET_KEY, 'sk-legacy-value');
    const base = new SecretStore(storage);

    await base.forProvider('openai').set('sk-openai');
    await base.forProvider('groq').set('gsk-groq');
    await base.forProvider('openrouter').set('sk-or-router');
    await base.forProvider('gemini').set('AQ-gemini');
    await base.forProvider('ollama').set('ollama-key');

    await base.forProvider('groq').clear();

    expect(await base.forProvider('groq').has()).to.equal(false);
    expect(await base.forProvider('openai').get()).to.equal('sk-openai');
    expect(await base.forProvider('openrouter').get()).to.equal('sk-or-router');
    expect(await base.forProvider('gemini').get()).to.equal('AQ-gemini');
    expect(await base.forProvider('ollama').get()).to.equal('ollama-key');
    // Legacy is untouched by groq clear and still readable by openai-compatible.
    expect(await base.forProvider('openai-compatible').get()).to.equal('sk-legacy-value');
  });

  test('clearing openai does not clear openai-compatible or legacy', async () => {
    const storage = new MemorySecretStorage();
    storage.values.set(LEGACY_API_KEY_SECRET_KEY, 'sk-legacy-value');
    const base = new SecretStore(storage);

    await base.forProvider('openai-compatible').set('sk-openai-compatible');
    await base.forProvider('openai').set('sk-openai');

    await base.forProvider('openai').clear();

    expect(await base.forProvider('openai').has()).to.equal(false);
    expect(await base.forProvider('openai-compatible').get()).to.equal('sk-openai-compatible');
    // openai-compatible still falls back to legacy when canonical is missing.
    await base.forProvider('openai-compatible').clear();
    expect(await base.forProvider('openai-compatible').get()).to.equal(undefined);
  });

  test('openai set preserves legacy entry for openai-compatible fallback', async () => {
    const storage = new MemorySecretStorage();
    storage.values.set(LEGACY_API_KEY_SECRET_KEY, 'sk-legacy-value');

    const base = new SecretStore(storage);
    await base.forProvider('openai').set('sk-openai-new');

    expect(await base.forProvider('openai').get()).to.equal('sk-openai-new');
    // openai-compatible still sees the legacy credential (openai did not claim it).
    expect(await base.forProvider('openai-compatible').get()).to.equal('sk-legacy-value');
  });

  test('does not expose API_KEY_SECRET_KEY alias confusion', () => {
    // The legacy constant remains importable for backwards compatibility.
    expect(API_KEY_SECRET_KEY).to.equal(LEGACY_API_KEY_SECRET_KEY);
  });
});
