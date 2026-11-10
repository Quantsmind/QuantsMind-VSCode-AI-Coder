import { expect } from 'chai';
import {
  getProviderProfile,
  listProviderProfileIds,
  listProviderProfiles,
  getProviderCapabilities,
  getProviderCapabilityReport,
  credentialRequiredForProfile,
  isLocalProviderProfile,
  providerAdapterForType,
  type ProviderAccessClass,
} from '../../src/providers/profiles';
import { createProvider, listProviderTypes, providerDisplayName } from '../../src/providers/registry';
import { resolveProviderSettings } from '../../src/config/resolve';
import type { OpenAiCompatibleConfig } from '../../src/providers/openaiCompatible';

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

suite('provider profile registration', () => {
  test('lists all ten provider profiles (nine built-in + Pollinations)', () => {
    const ids = listProviderProfileIds();
    expect(ids).to.deep.equal([
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
    ]);
  });

  test('registry exposes the same profiles as provider types', () => {
    expect(listProviderTypes()).to.deep.equal([...listProviderProfileIds()]);
  });

  test('local profiles reuse the openai-compatible adapter', () => {
    for (const id of ['ollama', 'lm-studio', 'llama-cpp', 'vllm']) {
      expect(providerAdapterForType(id)).to.equal('openai-compatible');
      const profile = getProviderProfile(id);
      expect(profile?.adapter).to.equal('openai-compatible');
      expect(profile?.local).to.equal(true);
      const provider = createProvider(id, config());
      expect(provider.id).to.equal('openai-compatible');
    }
  });

  test('cloud profiles reuse the openai-compatible adapter', () => {
    for (const id of ['openai', 'groq', 'openrouter']) {
      expect(providerAdapterForType(id)).to.equal('openai-compatible');
      const provider = createProvider(id, config());
      expect(provider.id).to.equal('openai-compatible');
      expect(provider.displayName).to.equal('OpenAI-compatible');
    }
  });

  test('gemini retains its dedicated adapter', () => {
    expect(providerAdapterForType('gemini')).to.equal('gemini');
    const provider = createProvider('gemini', config());
    expect(provider.id).to.equal('gemini');
  });

  test('providerDisplayName resolves profiles and unknowns', () => {
    expect(providerDisplayName('ollama')).to.equal('Ollama (local)');
    expect(providerDisplayName('openai')).to.equal('OpenAI');
    expect(providerDisplayName('groq')).to.equal('Groq');
    expect(providerDisplayName('unknown-provider')).to.equal(undefined);
    expect(getProviderProfile('unknown-provider')).to.equal(undefined);
  });

  test('endpoint defaults are verified per profile', () => {
    expect(getProviderProfile('ollama')?.defaultBaseUrl).to.equal('http://localhost:11434/v1');
    expect(getProviderProfile('lm-studio')?.defaultBaseUrl).to.equal('http://localhost:1234/v1');
    expect(getProviderProfile('llama-cpp')?.defaultBaseUrl).to.equal('http://localhost:8080/v1');
    expect(getProviderProfile('vllm')?.defaultBaseUrl).to.equal('http://localhost:8000/v1');
    expect(getProviderProfile('openai')?.defaultBaseUrl).to.equal('https://api.openai.com/v1');
    expect(getProviderProfile('groq')?.defaultBaseUrl).to.equal('https://api.groq.com/openai/v1');
    expect(getProviderProfile('openrouter')?.defaultBaseUrl).to.equal('https://openrouter.ai/api/v1');
    expect(getProviderProfile('gemini')?.defaultBaseUrl).to.equal(undefined);
  });

  test('users can override endpoint defaults', () => {
    // An explicit non-default baseUrl is preserved by the resolver.
    const resolved = resolveProviderSettings({
      type: 'ollama',
      baseUrl: 'http://192.168.1.50:9999/v1',
      model: 'custom-model',
    });
    expect(resolved.baseUrl).to.equal('http://192.168.1.50:9999/v1');
    expect(resolved.model).to.equal('custom-model');
  });

  test('switching profiles applies endpoint and model defaults', () => {
    const ollama = resolveProviderSettings({ type: 'ollama' });
    expect(ollama.baseUrl).to.equal('http://localhost:11434/v1');
    expect(ollama.model).to.equal('llama3.1');

    const groq = resolveProviderSettings({ type: 'groq' });
    expect(groq.baseUrl).to.equal('https://api.groq.com/openai/v1');

    const gemini = resolveProviderSettings({ type: 'gemini' });
    expect(gemini.model).to.equal('gemini-2.0-flash');
  });

  test('capabilities are reported independently per profile', () => {
    const ollama = getProviderCapabilities('ollama');
    expect(ollama?.completion).to.equal(true);
    expect(ollama?.streaming).to.equal(true);
    expect(ollama?.modelDiscovery).to.equal(true);
    expect(ollama?.cancellation).to.equal(true);
    expect(ollama?.toolCalling).to.equal(true);

    const gemini = getProviderCapabilities('gemini');
    expect(gemini?.completion).to.equal(true);
    expect(gemini?.modelDiscovery).to.equal(true);
    expect(gemini?.toolCalling).to.equal(false);
    expect(gemini?.limitations).to.be.an('array');
    expect(gemini?.limitations.length).to.be.greaterThan(0);

    // OpenAI-compatible profiles advertise tool calling; Gemini does not.
    for (const profile of listProviderProfiles()) {
      if (profile.id === 'gemini') {
        expect(profile.capabilities.toolCalling).to.equal(false);
      } else {
        expect(profile.capabilities.toolCalling).to.equal(true);
      }
    }
  });

  test('capability report is a typed summary', () => {
    const report = getProviderCapabilityReport('openai');
    expect(report?.profileId).to.equal('openai');
    expect(report?.adapter).to.equal('openai-compatible');
    expect(report?.capabilities.completion).to.equal(true);
    expect(report?.defaultBaseUrl).to.equal('https://api.openai.com/v1');
    expect(getProviderCapabilityReport('unknown')).to.equal(undefined);
  });

  test('credential requirements follow profile policy', () => {
    expect(credentialRequiredForProfile('ollama', false)).to.equal(false);
    expect(credentialRequiredForProfile('lm-studio', false)).to.equal(false);
    expect(credentialRequiredForProfile('openai', false)).to.equal(true);
    expect(credentialRequiredForProfile('groq', false)).to.equal(true);
    expect(credentialRequiredForProfile('openrouter', false)).to.equal(true);
    expect(credentialRequiredForProfile('gemini', true)).to.equal(true);
    expect(credentialRequiredForProfile('openai-compatible', true)).to.equal(false);
    expect(credentialRequiredForProfile('openai-compatible', false)).to.equal(true);
    expect(isLocalProviderProfile('vllm')).to.equal(true);
    expect(isLocalProviderProfile('openai')).to.equal(false);
  });

  suite('Pollinations free preset', () => {
    test('pollinations is registered as free-no-key with no credential required', () => {
      const profile = getProviderProfile('pollinations');
      expect(profile).to.not.equal(undefined);
      expect(profile?.id).to.equal('pollinations');
      expect(profile?.displayName).to.equal('Pollinations');
      expect(profile?.adapter).to.equal('openai-compatible');
      expect(profile?.defaultBaseUrl).to.equal('https://text.pollinations.ai/openai');
      expect(profile?.defaultModel).to.equal('openai-fast');
      expect(profile?.credential).to.equal('never');
      expect(profile?.local).to.equal(false);
      expect(profile?.access).to.equal('free-no-key');
      expect(profile?.pricing.access).to.equal('free-no-key');
      expect(profile?.pricing.pricingSource).to.contain('pollinations');
      expect(profile?.pricing.anonymousNote).to.contain('can change without notice');
      expect(profile?.pricing.endpointEditable).to.equal(true);
    });

    test('pollinations never requires a credential', () => {
      expect(credentialRequiredForProfile('pollinations', false)).to.equal(false);
      expect(credentialRequiredForProfile('pollinations', true)).to.equal(false);
    });
  });

  suite('access classification', () => {
    test('reports access class for every profile', () => {
      const expected: Record<string, ProviderAccessClass> = {
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
      for (const [id, expectedAccess] of Object.entries(expected)) {
        const profile = getProviderProfile(id);
        expect(profile?.access, id).to.equal(expectedAccess);
        expect(profile?.pricing.access, id).to.equal(expectedAccess);
      }
    });

    test('local profiles are never paid', () => {
      for (const id of ['ollama', 'lm-studio', 'llama-cpp', 'vllm']) {
        expect(getProviderProfile(id)?.access).to.equal('local');
        expect(isLocalProviderProfile(id)).to.equal(true);
      }
    });

    test('pricing source is never empty', () => {
      for (const profile of listProviderProfiles()) {
        expect(profile.pricing.pricingSource.length).to.be.greaterThan(0);
        expect(profile.pricing.verifiedAt.length).to.be.greaterThan(0);
      }
    });
  });
});
