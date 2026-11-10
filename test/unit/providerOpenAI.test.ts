// Provider OpenAI compatibility tests
import { expect } from 'chai';
import {
  createOpenAiCompatibleProvider,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  type OpenAiCompatibleConfig,
} from '../../src/providers/openaiCompatible';

const TEST_MODEL = 'gpt-4o-mini';
const TEST_BASE_URL = 'https://api.openai.com/v1';
const TEST_TIMEOUT_MS = 120000;
const TEST_TEMPERATURE = 0.2;
const TEST_MAX_OUTPUT_TOKENS = 16;
const TEST_STREAM = false;
const TEST_ALLOW_INSECURE = true;

function config(overrides: Partial<OpenAiCompatibleConfig> = {}): OpenAiCompatibleConfig {
  return {
    model: TEST_MODEL,
    baseUrl: TEST_BASE_URL,
    timeoutMs: TEST_TIMEOUT_MS,
    temperature: TEST_TEMPERATURE,
    maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
    stream: TEST_STREAM,
    allowInsecureLocalhost: TEST_ALLOW_INSECURE,
    ...overrides,
  };
}

suite('OpenAI-compatible Provider configuration', () => {
  test('validates model name when empty', () => {
    expect(() => {
      createOpenAiCompatibleProvider(config({ model: '' }));
    }).to.throw(/model name is not configured/);
  });

  test('validates model name length', () => {
    expect(() => {
      createOpenAiCompatibleProvider(config({ model: 'a'.repeat(201) }));
    }).to.throw(/model name is invalid/);
  });

  test('validates timeoutMs too low', () => {
    expect(() => {
      createOpenAiCompatibleProvider(config({ timeoutMs: 500 }));
    }).to.throw(/timeout must be between 1000 and 600000/);
  });

  test('validates temperature out of range', () => {
    expect(() => {
      createOpenAiCompatibleProvider(config({ temperature: 3 }));
    }).to.throw(/temperature must be between 0 and 2/);
  });

  test('validates maxOutputTokens too high', () => {
    expect(() => {
      createOpenAiCompatibleProvider(config({ maxOutputTokens: 200_000 }));
    }).to.throw(/maximum output token count/);
  });
});

suite('OpenAI-compatible Provider credential handling', () => {
  test('accepts valid API key', () => {
    const provider = createOpenAiCompatibleProvider(config({ apiKey: 'sk-test-key' }));
    expect(provider.id).to.equal(OPENAI_COMPATIBLE_PROVIDER_ID);
  });

  test('treats empty API key as absent', () => {
    const provider = createOpenAiCompatibleProvider(config({ apiKey: '' }));
    expect(provider.id).to.equal(OPENAI_COMPATIBLE_PROVIDER_ID);
  });

  test('rejects API key with whitespace', () => {
    expect(() => {
      createOpenAiCompatibleProvider(config({ apiKey: 'key with spaces' }));
    }).to.throw(/API key must not contain whitespace/);
  });
});

suite('OpenAI-compatible Provider identity', () => {
  test('has correct provider ID', () => {
    const provider = createOpenAiCompatibleProvider(config());
    expect(provider.id).to.equal(OPENAI_COMPATIBLE_PROVIDER_ID);
  });

  test('has correct display name', () => {
    const provider = createOpenAiCompatibleProvider(config());
    expect(provider.displayName).to.equal('OpenAI-compatible');
  });
});
