// Gemini provider tests
import { expect } from 'chai';
import {
  createGeminiProvider,
  buildGeminiBody,
  buildGeminiUrl,
  buildGeminiHeaders,
  parseGeminiResponse,
  type GeminiConfig,
} from '../../src/providers/geminiCompatible';
import { ProviderError } from '../../src/providers/errors';
import type { CompletionRequest } from '../../src/providers/types';
import { TestCancellationToken, delay } from './helpers';

const TEST_MODEL = 'gemini-pro';
const TEST_TEMPERATURE = 0.2;
const TEST_MAX_OUTPUT_TOKENS = 16;
const TEST_STREAM = false;
const TEST_KEY = 'AQ.test-api-key-1234567890';

function config(overrides: Partial<GeminiConfig> = {}): GeminiConfig {
  return {
    apiKey: TEST_KEY,
    model: TEST_MODEL,
    timeoutMs: 120000,
    temperature: TEST_TEMPERATURE,
    maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
    stream: TEST_STREAM,
    ...overrides,
  };
}

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    model: TEST_MODEL,
    messages: [{ role: 'user', content: 'Hello' }],
    temperature: 0.2,
    maxOutputTokens: 128,
    stream: false,
    ...overrides,
  };
}

function expectCodes(fn: () => unknown, code: string): void {
  let failure: unknown;
  try {
    fn();
  } catch (error) {
    failure = error;
  }
  expect(failure).to.be.instanceOf(ProviderError);
  expect((failure as ProviderError).code).to.equal(code);
}

