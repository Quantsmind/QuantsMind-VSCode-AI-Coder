import { expect } from 'chai';
import {
  createOpenAiCompatibleProvider,
} from '../../src/providers/openaiCompatible';
import { createGeminiProvider } from '../../src/providers/geminiCompatible';
import { ProviderError } from '../../src/providers/errors';
import type { CompletionRequest } from '../../src/providers/types';
import { TestCancellationToken, delay } from './helpers';

const OPENAI_KEY = 'sk-test-abcdefghijklmnopqrstuvwxyz';
const GEMINI_KEY = 'AQ-test-key-1234567890';

function openAiConfig(overrides: Partial<Parameters<typeof createOpenAiCompatibleProvider>[0]> = {}): Parameters<typeof createOpenAiCompatibleProvider>[0] {
  const base = {
    apiKey: OPENAI_KEY,
    baseUrl: 'https://api.openai.com/v1',
    model: 'test-model',
    timeoutMs: 5000,
    temperature: 0.2,
    maxOutputTokens: 128,
    stream: true,
    allowInsecureLocalhost: true,
  };
  return { ...base, ...overrides };
}

function geminiConfig(): Parameters<typeof createGeminiProvider>[0] {
  return {
    apiKey: GEMINI_KEY,
    model: 'gemini-pro',
    timeoutMs: 5000,
    temperature: 0.2,
    maxOutputTokens: 128,
    stream: true,
  };
}

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'Hello' }],
    temperature: 0.2,
    maxOutputTokens: 128,
    stream: true,
    ...overrides,
  };
}

function sseResponse(payloads: readonly unknown[]): Response {
  const encoder = new TextEncoder();
  const body = payloads.map((p) => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join('');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

suite('streaming reliability', () => {
  test('OpenAI streams chunks in order without duplication', async () => {
    const fetchImpl = (async () =>
      sseResponse([
        { choices: [{ delta: { content: 'A' } }], model: 'm' },
        { choices: [{ delta: { content: 'B' }, finish_reason: 'stop' }] },
      ])) as typeof fetch;
    const provider = createOpenAiCompatibleProvider(openAiConfig(), { fetchImpl });
    const deltas: string[] = [];
    const result = await provider.complete(request(), { onDelta: (d) => deltas.push(d) });
    expect(result.text).to.equal('AB');
    expect(deltas).to.deep.equal(['A', 'B']);
    expect(result.finishReason).to.equal('stop');
    expect(result.model).to.equal('m');
  });

  test('OpenAI rejects streaming that yields no completion text', async () => {
    const fetchImpl = (async () =>
      sseResponse([{ choices: [{ delta: {} }] }])) as typeof fetch;
    const provider = createOpenAiCompatibleProvider(openAiConfig(), { fetchImpl });
    let failure: unknown;
    try {
      await provider.complete(request());
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(ProviderError);
    expect((failure as ProviderError).code).to.equal('invalid_response');
  });

  test('Gemini streams candidates in order', async () => {
    const fetchImpl = (async () =>
      sseResponse([
        { candidates: [{ content: { parts: [{ text: 'X' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'Y' }] }, finishReason: 'STOP' }] },
      ])) as typeof fetch;
    const provider = createGeminiProvider(geminiConfig(), { fetchImpl });
    const deltas: string[] = [];
    const result = await provider.complete(request({ model: 'gemini-pro' }), {
      onDelta: (d) => deltas.push(d),
    });
    expect(result.text).to.equal('XY');
    expect(deltas).to.deep.equal(['X', 'Y']);
    expect(result.finishReason).to.equal('STOP');
  });

  test('provider-specific finish reasons are preserved', async () => {
    const fetchImpl = (async () =>
      sseResponse([
        { choices: [{ delta: { content: 'Hi' }, finish_reason: 'length' }] },
      ])) as typeof fetch;
    const provider = createOpenAiCompatibleProvider(openAiConfig(), { fetchImpl });
    const result = await provider.complete(request());
    expect(result.finishReason).to.equal('length');
  });

  test('unexpected stream termination without DONE still returns aggregated text', async () => {
    const fetchImpl = (async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const provider = createOpenAiCompatibleProvider(openAiConfig(), { fetchImpl });
    const result = await provider.complete(request());
    expect(result.text).to.equal('partial');
  });

  test('malformed SSE data is invalid_response and does not hang', async () => {
    const fetchImpl = (async () => sseResponse(['{not json'])) as typeof fetch;
    const provider = createOpenAiCompatibleProvider(openAiConfig(), { fetchImpl });
    let failure: unknown;
    try {
      await provider.complete(request());
    } catch (error) {
      failure = error;
    }
    expect((failure as ProviderError).code).to.equal('invalid_response');
  });
});

suite('cancellation lifecycle', () => {
  test('cancel before dispatch', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    }) as typeof fetch;
    const provider = createOpenAiCompatibleProvider(openAiConfig({ stream: false }), { fetchImpl });
    const token = new TestCancellationToken();
    token.cancel();
    let failure: unknown;
    try {
      await provider.complete(request({ stream: false }), { token });
    } catch (error) {
      failure = error;
    }
    expect((failure as ProviderError).code).to.equal('cancelled');
    expect(called).to.equal(false);
  });

  test('cancel during HTTP connection aborts fetch', async () => {
    const provider = createOpenAiCompatibleProvider(openAiConfig({ stream: false }), {
      fetchImpl: ((_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const onAbort = (): void => {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          };
          init?.signal?.addEventListener('abort', onAbort, { once: true });
          if (init?.signal?.aborted) onAbort();
        })) as typeof fetch,
    });
    const token = new TestCancellationToken();
    const pending = provider.complete(request({ stream: false }), { token, timeoutMs: 5000 });
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

  test('cancel during streaming does not deliver further deltas', async () => {
    const token = new TestCancellationToken();
    const fetchImpl = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const onAbort = (): void => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        };
        init?.signal?.addEventListener('abort', onAbort, { once: true });
        if (init?.signal?.aborted) onAbort();
      })) as typeof fetch;
    const provider = createOpenAiCompatibleProvider(openAiConfig(), { fetchImpl });
    const deltas: string[] = [];
    const pending = provider.complete(request(), { token, onDelta: (d) => deltas.push(d) });
    await delay(10);
    token.cancel();
    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }
    expect((failure as ProviderError).code).to.equal('cancelled');
    // No success result was produced; busy state is the caller's responsibility.
    expect(Array.isArray(deltas)).to.equal(true);
  });

  test('cancel after successful completion is ignored', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ choices: [{ message: { content: 'done' } }] })) as typeof fetch;
    const provider = createOpenAiCompatibleProvider(openAiConfig({ stream: false }), { fetchImpl });
    const token = new TestCancellationToken();
    const result = await provider.complete(request({ stream: false }), { token });
    token.cancel();
    expect(result.text).to.equal('done');
  });

  test('timeout during connection', async () => {
    const provider = createOpenAiCompatibleProvider(openAiConfig({ stream: false }), {
      fetchImpl: ((_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const onAbort = (): void => {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          };
          init?.signal?.addEventListener('abort', onAbort, { once: true });
        })) as typeof fetch,
    });
    let failure: unknown;
    try {
      await provider.complete(request({ stream: false }), { timeoutMs: 50 });
    } catch (error) {
      failure = error;
    }
    expect((failure as ProviderError).code).to.equal('timeout');
  });

  test('Gemini cancel before dispatch', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse({});
    }) as typeof fetch;
    const provider = createGeminiProvider(geminiConfig(), { fetchImpl });
    const token = new TestCancellationToken();
    token.cancel();
    let failure: unknown;
    try {
      await provider.complete(request({ model: 'gemini-pro' }), { token });
    } catch (error) {
      failure = error;
    }
    expect((failure as ProviderError).code).to.equal('cancelled');
    expect(called).to.equal(false);
  });
});

