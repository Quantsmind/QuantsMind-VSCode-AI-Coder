// Local endpoint tests - no API key required
import { expect } from 'chai';
import {
  createOpenAiCompatibleProvider,
  type OpenAiCompatibleConfig,
} from '../../src/providers/openaiCompatible';

const TEST_MODEL = 'llama2';
const TEST_BASE_URL = 'http://localhost:11434';
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

suite('Local Provider (no API key)', () => {
  suite('local endpoint compatibility', () => {
    test('Ollama-compatible endpoint', () => {
      const provider = createOpenAiCompatibleProvider(config());
      expect(provider.id).to.equal('openai-compatible');
    });

    test('LM Studio OpenAI-compatible endpoint', () => {
      const provider = createOpenAiCompatibleProvider(
        config({ model: 'mistral', baseUrl: 'http://localhost:1234' }),
      );
      expect(provider.id).to.equal('openai-compatible');
    });

    test('llama.cpp OpenAI-compatible endpoint', () => {
      const provider = createOpenAiCompatibleProvider(
        config({ model: '7b-q4_0', baseUrl: 'http://localhost:8080' }),
      );
      expect(provider.id).to.equal('openai-compatible');
    });

    test('vLLM OpenAI-compatible endpoint', () => {
      const provider = createOpenAiCompatibleProvider(
        config({ model: 'llama3', baseUrl: 'http://localhost:8000' }),
      );
      expect(provider.id).to.equal('openai-compatible');
    });
  });

  suite('request validation', () => {
    test('validates model name when empty', () => {
      expect(() => {
        createOpenAiCompatibleProvider(config({ model: '' }));
      }).to.throw(/model name is not configured/);
    });

    test('validates missing messages on complete', async () => {
      const provider = createOpenAiCompatibleProvider(config({ model: 'test', baseUrl: 'http://localhost:1234' }));
      let failure: unknown;
      try {
        await provider.complete({ model: 'test', messages: [], stream: false });
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(Error);
      expect((failure as Error).message).to.contain('At least one chat message');
    });
  });
});
