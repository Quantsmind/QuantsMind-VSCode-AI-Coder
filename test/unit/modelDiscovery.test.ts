import { expect } from 'chai';
import { listProviderModels } from '../../src/providers/modelDiscovery';

const TEST_KEY = 'sk-test-abcdefghijklmnopqrstuvwxyz';

function jsonResponse(payload: unknown, status = 200): Response {
  const body = JSON.stringify(payload);
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

type FetchMock = (
  url: string,
  init?: { method?: string; headers?: unknown; signal?: AbortSignal },
) => Promise<Response>;

suite('model discovery', () => {
  test('discovers OpenAI-compatible models from GET /models', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchMock = async (url: string) => {
      calls.push(url);
      return jsonResponse({
        data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
      });
    };
    const result = await listProviderModels({
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: TEST_KEY,
      timeoutMs: 5000,
      fetchImpl: fetchImpl as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(result.status).to.equal('available');
    expect(result.source).to.equal('discovered');
    expect(result.models).to.deep.equal(['gpt-4o-mini', 'gpt-4o']);
    expect(calls[0]).to.equal('https://api.openai.com/v1/models');
  });

  test('sends Bearer auth when a key is present', async () => {
    let seenAuth: string | undefined;
    const fetchImpl: FetchMock = async (_url: string, init?: { headers?: unknown }) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seenAuth = headers?.Authorization;
      return jsonResponse({ data: [{ id: 'llama-3.3-70b-versatile' }] });
    };
    const result = await listProviderModels({
      type: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: TEST_KEY,
      timeoutMs: 5000,
      fetchImpl: fetchImpl as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(result.status).to.equal('available');
    expect(seenAuth).to.equal(`Bearer ${TEST_KEY}`);
  });

  test('discovers local models without credentials', async () => {
    const fetchImpl: FetchMock = async () => jsonResponse({ data: [{ id: 'llama3.1' }] });
    const result = await listProviderModels({
      type: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      timeoutMs: 5000,
      fetchImpl: fetchImpl as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(result.status).to.equal('available');
    expect(result.models).to.deep.equal(['llama3.1']);
  });

  test('discovers Gemini models from the Gemini endpoint', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchMock = async (url: string, init?: { headers?: unknown }) => {
      calls.push(url);
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.['x-goog-api-key']).to.equal(TEST_KEY);
      return jsonResponse({
        models: [{ name: 'models/gemini-2.0-flash' }, { name: 'models/gemini-1.5-pro' }],
      });
    };
    const result = await listProviderModels({
      type: 'gemini',
      apiKey: TEST_KEY,
      timeoutMs: 5000,
      fetchImpl: fetchImpl as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(result.status).to.equal('available');
    expect(result.models).to.deep.equal(['gemini-2.0-flash', 'gemini-1.5-pro']);
    expect(calls[0]).to.equal('https://generativelanguage.googleapis.com/v1beta/models');
  });

  test('reports authentication failure without throwing', async () => {
    const fetchImpl: FetchMock = async () =>
      jsonResponse({ error: { message: 'invalid api key' } }, 401);
    const result = await listProviderModels({
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: TEST_KEY,
      timeoutMs: 5000,
      fetchImpl: fetchImpl as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(result.status).to.equal('auth_failed');
    expect(result.source).to.equal('manual');
    expect(result.models).to.deep.equal([]);
    expect(result.message).to.not.contain(TEST_KEY);
  });

  test('reports unsupported for 404 and unavailable for 500', async () => {
    const notFound = await listProviderModels({
      type: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      timeoutMs: 5000,
      fetchImpl: (async () => jsonResponse({}, 404)) as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(notFound.status).to.equal('unsupported');

    const serverError = await listProviderModels({
      type: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: TEST_KEY,
      timeoutMs: 5000,
      fetchImpl: (async () => jsonResponse({ error: { message: 'oops' } }, 500)) as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(serverError.status).to.equal('unavailable');
  });

  test('reports unavailable for malformed JSON and empty lists', async () => {
    const malformed = await listProviderModels({
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: TEST_KEY,
      timeoutMs: 5000,
      fetchImpl: (async () => jsonResponse('{not json', 200)) as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(malformed.status).to.equal('unavailable');

    const empty = await listProviderModels({
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: TEST_KEY,
      timeoutMs: 5000,
      fetchImpl: (async () => jsonResponse({ data: [] })) as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(empty.status).to.equal('unavailable');
    expect(empty.source).to.equal('manual');
  });

  test('reports network_error when fetch rejects', async () => {
    const result = await listProviderModels({
      type: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      timeoutMs: 5000,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(result.status).to.equal('network_error');
    expect(result.source).to.equal('manual');
  });

  test('reports unsupported for unknown provider types', async () => {
    const result = await listProviderModels({
      type: 'unknown-provider',
      timeoutMs: 5000,
      fetchImpl: (async () => jsonResponse({})) as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(result.status).to.equal('unsupported');
  });

  test('reports configuration_error for invalid endpoints', async () => {
    const result = await listProviderModels({
      type: 'openai',
      baseUrl: 'http://example.com/v1',
      apiKey: TEST_KEY,
      timeoutMs: 5000,
      fetchImpl: (async () => jsonResponse({ data: [] })) as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(result.status).to.equal('configuration_error');
  });
});
