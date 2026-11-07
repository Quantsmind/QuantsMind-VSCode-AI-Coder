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
  test('lists all nine provider profiles', () => {
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
    expect(ollama?.toolCalling).to.equal(false);

    const gemini = getProviderCapabilities('gemini');
    expect(gemini?.completion).to.equal(true);
    expect(gemini?.modelDiscovery).to.equal(true);
    expect(gemini?.toolCalling).to.equal(false);
    expect(gemini?.limitations).to.be.an('array');
    expect(gemini?.limitations.length).to.be.greaterThan(0);

    // No profile advertises tool calling (adapter rejects tool-call responses).
    for (const profile of listProviderProfiles()) {
      expect(profile.capabilities.toolCalling).to.equal(false);
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
});
