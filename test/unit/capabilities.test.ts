import { expect } from 'chai';
import {
  describeCapabilities,
  isToolCapableModelId,
  modelSupportsNativeToolCalling,
} from '../../src/providers/capabilities';
import { getProviderCapabilities, listProviderProfiles } from '../../src/providers/profiles';
import { resolveProviderSettings } from '../../src/config/resolve';

const OPENAI_ADAPTER_PROFILES: readonly string[] = [
  'openai-compatible',
  'openai',
  'groq',
  'openrouter',
  'ollama',
  'lm-studio',
  'llama-cpp',
  'vllm',
];

suite('provider capabilities', () => {
  test('openai-compatible adapters implement native tool calling', () => {
    for (const id of OPENAI_ADAPTER_PROFILES) {
      expect(getProviderCapabilities(id)?.toolCalling).to.equal(
        true,
        `${id} adapter should implement native tools`,
      );
    }
  });

  test('advertises native tool calling only for defaults with documented model support', () => {
    const expected: Readonly<Record<string, boolean>> = {
      'openai-compatible': true,
      openai: true,
      groq: true,
      openrouter: true,
      ollama: true,
      'lm-studio': false,
      'llama-cpp': false,
      vllm: false,
    };
    for (const id of OPENAI_ADAPTER_PROFILES) {
      const settings = resolveProviderSettings({ type: id });
      const caps = describeCapabilities(settings);
      expect(caps.nativeToolCalling).to.equal(
        expected[id],
        `${id} with default model "${settings.model}"`,
      );
      expect(caps.structuredOutput).to.equal(true);
      expect(caps.streaming).to.equal(true);
      expect(caps.maxContextChars).to.be.at.least(2_000);
    }
  });

  test('a documented tool model enables native calling on a local profile', () => {
    const settings = resolveProviderSettings({
      type: 'lm-studio',
      model: 'qwen2.5-coder-7b-instruct',
    });
    expect(describeCapabilities(settings).nativeToolCalling).to.equal(true);
  });

  test('model gate rejects placeholder and non-chat ids', () => {
    for (const model of [
      '',
      '   ',
      'local-model',
      'llama',
      'llama3',
      'text-embedding-3-small',
      'whisper-1',
      'tts-1',
      'dall-e-3',
      'omni-moderation-latest',
      'gpt-3.5-turbo-instruct',
      'o1-mini',
      'o1-preview',
      'davinci-002',
      'babbage-002',
      'gemini-2.0-flash',
      'some-unknown-model',
    ]) {
      expect(isToolCapableModelId(model), `"${model}" should not be tool capable`).to.equal(false);
    }
  });

  test('model gate accepts documented tool families across id spellings', () => {
    for (const model of [
      'gpt-4o-mini',
      'gpt-4o-2024-11-20',
      'openai/gpt-4o',
      'models/gpt-4.1',
      'gpt-4-turbo',
      'gpt-3.5-turbo',
      'gpt-5',
      'chatgpt-4o-latest',
      'o3-mini',
      'o4-mini',
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instruct',
      'llama3.1:8b',
      'llama4:scout',
      'qwen2.5-coder:32b',
      'qwen3-32b',
      'mistral-large-latest',
      'mistral-nemo',
      'command-r-plus',
      'GPT-4O-MINI',
    ]) {
      expect(isToolCapableModelId(model), `"${model}" should be tool capable`).to.equal(true);
    }
  });

  test('reports no native tool calling for gemini', () => {
    const settings = resolveProviderSettings({ type: 'gemini' });
    const caps = describeCapabilities(settings);
    expect(caps.nativeToolCalling).to.equal(false);
    expect(caps.structuredOutput).to.equal(true);
    expect(caps.streaming).to.equal(true);
  });

  test('an adapter without native tools stays unsupported for any model id', () => {
    expect(modelSupportsNativeToolCalling('gemini', 'gpt-4o-mini')).to.equal(false);
    expect(modelSupportsNativeToolCalling('unknown-profile', 'gpt-4o-mini')).to.equal(false);
    expect(modelSupportsNativeToolCalling('openai', 'gpt-4o-mini')).to.equal(true);
  });

  test('getProviderCapabilities matches profile toolCalling flags', () => {
    for (const profile of listProviderProfiles()) {
      const caps = getProviderCapabilities(profile.id);
      expect(caps?.toolCalling).to.equal(profile.capabilities.toolCalling);
    }
  });

  test('gemini capabilities are advertised accurately', () => {
    const gemini = getProviderCapabilities('gemini');
    expect(gemini).to.not.equal(undefined);
    expect(gemini?.toolCalling).to.equal(false);
    expect(gemini?.completion).to.equal(true);
    expect(gemini?.streaming).to.equal(true);
    expect(gemini?.modelDiscovery).to.equal(true);
    expect(gemini?.cancellation).to.equal(true);
  });
});