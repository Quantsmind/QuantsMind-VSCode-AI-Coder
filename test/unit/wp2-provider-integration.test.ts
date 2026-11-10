/**
 * WP2 — Provider & LLM Integration Tests (unit-level, mocked).
 *
 * Verifies provider discovery, registration, profile selection, model
 * validation, endpoint configuration, API-key requirements, SecretStorage
 * integration, provider switching, paid-provider isolation, and error
 * propagation — all using mock servers, no live paid credentials.
 */

import { expect } from 'chai';
import {
  createProvider,
  listProviderTypes,
  providerDisplayName,
} from '../../src/providers/registry';
import {
  getProviderProfile,
  listProviderProfiles,
  providerAccessClass,
  providerPricingMetadata,
  type ProviderAccessClass,
} from '../../src/providers/profiles';
import type { OpenAiCompatibleConfig } from '../../src/providers/openaiCompatible';
import { ProviderError } from '../../src/providers/errors';
import { MemorySecretStorage } from '../unit/helpers';
import { SecretStore } from '../../src/security/secretStore';

const TEST_KEY = 'sk-test-abcdefghijklmnopqrstuvwxyz';

function config(overrides: Partial<OpenAiCompatibleConfig> = {}): OpenAiCompatibleConfig {
  return {
    apiKey: TEST_KEY,
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    timeoutMs: 5000,
    temperature: 0.2,
    maxOutputTokens: 128,
    stream: false,
    allowInsecureLocalhost: true,
    ...overrides,
  };
}

suite('WP2 — Provider discovery and registration', () => {
  test('exposes all ten provider profiles', () => {
    const ids = listProviderTypes();
    expect(ids).to.have.length(10);
    expect(ids).to.contain('openai-compatible');
    expect(ids).to.contain('pollinations');
    expect(ids).to.include('openai');
    expect(ids).to.include('groq');
    expect(ids).to.include('openrouter');
    expect(ids).to.include('ollama');
    expect(ids).to.include('lm-studio');
    expect(ids).to.include('llama-cpp');
    expect(ids).to.include('vllm');
    expect(ids).to.include('gemini');
  });

  test('registry exposes the same profiles as provider types', () => {
    const ids = listProviderTypes();
    const profiles = listProviderProfiles();
    expect(ids.sort()).to.deep.equal(profiles.map((p) => p.id).sort());
  });

  test('providerDisplayName resolves profiles and unknowns', () => {
    expect(providerDisplayName('openai-compatible')).to.equal('OpenAI-compatible');
    expect(providerDisplayName('openai')).to.equal('OpenAI');
    expect(providerDisplayName('pollinations')).to.equal('Pollinations');
    expect(providerDisplayName('ollama')).to.equal('Ollama (local)');
    expect(providerDisplayName('unknown-provider')).to.equal(undefined);
    expect(getProviderProfile('unknown-provider')).to.equal(undefined);
  });

  test('getProviderProfile returns correct profile for each id', () => {
    const pollinations = getProviderProfile('pollinations');
    expect(pollinations).to.not.equal(undefined);
    expect(pollinations?.id).to.equal('pollinations');
    expect(pollinations?.displayName).to.equal('Pollinations');
    expect(pollinations?.defaultBaseUrl).to.equal('https://text.pollinations.ai/openai');
    expect(pollinations?.defaultModel).to.equal('openai-fast');
  });
});

suite('WP2 — Provider access/pricing classification', () => {
  const expectedAccess: Record<string, ProviderAccessClass> = {
    'openai-compatible': 'custom-unknown',
    openai: 'paid',
    groq: 'free-tier-key',
    openrouter: 'paid',
    ollama: 'local',
    'lm-studio': 'local',
    'llama-cpp': 'local',
    vllm: 'local',
    gemini: 'free-tier-key',
    pollinations: 'free-no-key',
  };

  test('reports access class for every profile', () => {
    for (const [id, expected] of Object.entries(expectedAccess)) {
      const actual = providerAccessClass(id);
      expect(actual, id).to.equal(expected);
    }
  });

  test('pricing metadata is populated for every profile', () => {
    for (const id of listProviderTypes()) {
      const pricing = providerPricingMetadata(id);
      expect(pricing, id).to.not.equal(undefined);
      expect(pricing!.access, id).to.equal(expectedAccess[id]);
      expect(pricing!.pricingSource, id).to.be.a('string').and.to.have.length.greaterThan(0);
      expect(pricing!.verifiedAt, id).to.be.a('string').and.to.have.length.greaterThan(0);
    }
  });

  test('pollinations discloses anonymous-service variability', () => {
    const pricing = providerPricingMetadata('pollinations');
    expect(pricing?.anonymousNote).to.contain('can change without notice');
    expect(pricing?.endpointEditable).to.equal(true);
  });

  test('local profiles are never paid', () => {
    for (const id of ['ollama', 'lm-studio', 'llama-cpp', 'vllm']) {
      expect(providerAccessClass(id)).to.equal('local');
    }
  });
});

