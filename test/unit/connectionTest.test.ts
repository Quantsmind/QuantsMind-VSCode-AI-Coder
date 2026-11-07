import { expect } from 'chai';
import { testProviderConnection } from '../../src/providers/connectionTest';
import { TestCancellationToken, delay } from './helpers';

const TEST_KEY = 'sk-test-abcdefghijklmnopqrstuvwxyz';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchMock = (
  url: string,
  init?: { method?: string; headers?: unknown; body?: unknown; signal?: AbortSignal },
) => Promise<Response>;

suite('connection testing', () => {
  test('succeeds for a reachable OpenAI-compatible endpoint with auth', async () => {
    const fetchImpl: FetchMock = async (url: string, init?: { method?: string }) => {
      if (init?.method === 'GET') {
        return jsonResponse({ data: [{ id: 'gpt-4o-mini' }] });
      }
      expect(String(url)).to.contain('/chat/completions');
      return jsonResponse({ choices: [{ message: { content: 'Hi' } }] });
    };
    const result = await testProviderConnection({
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: TEST_KEY,
      timeoutMs: 5000,
      fetchImpl: fetchImpl as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(result.code).to.equal('success');
    expect(result.reachable).to.equal(true);
    expect(result.authenticated).to.equal(true);
    expect(result.modelAvailable).to.equal(true);
    expect(result.discoveryAvailable).to.equal(true);
    expect(result.discoveredModels).to.deep.equal(['gpt-4o-mini']);
  });

  test('distinguishes connection success from discovery failure', async () => {
    const fetchImpl: FetchMock = async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'GET') {
        return jsonResponse({}, 404);
      }
      return jsonResponse({ choices: [{ message: { content: 'Hi' } }] });
    };
    const result = await testProviderConnection({
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: TEST_KEY,
      timeoutMs: 5000,
      fetchImpl: fetchImpl as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(result.code).to.equal('success');
    expect(result.reachable).to.equal(true);
    expect(result.modelAvailable).to.equal(true);
    expect(result.discoveryAvailable).to.equal(false);
    expect(result.message).to.contain('Model discovery was unavailable');
  });

  test('reports authentication failure without leaking the key', async () => {
    const fetchImpl: FetchMock = async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'GET') {
        return jsonResponse({}, 404);
      }
      return jsonResponse({ error: { message: `bad ${TEST_KEY}` } }, 401);
    };
    const result = await testProviderConnection({
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: TEST_KEY,
      timeoutMs: 5000,
      fetchImpl: fetchImpl as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(result.code).to.equal('authentication_failed');
    expect(result.reachable).to.equal(true);
    expect(result.authenticated).to.equal(false);
    expect(result.message).to.not.contain(TEST_KEY);
  });

  test('reports missing credential before any HTTP call', async () => {
    let called = false;
    const fetchImpl: FetchMock = async () => {
      called = true;
      return jsonResponse({});
    };
    const result = await testProviderConnection({
      type: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.3-70b-versatile',
      timeoutMs: 5000,
      fetchImpl: fetchImpl as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(result.code).to.equal('authentication_failed');
    expect(called).to.equal(false);
  });

  test('local profiles do not require credentials', async () => {
    const fetchImpl: FetchMock = async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'GET') {
        return jsonResponse({ data: [{ id: 'llama3.1' }] });
      }
      return jsonResponse({ choices: [{ message: { content: 'Hi' } }] });
    };
    const result = await testProviderConnection({
      type: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.1',
      timeoutMs: 5000,
      fetchImpl: fetchImpl as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(result.code).to.equal('success');
    expect(result.authenticated).to.equal(true);
  });

  test('reports network errors as unreachable', async () => {
    const fetchImpl: FetchMock = async () => {
      throw new TypeError('fetch failed');
    };
    const result = await testProviderConnection({
      type: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.1',
      timeoutMs: 5000,
      fetchImpl: fetchImpl as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(result.code).to.equal('network_error');
    expect(result.reachable).to.equal(false);
  });

  test('reports configuration errors for invalid endpoints', async () => {
    const result = await testProviderConnection({
      type: 'openai',
      baseUrl: 'http://example.com/v1',
      model: 'gpt-4o-mini',
      apiKey: TEST_KEY,
      timeoutMs: 5000,
      fetchImpl: (async () => jsonResponse({})) as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(result.code).to.equal('configuration_error');
    expect(result.reachable).to.equal(false);
  });

  test('never sends workspace content', async () => {
    const bodies: string[] = [];
    const fetchImpl: FetchMock = async (_url: string, init?: { method?: string; body?: unknown }) => {
      if (init?.body !== undefined) {
        bodies.push(String(init.body));
      }
      if (init?.method === 'GET') {
        return jsonResponse({ data: [{ id: 'gpt-4o-mini' }] });
      }
      return jsonResponse({ choices: [{ message: { content: 'Hi' } }] });
    };
    await testProviderConnection({
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: TEST_KEY,
      timeoutMs: 5000,
      fetchImpl: fetchImpl as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(bodies.join(' ')).to.contain('Hello');
    expect(bodies.join(' ')).to.not.contain('workspace');
  });

  test('gemini connection test uses the Gemini adapter', async () => {
    const urls: string[] = [];
    const fetchImpl: FetchMock = async (url: string, init?: { method?: string }) => {
      urls.push(url);
      if (urls.length === 1) {
        return jsonResponse({ models: [{ name: 'models/gemini-2.0-flash' }] });
      }
      expect(String(init?.method)).to.equal('POST');
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: 'Hi' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, totalTokenCount: 2 },
        modelVersion: 'models/gemini-2.0-flash',
      });
    };
    const result = await testProviderConnection({
      type: 'gemini',
      model: 'gemini-2.0-flash',
      apiKey: 'AQ-test-key-1234567890',
      timeoutMs: 5000,
      fetchImpl: fetchImpl as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(result.code).to.equal('success');
    expect(result.discoveryAvailable).to.equal(true);
    expect(urls[0]).to.equal('https://generativelanguage.googleapis.com/v1beta/models');
  });

  test('cancellation short-circuits the test', async () => {
    const token = new TestCancellationToken();
    token.cancel();
    const result = await testProviderConnection({
      type: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.1',
      timeoutMs: 5000,
      token,
      fetchImpl: (async () => {
        await delay(10);
        return jsonResponse({ data: [] });
      }) as typeof fetch,
      allowInsecureLocalhost: true,
    });
    expect(result.reachable).to.equal(false);
  });
});