function jsonResponse(payload: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function sseResponse(payloads: readonly unknown[]): Response {
  const encoder = new TextEncoder();
  const body = payloads.map((payload) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`).join('');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

type FetchMock = (url: string, init?: { signal?: AbortSignal; headers?: unknown; body?: unknown }) => Promise<Response>;

function neverResolvingFetch(_url: string, init?: { signal?: AbortSignal }): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (init?.signal?.aborted) {
      abort();
      return;
    }
    init?.signal?.addEventListener('abort', abort, { once: true });
  });
}

suite('Gemini provider configuration', () => {
  test('accepts valid configuration and exposes its identity', () => {
    const provider = createGeminiProvider(config());
    expect(provider.id).to.equal('gemini');
    expect(provider.displayName).to.equal('Google Gemini');
  });

  test('validates model name when empty', () => {
    expectCodes(() => createGeminiProvider(config({ model: '' })), 'configuration');
  });

  test('validates model name length', () => {
    expectCodes(() => createGeminiProvider(config({ model: 'a'.repeat(201) })), 'configuration');
  });

  test('validates model name with control characters', () => {
    expectCodes(() => createGeminiProvider(config({ model: 'bad\nmodel' })), 'configuration');
  });

  test('validates temperature out of range', () => {
    expectCodes(() => createGeminiProvider(config({ temperature: 3 })), 'configuration');
  });

  test('validates maxOutputTokens too high', () => {
    expectCodes(() => createGeminiProvider(config({ maxOutputTokens: 200_000 })), 'configuration');
  });

  test('validates maxOutputTokens non-integer', () => {
    expectCodes(() => createGeminiProvider(config({ maxOutputTokens: 2.5 })), 'configuration');
  });

  test('validates timeoutMs out of range', () => {
    expectCodes(() => createGeminiProvider(config({ timeoutMs: 500 })), 'configuration');
  });

  test('accepts missing timeoutMs with default and validates stream flag', () => {
    const { timeoutMs: _timeoutMs, ...rest } = config() as GeminiConfig & { timeoutMs?: number };
    void _timeoutMs;
    const provider = createGeminiProvider(rest as GeminiConfig);
    expect(provider.id).to.equal('gemini');
  });
});

suite('Gemini credential handling', () => {
  test('accepts API key', () => {
    const provider = createGeminiProvider(config({ apiKey: TEST_KEY }));
    expect(provider.id).to.equal('gemini');
  });

  test('treats empty API key as absent and fails complete as authentication', async () => {
    const provider = createGeminiProvider(config({ apiKey: '' }));
    let failure: unknown;
    try {
      await provider.complete(request());
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(ProviderError);
    expect((failure as ProviderError).code).to.equal('authentication');
  });

  test('rejects whitespace API key', () => {
    expect(() => createGeminiProvider(config({ apiKey: 'key with spaces' }))).to.throw(/API key must not contain whitespace/);
  });

  test('fails complete without API key as authentication', async () => {
    const provider = createGeminiProvider(config({ apiKey: undefined }));
    let failure: unknown;
    try {
      await provider.complete(request());
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(ProviderError);
    expect((failure as ProviderError).code).to.equal('authentication');
  });

  test('does not leak API key in error messages', async () => {
    const fetchImpl: FetchMock = async () => jsonResponse({ error: { message: `bad ${TEST_KEY}` } }, 401);
    const provider = createGeminiProvider(config(), { fetchImpl: fetchImpl as typeof fetch });
    let failure: unknown;
    try {
      await provider.complete(request());
    } catch (error) {
      failure = error;
    }
    expect((failure as ProviderError).message).to.not.contain(TEST_KEY);
  });
});

suite('Gemini request construction', () => {
  test('builds generateContent URL for non-streaming', () => {
    expect(buildGeminiUrl('gemini-pro', false)).to.equal(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
    );
  });

  test('builds streamGenerateContent URL with SSE alt for streaming', () => {
    expect(buildGeminiUrl('gemini-pro', true)).to.equal(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent?alt=sse',
    );
  });

  test('strips models/ prefix and encodes model name', () => {
    expect(buildGeminiUrl('models/gemini-2.0-flash', false)).to.equal(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    );
  });

  test('builds body with system instruction and role mapping', () => {
    const body = buildGeminiBody(
      {
        model: 'm',
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello' },
        ],
        stream: false,
        temperature: 0.5,
        maxOutputTokens: 32,
      },
      { temperature: 0.2, maxOutputTokens: 16 },
    );
    expect(body).to.deep.equal({
      contents: [
        { role: 'user', parts: [{ text: 'Hi' }] },
        { role: 'model', parts: [{ text: 'Hello' }] },
      ],
      systemInstruction: { parts: [{ text: 'You are helpful' }] },
      generationConfig: { temperature: 0.5, maxOutputTokens: 32 },
    });
  });

  test('uses config defaults for generationConfig when request omits them', () => {
    const body = buildGeminiBody(
      { model: 'm', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      { temperature: 0.7, maxOutputTokens: 64 },
    );
    expect((body.generationConfig as Record<string, unknown>).temperature).to.equal(0.7);
    expect((body.generationConfig as Record<string, unknown>).maxOutputTokens).to.equal(64);
  });

  test('maps system-only messages to user contents', () => {
    const body = buildGeminiBody(
      { model: 'm', messages: [{ role: 'system', content: 'Only system' }], stream: false },
      { temperature: 0.2, maxOutputTokens: 16 },
    );
    expect(body.contents).to.deep.equal([{ role: 'user', parts: [{ text: 'Only system' }] }]);
    expect(body.systemInstruction).to.equal(undefined);
  });

  test('builds headers with x-goog-api-key and user agent', () => {
    const headers = buildGeminiHeaders(TEST_KEY, true);
    expect(headers['x-goog-api-key']).to.equal(TEST_KEY);
    expect(headers['User-Agent']).to.be.a('string');
    expect(headers.Accept).to.equal('text/event-stream');
    expect(headers.Authorization).to.equal(undefined);
  });

  test('sends well-formed request and parses candidates', async () => {
    const calls: Array<{ url: string; init?: { headers?: unknown; body?: unknown } }> = [];
    const fetchImpl: FetchMock = async (url: string, init?: { headers?: unknown; body?: unknown }) => {
      calls.push({ url, init });
      return jsonResponse({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Hello' }, { text: ' world' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
        modelVersion: 'models/gemini-pro',
      });
    };
    const provider = createGeminiProvider(config(), { fetchImpl: fetchImpl as typeof fetch });
    const result = await provider.complete(request());
    expect(result.text).to.equal('Hello world');
    expect(result.model).to.equal('models/gemini-pro');
    expect(result.finishReason).to.equal('STOP');
    expect(result.usage).to.deep.equal({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    expect(calls).to.have.length(1);
    expect(calls[0].url).to.equal('https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent');
    const sentBody = JSON.parse(calls[0].init?.body as string) as Record<string, unknown>;
    expect(sentBody.contents).to.deep.equal([{ role: 'user', parts: [{ text: 'Hello' }] }]);
    expect(sentBody.generationConfig).to.deep.equal({ temperature: 0.2, maxOutputTokens: 128 });
    const sentHeaders = calls[0].init?.headers as Record<string, string>;
    expect(sentHeaders['x-goog-api-key']).to.equal(TEST_KEY);
  });

  test('parses JSON response even when streaming enabled with JSON content type', async () => {
    const fetchImpl: FetchMock = async () =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'json' }] } }] });
    const provider = createGeminiProvider(config({ stream: true }), { fetchImpl: fetchImpl as typeof fetch });
    const result = await provider.complete(request({ stream: true }));
    expect(result.text).to.equal('json');
  });
});

suite('Gemini streaming responses', () => {
  test('aggregates deltas, invokes callback, and parses usage', async () => {
    const fetchImpl: FetchMock = async () =>
      sseResponse([
        { candidates: [{ content: { parts: [{ text: 'Hel' }] } }], modelVersion: 'models/gemini-pro' },
        {
          candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
        },
      ]);
    const provider = createGeminiProvider(config({ stream: true }), { fetchImpl: fetchImpl as typeof fetch });
    const deltas: string[] = [];
    const result = await provider.complete(request({ stream: true }), { onDelta: (delta) => deltas.push(delta) });
    expect(result.text).to.equal('Hello');
    expect(deltas).to.deep.equal(['Hel', 'lo']);
    expect(result.finishReason).to.equal('STOP');
    expect(result.usage).to.deep.equal({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
  });

  test('rejects empty streaming response', async () => {
    const fetchImpl: FetchMock = async () => sseResponse([]);
    const provider = createGeminiProvider(config({ stream: true }), { fetchImpl: fetchImpl as typeof fetch });
    let failure: unknown;
    try {
      await provider.complete(request({ stream: true }));
    } catch (error) {
      failure = error;
    }
    expect((failure as ProviderError).code).to.equal('invalid_response');
  });

  test('rejects malformed stream data', async () => {
    const fetchImpl: FetchMock = async () => sseResponse(['not-json']);
    const provider = createGeminiProvider(config({ stream: true }), { fetchImpl: fetchImpl as typeof fetch });
    let failure: unknown;
    try {
      await provider.complete(request({ stream: true }));
    } catch (error) {
      failure = error;
    }
    expect((failure as ProviderError).code).to.equal('invalid_response');
  });
});

suite('Gemini provider error handling', () => {
  const cases: Array<{ status: number; code: string }> = [
    { status: 400, code: 'http' },
    { status: 401, code: 'authentication' },
    { status: 429, code: 'rate_limit' },
    { status: 500, code: 'server' },
  ];
  for (const { status, code } of cases) {
    test(`normalizes HTTP ${status} to ${code}`, async () => {
      const fetchImpl: FetchMock = async () =>
        jsonResponse({ error: { message: `failure ${TEST_KEY}` } }, status);
      const provider = createGeminiProvider(config(), { fetchImpl: fetchImpl as typeof fetch });
      let failure: unknown;
      try {
        await provider.complete(request());
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(ProviderError);
      expect((failure as ProviderError).status).to.equal(status);
      expect((failure as ProviderError).code).to.equal(code);
      expect((failure as ProviderError).message).to.not.contain(TEST_KEY);
    });
  }

  test('rejects invalid JSON responses', async () => {
    const fetchImpl: FetchMock = async () => jsonResponse('{not json', 200);
    const provider = createGeminiProvider(config(), { fetchImpl: fetchImpl as typeof fetch });
    let failure: unknown;
    try {
      await provider.complete(request());
    } catch (error) {
      failure = error;
    }
    expect((failure as ProviderError).code).to.equal('invalid_response');
  });

  test('rejects empty candidates', async () => {
    const fetchImpl: FetchMock = async () => jsonResponse({ candidates: [] });
    const provider = createGeminiProvider(config(), { fetchImpl: fetchImpl as typeof fetch });
    let failure: unknown;
    try {
      await provider.complete(request());
    } catch (error) {
      failure = error;
    }
    expect((failure as ProviderError).code).to.equal('invalid_response');
  });

  test('rejects responses without text parts', async () => {
    const fetchImpl: FetchMock = async () =>
      jsonResponse({ candidates: [{ content: { parts: [] } }] });
    const provider = createGeminiProvider(config(), { fetchImpl: fetchImpl as typeof fetch });
    let failure: unknown;
    try {
      await provider.complete(request());
    } catch (error) {
      failure = error;
    }
    expect((failure as ProviderError).code).to.equal('invalid_response');
  });

  test('rejects blocked prompt feedback', async () => {
    const fetchImpl: FetchMock = async () =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'hi' }] } }], promptFeedback: { blockReason: 'SAFETY' } });
    const provider = createGeminiProvider(config(), { fetchImpl: fetchImpl as typeof fetch });
    let failure: unknown;
    try {
      await provider.complete(request());
    } catch (error) {
      failure = error;
    }
    expect((failure as ProviderError).code).to.equal('invalid_response');
  });

  test('surfaces provider error payloads without leaking key', async () => {
    const fetchImpl: FetchMock = async () =>
      jsonResponse({ error: { message: `bad ${TEST_KEY}` } }, 200);
    const provider = createGeminiProvider(config(), { fetchImpl: fetchImpl as typeof fetch });
    let failure: unknown;
    try {
      await provider.complete(request());
    } catch (error) {
      failure = error;
    }
    expect((failure as ProviderError).code).to.equal('invalid_response');
    expect((failure as ProviderError).message).to.not.contain(TEST_KEY);
  });

  test('parses gemini response directly via exported helper', () => {
    const result = parseGeminiResponse({
      candidates: [{ content: { parts: [{ text: 'direct' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, totalTokenCount: 2 },
      modelVersion: 'models/gemini-pro',
    });
    expect(result.text).to.equal('direct');
    expect(result.usage?.promptTokens).to.equal(1);
  });
});

suite('Gemini provider cancellation and timeout', () => {
  test('does not send a request when token already cancelled', async () => {
    let called = false;
    const fetchImpl: FetchMock = async () => {
      called = true;
      return jsonResponse({});
    };
    const provider = createGeminiProvider(config(), { fetchImpl: fetchImpl as typeof fetch });
    const token = new TestCancellationToken();
    token.cancel();
    let failure: unknown;
    try {
      await provider.complete(request(), { token });
    } catch (error) {
      failure = error;
    }
    expect((failure as ProviderError).code).to.equal('cancelled');
    expect(called).to.equal(false);
  });

  test('cancels an in-flight request', async () => {
    const provider = createGeminiProvider(config(), { fetchImpl: neverResolvingFetch as typeof fetch });
    const token = new TestCancellationToken();
    const pending = provider.complete(request(), { token, timeoutMs: 5000 });
    await delay(20);
    token.cancel();
    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }
    expect((failure as ProviderError).code).to.equal('cancelled');
  });

  test('times out a request that never responds', async () => {
    const provider = createGeminiProvider(config(), { fetchImpl: neverResolvingFetch as typeof fetch });
    let failure: unknown;
    try {
      await provider.complete(request(), { timeoutMs: 50 });
    } catch (error) {
      failure = error;
    }
    expect((failure as ProviderError).code).to.equal('timeout');
  });

  test('rejects invalid request payloads before sending', async () => {
    let called = false;
    const fetchImpl: FetchMock = async () => {
      called = true;
      return jsonResponse({});
    };
    const provider = createGeminiProvider(config(), { fetchImpl: fetchImpl as typeof fetch });
    let failure: unknown;
    try {
      await provider.complete({ model: '', messages: [], stream: false } as CompletionRequest);
    } catch (error) {
      failure = error;
    }
    expect((failure as ProviderError).code).to.equal('configuration');
    expect(called).to.equal(false);
  });
});