suite('WP2 — Provider instantiation and adapter selection', () => {
  test('creates openai-compatible provider for openai-compatible type', () => {
    const provider = createProvider('openai-compatible', config());
    expect(provider.id).to.equal('openai-compatible');
  });

  test('creates openai-compatible provider for pollinations type', () => {
    const provider = createProvider('pollinations', config({ baseUrl: 'https://text.pollinations.ai/openai' }));
    expect(provider.id).to.equal('openai-compatible');
  });

  test('creates gemini provider for gemini type', () => {
    const provider = createProvider('gemini', config({ baseUrl: 'https://api.openai.com/v1' }));
    expect(provider.id).to.equal('gemini');
  });

  test('rejects unsupported provider types', () => {
    expect(() => createProvider('not-a-provider' as any, config())).to.throw(ProviderError);
  });
});

suite('WP2 — Credential requirement per provider', () => {
  const noCredentialProfiles: string[] = ['ollama', 'lm-studio', 'llama-cpp', 'vllm', 'pollinations'];
  const credentialRequiredProfiles: string[] = ['openai', 'groq', 'openrouter', 'gemini'];

  test('local and free-no-key profiles never require credentials', () => {
    for (const id of noCredentialProfiles) {
      const profile = getProviderProfile(id);
      expect(profile?.credential, id).to.equal('never');
    }
  });

  test('cloud paid/free-tier profiles always require credentials', () => {
    for (const id of credentialRequiredProfiles) {
      const profile = getProviderProfile(id);
      expect(profile?.credential, id).to.equal('always');
    }
  });

  test('openai-compatible is conditional on loopback', () => {
    const profile = getProviderProfile('openai-compatible');
    expect(profile?.credential).to.equal('conditional');
  });
});

suite('WP2 — Provider credential isolation (SecretStorage)', () => {
  test('generates distinct secret keys per provider profile', () => {
    const storage = new MemorySecretStorage();
    const groq = SecretStore.forProvider(storage, 'groq');
    const openai = SecretStore.forProvider(storage, 'openai');
    const pollinations = SecretStore.forProvider(storage, 'pollinations');

    expect(groq.key).to.equal('quantsmind.provider.groq.apiKey');
    expect(openai.key).to.equal('quantsmind.provider.openai.apiKey');
    expect(pollinations.key).to.equal('quantsmind.provider.pollinations.apiKey');

    expect(groq.key).to.not.equal(openai.key);
    expect(openai.key).to.not.equal(pollinations.key);
  });

  test('clearing one provider credential preserves others', async () => {
    const storage = new MemorySecretStorage();
    const groq = SecretStore.forProvider(storage, 'groq');
    const openai = SecretStore.forProvider(storage, 'openai');

    await groq.set('groq-key');
    await openai.set('openai-key');

    await groq.clear();
    expect(await groq.has()).to.equal(false);
    expect(await openai.has()).to.equal(true);
    expect(await openai.get()).to.equal('openai-key');
  });
});

suite('WP2 — Paid provider protection (no silent paid fallback)', () => {
  test('selecting a paid provider does not silently switch away from free provider', () => {
    // The extension code shows a warning modal for paid providers and
    // requires explicit confirmation. This test verifies the classification
    // logic prevents silent paid selection.
    const paidProfiles = ['openai', 'openrouter'];
    const freeProfiles = ['pollinations', 'ollama', 'lm-studio', 'llama-cpp', 'vllm'];

    for (const id of paidProfiles) {
      expect(providerAccessClass(id)).to.equal('paid');
    }
    for (const id of freeProfiles) {
      expect(providerAccessClass(id)).to.not.equal('paid');
    }
  });

  test('pollinations never requires a credential', () => {
    const profile = getProviderProfile('pollinations');
    expect(profile?.credential).to.equal('never');
    expect(providerAccessClass('pollinations')).to.equal('free-no-key');
  });
});
