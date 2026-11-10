import { expect } from 'chai';
import { ProviderError } from '../../src/providers/errors';
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  setUserAgentVersion,
  userAgent,
  buildCompletionBody,
  buildRequestHeaders,
  createOpenAiCompatibleProvider,
  type OpenAiCompatibleConfig,
} from '../../src/providers/openaiCompatible';
import { createProvider, listProviderTypes, providerDisplayName } from '../../src/providers/registry';
import type { CompletionRequest } from '../../src/providers/types';
import {
  TestCancellationToken,
  delay,
  sendJson,
  sendSse,
  startMockServer,
  waitFor,
  type MockServer,
} from './helpers';

const TEST_SECRET = 'sk-test-abcdefghijklmnopqrstuvwxyz';

function config(overrides: Partial<OpenAiCompatibleConfig> = {}): OpenAiCompatibleConfig {
  return {
    apiKey: TEST_SECRET,
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

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    model: 'test-model',
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

async function withServer(
  handler: Parameters<typeof startMockServer>[0],
  run: (server: MockServer) => Promise<void>,
): Promise<void> {
  const server = await startMockServer(handler);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

suite('openai-compatible provider configuration', () => {
  test('accepts valid configuration and exposes its identity', () => {
    const provider = createOpenAiCompatibleProvider(config());
    expect(provider.id).to.equal(OPENAI_COMPATIBLE_PROVIDER_ID);
    expect(provider.displayName).to.equal('OpenAI-compatible');
  });

  test('rejects invalid endpoints, models and limits', () => {
    expectCodes(() => createOpenAiCompatibleProvider(config({ baseUrl: 'ftp://example.com' })), 'configuration');
    expectCodes(() => createOpenAiCompatibleProvider(config({ model: '   ' })), 'configuration');
    expectCodes(() => createOpenAiCompatibleProvider(config({ model: 'bad\nmodel' })), 'configuration');
    expectCodes(() => createOpenAiCompatibleProvider(config({ timeoutMs: 10 })), 'configuration');
    expectCodes(() => createOpenAiCompatibleProvider(config({ temperature: 3 })), 'configuration');
    expectCodes(() => createOpenAiCompatibleProvider(config({ maxOutputTokens: 0 })), 'configuration');
    expectCodes(() => createOpenAiCompatibleProvider(config({ maxOutputTokens: 2.5 })), 'configuration');
  });

  test('does not require an API key for loopback providers', async () => {
    await withServer(
      (_incoming, response) => sendJson(response, 200, {
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      }),
      async (server) => {
        const provider = createOpenAiCompatibleProvider(
          config({ apiKey: undefined, baseUrl: server.baseUrl }),
        );
        const result = await provider.complete(request());
        expect(result.text).to.equal('ok');
        expect(server.requests[0].headers.authorization).to.equal(undefined);
      },
    );
  });
});

suite('request construction', () => {
  test('builds the OpenAI-compatible body with optional parameters', () => {
    expect(
      buildCompletionBody({
        model: 'm',
        messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
        stream: true,
        temperature: 0,
        maxOutputTokens: 16,
      }),
    ).to.deep.equal({
      model: 'm',
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
      ],
      stream: true,
      temperature: 0,
      max_tokens: 16,
    });
  });

  test('omits optional body fields when undefined', () => {
    const body = buildCompletionBody({ model: 'm', messages: [], stream: false });
    expect(body).to.deep.equal({ model: 'm', messages: [], stream: false });
  });

  test('builds headers with bearer auth and SSE accept', () => {
    const headers = buildRequestHeaders(TEST_SECRET, true);
    expect(headers.Authorization).to.equal(`Bearer ${TEST_SECRET}`);
    expect(headers.Accept).to.equal('text/event-stream');
    expect(headers['Content-Type']).to.equal('application/json');
    expect(headers['User-Agent']).to.equal(userAgent());
  });

  test('reports the version handed in at activation, never a baked-in one', () => {
    setUserAgentVersion('9.9.9');
    try {
      expect(userAgent()).to.equal('QuantsMind-VSCode-AI-Coder/9.9.9');
      expect(buildRequestHeaders(undefined, false)['User-Agent']).to.equal(
        'QuantsMind-VSCode-AI-Coder/9.9.9',
      );
    } finally {
      setUserAgentVersion('dev');
    }
  });

  test('omits authorization without a key and requests JSON when not streaming', () => {
    const headers = buildRequestHeaders(undefined, false);
    expect(headers.Authorization).to.equal(undefined);
    expect(headers.Accept).to.equal('application/json');
  });

  test('sends a well-formed HTTP request and normalizes the JSON response', async () => {
    await withServer(
      (_incoming, response) =>
        sendJson(response, 200, {
          model: 'returned-model',
          choices: [{ message: { content: 'Hello there' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      async (server) => {
        const provider = createOpenAiCompatibleProvider(
          config({ baseUrl: server.baseUrl, stream: false }),
        );
        const result = await provider.complete(request());

        expect(result.text).to.equal('Hello there');
        expect(result.model).to.equal('returned-model');
        expect(result.finishReason).to.equal('stop');
        expect(result.usage).to.deep.equal({
          promptTokens: 3,
          completionTokens: 2,
          totalTokens: 5,
        });

        expect(server.requests).to.have.length(1);
        const sent = server.requests[0];
        expect(sent.method).to.equal('POST');
        expect(sent.url).to.equal('/v1/chat/completions');
        expect(sent.headers.authorization).to.equal(`Bearer ${TEST_SECRET}`);
        expect(sent.headers['user-agent']).to.equal(userAgent());
        expect(JSON.parse(sent.body)).to.deep.equal({
          model: 'test-model',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: false,
          temperature: 0.2,
          max_tokens: 128,
        });
      },
    );
  });

  test('parses a JSON response even when streaming is enabled', async () => {
    await withServer(
      (_incoming, response) =>
        sendJson(response, 200, { choices: [{ message: { content: 'json' } }] }),
      async (server) => {
        const provider = createOpenAiCompatibleProvider(
          config({ baseUrl: server.baseUrl, stream: true }),
        );
        const result = await provider.complete(request({ stream: true }));
        expect(result.text).to.equal('json');
      },
    );
  });

  test('supports content part arrays and refusals', async () => {
    await withServer(
      (_incoming, response) =>
        sendJson(response, 200, {
          choices: [
            { message: { content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] } },
          ],
        }),
      async (server) => {
        const provider = createOpenAiCompatibleProvider(config({ baseUrl: server.baseUrl }));
        expect((await provider.complete(request())).text).to.equal('part one part two');
      },
    );

    await withServer(
      (_incoming, response) =>
        sendJson(response, 200, { choices: [{ message: { refusal: 'I cannot help with that.' } }] }),
      async (server) => {
        const provider = createOpenAiCompatibleProvider(config({ baseUrl: server.baseUrl }));
        expect((await provider.complete(request())).text).to.equal('I cannot help with that.');
      },
    );
  });
});

suite('streaming responses', () => {
  test('aggregates deltas, invokes the callback, and stops at [DONE]', async () => {
    await withServer(
      (_incoming, response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const events = [
          { model: 'stream-model', choices: [{ delta: { content: 'Hel' } }] },
          { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }], usage: { total_tokens: 4 } },
          '[DONE]',
          { choices: [{ delta: { content: 'ignored' } }] },
        ];
        const body = events
          .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
          .join('');
        for (let offset = 0; offset < body.length; offset += 17) {
          response.write(body.slice(offset, offset + 17));
        }
        response.end();
      },
      async (server) => {
        const provider = createOpenAiCompatibleProvider(
          config({ baseUrl: server.baseUrl, stream: true }),
        );
        const deltas: string[] = [];
        const result = await provider.complete(request({ stream: true }), {
          onDelta: (delta) => deltas.push(delta),
        });

        expect(result.text).to.equal('Hello');
        expect(result.model).to.equal('stream-model');
        expect(result.finishReason).to.equal('stop');
        expect(result.usage?.totalTokens).to.equal(4);
        expect(deltas).to.deep.equal(['Hel', 'lo']);
        expect(server.requests[0].headers.accept).to.equal('text/event-stream');
        expect(JSON.parse(server.requests[0].body).stream).to.equal(true);
      },
    );
  });

  test('rejects an empty streaming response', async () => {
    await withServer(
      (_incoming, response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end();
      },
      async (server) => {
        const provider = createOpenAiCompatibleProvider(
          config({ baseUrl: server.baseUrl, stream: true }),
        );
        let failure: unknown;
        try {
          await provider.complete(request({ stream: true }));
        } catch (error) {
          failure = error;
        }
        expect(failure).to.be.instanceOf(ProviderError);
        expect((failure as ProviderError).code).to.equal('invalid_response');
      },
    );
  });

  test('rejects malformed stream data', async () => {
    await withServer(
      (_incoming, response) => sendSse(response, ['not-json']),
      async (server) => {
        const provider = createOpenAiCompatibleProvider(
          config({ baseUrl: server.baseUrl, stream: true }),
        );
        let failure: unknown;
        try {
          await provider.complete(request({ stream: true }));
        } catch (error) {
          failure = error;
        }
        expect((failure as ProviderError).code).to.equal('invalid_response');
      },
    );
  });

  test('surfaces provider error payloads inside a stream', async () => {
    await withServer(
      (_incoming, response) => sendSse(response, [{ error: { message: `bad ${TEST_SECRET}` } }]),
      async (server) => {
        const provider = createOpenAiCompatibleProvider(
          config({ baseUrl: server.baseUrl, stream: true }),
        );
        let failure: unknown;
        try {
          await provider.complete(request({ stream: true }));
        } catch (error) {
          failure = error;
        }
        expect((failure as ProviderError).code).to.equal('invalid_response');
        expect((failure as ProviderError).message).to.not.contain(TEST_SECRET);
      },
    );
  });
});

suite('provider error handling', () => {
  test('normalizes HTTP authentication, rate-limit and server failures', async () => {
    const statuses = [401, 429, 503];
    for (const status of statuses) {
      await withServer(
        (_incoming, response) =>
          sendJson(response, status, { error: { message: `failure ${TEST_SECRET}` } }),
        async (server) => {
          const provider = createOpenAiCompatibleProvider(config({ baseUrl: server.baseUrl }));
          let failure: unknown;
          try {
            await provider.complete(request());
          } catch (error) {
            failure = error;
          }
          expect(failure).to.be.instanceOf(ProviderError);
          const normalized = failure as ProviderError;
          expect(normalized.status).to.equal(status);
          expect(normalized.message).to.not.contain(TEST_SECRET);
          expect(normalized.code).to.equal(
            status === 401 ? 'authentication' : status === 429 ? 'rate_limit' : 'server',
          );
        },
      );
    }
  });

  test('rejects invalid JSON responses', async () => {
    await withServer(
      (_incoming, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{not json');
      },
      async (server) => {
        const provider = createOpenAiCompatibleProvider(config({ baseUrl: server.baseUrl }));
        let failure: unknown;
        try {
          await provider.complete(request());
        } catch (error) {
          failure = error;
        }
        expect((failure as ProviderError).code).to.equal('invalid_response');
      },
    );
  });

  test('rejects responses without a completion choice or text', async () => {
    await withServer(
      (_incoming, response) => sendJson(response, 200, { choices: [] }),
      async (server) => {
        const provider = createOpenAiCompatibleProvider(config({ baseUrl: server.baseUrl }));
        let failure: unknown;
        try {
          await provider.complete(request());
        } catch (error) {
          failure = error;
        }
        expect((failure as ProviderError).code).to.equal('invalid_response');
      },
    );

    await withServer(
      (_incoming, response) => sendJson(response, 200, { choices: [{ message: {} }] }),
      async (server) => {
        const provider = createOpenAiCompatibleProvider(config({ baseUrl: server.baseUrl }));
        let failure: unknown;
        try {
          await provider.complete(request());
        } catch (error) {
          failure = error;
        }
        expect((failure as ProviderError).message).to.contain('did not contain message text');
      },
    );
  });

  test('refuses provider redirects instead of forwarding the request elsewhere', async () => {
    await withServer(
      (_incoming, response) => {
        response.writeHead(302, { Location: 'https://redirected.example/v1/chat/completions' });
        response.end();
      },
      async (server) => {
        const provider = createOpenAiCompatibleProvider(
          config({ baseUrl: server.baseUrl, stream: false }),
        );
        let failure: unknown;
        try {
          await provider.complete(request());
        } catch (error) {
          failure = error;
        }
        expect(failure).to.be.instanceOf(ProviderError);
        expect((failure as ProviderError).code).to.equal('network');
      },
    );
  });

  test('normalizes fetch failures without leaking credentials', async () => {
    const provider = createOpenAiCompatibleProvider(config(), {
      fetchImpl: (async () => {
        throw new TypeError(`connect failed for ${TEST_SECRET}`);
      }) as typeof fetch,
    });

    let failure: unknown;
    try {
      await provider.complete(request());
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(ProviderError);
    expect((failure as ProviderError).code).to.equal('network');
    expect((failure as ProviderError).message).to.not.contain(TEST_SECRET);
  });

  test('rejects invalid request payloads before sending', async () => {
    const provider = createOpenAiCompatibleProvider(config());
    let failure: unknown;
    try {
      await provider.complete({ model: '', messages: [], stream: false });
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(ProviderError);
    expect((failure as ProviderError).code).to.equal('configuration');
  });
});

suite('provider cancellation and timeout', () => {
  test('does not send a request when the token is already cancelled', async () => {
    await withServer(
      (_incoming, response) => sendJson(response, 200, {}),
      async (server) => {
        const provider = createOpenAiCompatibleProvider(config({ baseUrl: server.baseUrl }));
        const token = new TestCancellationToken();
        token.cancel();

        let failure: unknown;
        try {
          await provider.complete(request(), { token });
        } catch (error) {
          failure = error;
        }

        expect((failure as ProviderError).code).to.equal('cancelled');
        expect(server.requests).to.have.length(0);
      },
    );
  });

  test('cancels an in-flight request', async () => {
    await withServer(
      () => {
        // Intentionally never respond.
      },
      async (server) => {
        const provider = createOpenAiCompatibleProvider(config({ baseUrl: server.baseUrl }));
        const token = new TestCancellationToken();

        const pending = provider.complete(request(), { token, timeoutMs: 5000 });
        await waitFor(() => server.requests.length === 1);
        token.cancel();

        let failure: unknown;
        try {
          await pending;
        } catch (error) {
          failure = error;
        }
        expect((failure as ProviderError).code).to.equal('cancelled');
      },
    );
  });

  test('times out a request that never responds', async () => {
    await withServer(
      () => {
        // Intentionally never respond.
      },
      async (server) => {
        const provider = createOpenAiCompatibleProvider(config({ baseUrl: server.baseUrl }));

        let failure: unknown;
        try {
          await provider.complete(request(), { timeoutMs: 50 });
        } catch (error) {
          failure = error;
        }
        expect((failure as ProviderError).code).to.equal('timeout');
        await delay(10);
      },
    );
  });
});

suite('provider registry', () => {
  test('lists the built-in provider and resolves display names', () => {
    expect(listProviderTypes()).to.deep.equal([
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
    expect(providerDisplayName(OPENAI_COMPATIBLE_PROVIDER_ID)).to.equal('OpenAI-compatible');
    expect(providerDisplayName('gemini')).to.equal('Google Gemini');
    expect(providerDisplayName('unknown')).to.equal(undefined);
  });

  test('creates a provider by type', () => {
    const provider = createProvider(OPENAI_COMPATIBLE_PROVIDER_ID, config());
    expect(provider.id).to.equal(OPENAI_COMPATIBLE_PROVIDER_ID);
  });

  test('creates a gemini provider by type', () => {
    const provider = createProvider('gemini', config());
    expect(provider.id).to.equal('gemini');
    expect(provider.displayName).to.equal('Google Gemini');
  });

  test('rejects empty model for gemini via registry', () => {
    expectCodes(() => createProvider('gemini', config({ model: '' })), 'configuration');
  });

  test('rejects invalid model for gemini via registry', () => {
    expectCodes(() => createProvider('gemini', config({ model: 'bad\nmodel' })), 'configuration');
  });

  test('rejects unsupported provider types', () => {
    expectCodes(() => createProvider('unknown-provider', config()), 'configuration');
  });
});