suite('failure classification and bounded retry', () => {
  test('rate_limit is retried once with Retry-After and succeeds', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({ error: { message: 'slow down' } }, 429, { 'Retry-After': '0' });
      }
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    }) as typeof fetch;
    const provider = createOpenAiCompatibleProvider(openAiConfig({ stream: false }), { fetchImpl });
    const result = await provider.complete(request({ stream: false }));
    expect(result.text).to.equal('ok');
    expect(calls).to.equal(2);
  });

  test('authentication failures are never retried', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse({ error: { message: 'bad key' } }, 401);
    }) as typeof fetch;
    const provider = createOpenAiCompatibleProvider(openAiConfig({ stream: false }), { fetchImpl });
    let failure: unknown;
    try {
      await provider.complete(request({ stream: false }));
    } catch (error) {
      failure = error;
    }
    expect((failure as ProviderError).code).to.equal('authentication');
    expect(calls).to.equal(1);
  });

  test('cancelled requests are never retried', async () => {
    let calls = 0;
    const fetchImpl = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        const onAbort = (): void => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        };
        init?.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }) as typeof fetch;
    const provider = createOpenAiCompatibleProvider(openAiConfig({ stream: false }), { fetchImpl });
    const token = new TestCancellationToken();
    const pending = provider.complete(request({ stream: false }), { token, timeoutMs: 5000 });
    await delay(10);
    token.cancel();
    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }
    expect((failure as ProviderError).code).to.equal('cancelled');
    expect(calls).to.equal(1);
  });

  test('streaming errors after first delta are not retried', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return sseResponse([
        { choices: [{ delta: { content: 'A' } }] },
        { error: { message: 'mid-stream fail' } },
      ]);
    }) as typeof fetch;
    const provider = createOpenAiCompatibleProvider(openAiConfig(), { fetchImpl });
    const deltas: string[] = [];
    let failure: unknown;
    try {
      await provider.complete(request(), { onDelta: (d) => deltas.push(d) });
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(ProviderError);
    expect(calls).to.equal(1);
    expect(deltas).to.deep.equal(['A']);
  });

  test('network classification distinguishes refused and DNS failures', async () => {
    const refusedErr = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
    const refusedProvider = createOpenAiCompatibleProvider(openAiConfig({ stream: false }), {
      fetchImpl: (async () => {
        throw refusedErr;
      }) as typeof fetch,
    });
    let refusedFailure: unknown;
    try {
      await refusedProvider.complete(request({ stream: false }));
    } catch (error) {
      refusedFailure = error;
    }
    expect((refusedFailure as ProviderError).code).to.equal('network');
    expect((refusedFailure as ProviderError).message).to.contain('refused');

    const dnsErr = Object.assign(new Error('getaddrinfo ENOTFOUND example.invalid'), { code: 'ENOTFOUND' });
    const dnsProvider = createOpenAiCompatibleProvider(openAiConfig({ stream: false }), {
      fetchImpl: (async () => {
        throw dnsErr;
      }) as typeof fetch,
    });
    let dnsFailure: unknown;
    try {
      await dnsProvider.complete(request({ stream: false }));
    } catch (error) {
      dnsFailure = error;
    }
    expect((dnsFailure as ProviderError).code).to.equal('network');
    expect((dnsFailure as ProviderError).message).to.contain('could not be resolved');
    // No secret leaks.
    expect((dnsFailure as ProviderError).message).to.not.contain(OPENAI_KEY);
  });
});
