import { expect } from 'chai';
import { AgentToolRegistry, type AgentTool } from '../../src/agent/codingAgent';
import { CompletionService } from '../../src/providers/completionService';
import { ProviderError } from '../../src/providers/errors';
import {
  buildCompletionBody,
  createOpenAiCompatibleProvider,
  type OpenAiCompatibleConfig,
} from '../../src/providers/openaiCompatible';
import {
  buildGeminiBody,
  createGeminiProvider,
} from '../../src/providers/geminiCompatible';
import type {
  ChatMessage,
  CompletionRequest,
  CompletionToolDefinition,
} from '../../src/providers/types';
import { Logger } from '../../src/security/logger';
import { SecretStore } from '../../src/security/secretStore';
import { MemoryLogSink, MemorySecretStorage, createSettings, sendJson, startMockServer } from './helpers';

const TEST_SECRET = 'sk-toolcycle-abcdefghijklmnopqrstuvwxyz';

const READ_FILE_TOOL: CompletionToolDefinition = {
  name: 'read_file',
  description: 'Read a workspace file.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

function openAiConfig(baseUrl: string): OpenAiCompatibleConfig {
  return {
    apiKey: TEST_SECRET,
    baseUrl,
    model: 'gpt-4o-mini',
    timeoutMs: 5_000,
    temperature: 0.2,
    maxOutputTokens: 256,
    stream: false,
    allowInsecureLocalhost: true,
  };
}

function toolRequest(messages: readonly ChatMessage[]): CompletionRequest {
  return {
    model: 'gpt-4o-mini',
    messages,
    stream: false,
    tools: [READ_FILE_TOOL],
  };
}

async function expectConfigurationError(run: () => Promise<unknown>, fragment: string): Promise<void> {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  expect(failure, `expected a configuration error containing "${fragment}"`).to.be.instanceOf(ProviderError);
  expect((failure as ProviderError).code).to.equal('configuration');
  expect((failure as ProviderError).message).to.contain(fragment);
}

suite('native tool request integrity (D1)', () => {
  test('serializes tool definitions, assistant tool calls and tool results', () => {
    const body = buildCompletionBody(
      toolRequest([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'read a.txt' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_abc', name: 'read_file', arguments: { path: 'a.txt' } }],
        },
        { role: 'tool', toolCallId: 'call_abc', content: '{"ok":true,"output":"contents"}' },
      ]),
    );

    expect(body.tools).to.deep.equal([
      { type: 'function', function: { name: 'read_file', description: 'Read a workspace file.', parameters: READ_FILE_TOOL.parameters } },
    ]);
    expect(body.tool_choice).to.equal('auto');
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[2]).to.deep.equal({
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
      ],
    });
    expect(messages[3]).to.deep.equal({
      role: 'tool',
      content: '{"ok":true,"output":"contents"}',
      tool_call_id: 'call_abc',
    });
  });

  test('omits tool fields when no tools are declared', () => {
    const body = buildCompletionBody({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      tools: [],
    });
    expect(body.tools).to.equal(undefined);
    expect(body.tool_choice).to.equal(undefined);
  });

  test('accepts a complete multi-turn tool transcript over HTTP', async () => {
    const server = await startMockServer((_incoming, response) => {
      sendJson(response, 200, { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] });
    });
    try {
      const provider = createOpenAiCompatibleProvider(openAiConfig(server.baseUrl));
      const result = await provider.complete(
        toolRequest([
          { role: 'user', content: 'read a.txt' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } }] },
          { role: 'tool', toolCallId: 'call_1', content: 'contents of a.txt' },
        ]),
      );
      expect(result.text).to.equal('done');
      const sent = JSON.parse(server.requests[0].body) as Record<string, unknown>;
      expect(sent.tools).to.be.an('array');
      const messages = sent.messages as Array<Record<string, unknown>>;
      expect(messages[1].tool_calls).to.be.an('array');
      expect(messages[2].tool_call_id).to.equal('call_1');
      expect(messages[2].role).to.equal('tool');
    } finally {
      await server.close();
    }
  });

  test('rejects a tool message with no call id', async () => {
    const provider = createOpenAiCompatibleProvider(openAiConfig('https://api.example.com/v1'));
    await expectConfigurationError(
      () => provider.complete(toolRequest([
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: {} }] },
        { role: 'tool', content: 'result' } as ChatMessage,
      ])),
      'must reference the tool call id',
    );
  });

  test('rejects a tool message answering an unannounced call id', async () => {
    const provider = createOpenAiCompatibleProvider(openAiConfig('https://api.example.com/v1'));
    await expectConfigurationError(
      () => provider.complete(toolRequest([
        { role: 'user', content: 'hi' },
        { role: 'tool', toolCallId: 'call_missing', content: 'result' },
      ])),
      'announced by a preceding assistant message',
    );
  });

  test('rejects a call id that appears only after the tool result', async () => {
    const provider = createOpenAiCompatibleProvider(openAiConfig('https://api.example.com/v1'));
    await expectConfigurationError(
      () => provider.complete(toolRequest([
        { role: 'tool', toolCallId: 'call_1', content: 'result' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: {} }] },
      ])),
      'announced by a preceding assistant message',
    );
  });

  test('rejects tool call ids and tool calls on the wrong roles', async () => {
    const provider = createOpenAiCompatibleProvider(openAiConfig('https://api.example.com/v1'));
    await expectConfigurationError(
      () => provider.complete(toolRequest([
        { role: 'user', content: 'hi', toolCallId: 'call_1' },
      ])),
      'Only tool messages may carry a tool call id',
    );
    await expectConfigurationError(
      () => provider.complete(toolRequest([
        { role: 'user', content: 'hi', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: {} }] } as ChatMessage,
      ])),
      'Only assistant messages may carry tool calls',
    );
  });

  test('rejects malformed assistant tool calls', async () => {
    const provider = createOpenAiCompatibleProvider(openAiConfig('https://api.example.com/v1'));
    const cases: ReadonlyArray<{ calls: unknown; fragment: string }> = [
      { calls: [{ id: '', name: 'read_file', arguments: {} }], fragment: 'non-empty id' },
      { calls: [{ id: 'call_1', name: 'bad name!', arguments: {} }], fragment: 'valid tool name' },
      { calls: [{ id: 'call_1', name: 'read_file', arguments: 'not-json' }], fragment: 'JSON object' },
      { calls: 'not-an-array', fragment: 'must be an array' },
    ];
    for (const entry of cases) {
      await expectConfigurationError(
        () => provider.complete(toolRequest([
          { role: 'assistant', content: '', toolCalls: entry.calls } as unknown as ChatMessage,
        ])),
        entry.fragment,
      );
    }
  });

  test('rejects malformed native tool definitions', async () => {
    const provider = createOpenAiCompatibleProvider(openAiConfig('https://api.example.com/v1'));
    const base: CompletionRequest = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: false };
    const cases: ReadonlyArray<{ tools: unknown; fragment: string }> = [
      { tools: 'nope', fragment: 'must be an array' },
      { tools: [{ name: 'read_file', description: 'd', parameters: [] }], fragment: 'JSON schema object' },
      { tools: [{ name: 'bad name', description: 'd', parameters: { type: 'object' } }], fragment: 'Tool names must use' },
      { tools: [READ_FILE_TOOL, READ_FILE_TOOL], fragment: 'unique names' },
      { tools: Array.from({ length: 129 }, (_v, i) => ({ ...READ_FILE_TOOL, name: `tool_${i}` })), fragment: 'too many tools' },
    ];
    for (const entry of cases) {
      await expectConfigurationError(
        () => provider.complete({ ...base, tools: entry.tools } as unknown as CompletionRequest),
        entry.fragment,
      );
    }
  });

  test('keeps the request character limit and counts tool payloads toward it', async () => {
    const provider = createOpenAiCompatibleProvider(openAiConfig('https://api.example.com/v1'));
    await expectConfigurationError(
      () => provider.complete({
        model: 'gpt-4o-mini',
        stream: false,
        messages: [{ role: 'user', content: 'x'.repeat(2_000_001) }],
      }),
      'too large',
    );
    await expectConfigurationError(
      () => provider.complete({
        model: 'gpt-4o-mini',
        stream: false,
        messages: [{ role: 'user', content: 'x'.repeat(1_999_000) }],
        tools: [{ ...READ_FILE_TOOL, description: 'd'.repeat(2_000) }],
      }),
      'too large',
    );
  });

  test('still rejects genuinely invalid messages and roles', async () => {
    const provider = createOpenAiCompatibleProvider(openAiConfig('https://api.example.com/v1'));
    await expectConfigurationError(
      () => provider.complete({ model: 'gpt-4o-mini', stream: false, messages: [] }),
      'At least one chat message',
    );
    await expectConfigurationError(
      () => provider.complete({
        model: 'gpt-4o-mini',
        stream: false,
        messages: [{ role: 'function', content: 'hi' } as unknown as ChatMessage],
      }),
      'invalid chat message',
    );
  });
});

suite('complete multi-turn native tool cycle (D1)', () => {
  test('provider request -> tool call -> execution -> tool result -> request -> final answer', async () => {
    let turn = 0;
    const server = await startMockServer((_incoming, response) => {
      turn += 1;
      if (turn === 1) {
        sendJson(response, 200, {
          model: 'gpt-4o-mini',
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_read_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"src/a.txt"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        });
        return;
      }
      sendJson(response, 200, {
        model: 'gpt-4o-mini',
        choices: [{ message: { role: 'assistant', content: 'The file contains alpha.' }, finish_reason: 'stop' }],
      });
    });

    try {
      const provider = createOpenAiCompatibleProvider(openAiConfig(server.baseUrl));
      const registry = new AgentToolRegistry();
      let executedWith: Readonly<Record<string, unknown>> | undefined;
      const tool: AgentTool = {
        name: 'read_file',
        description: 'Read a workspace file.',
        parameters: READ_FILE_TOOL.parameters,
        async execute(args) {
          executedWith = args;
          return { ok: true, tool: 'read_file', output: 'alpha', durationMs: 2 };
        },
      };
      registry.register(tool);

      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are a coding agent.' },
        { role: 'user', content: 'What is in src/a.txt?' },
      ];

      const first = await provider.complete(toolRequest(messages));
      expect(first.toolCalls).to.deep.equal([
        { id: 'call_read_1', name: 'read_file', arguments: { path: 'src/a.txt' } },
      ]);
      expect(first.finishReason).to.equal('tool_calls');

      const call = first.toolCalls?.[0];
      expect(call).to.not.equal(undefined);
      if (call === undefined) {
        return;
      }
      const toolResult = await registry.execute({ id: call.id, name: call.name, arguments: call.arguments });
      expect(toolResult.ok).to.equal(true);
      expect(executedWith).to.deep.equal({ path: 'src/a.txt' });

      messages.push({ role: 'assistant', content: first.text, toolCalls: first.toolCalls });
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify({ ok: toolResult.ok, output: toolResult.output }),
      });

      const second = await provider.complete(toolRequest(messages));
      expect(second.text).to.equal('The file contains alpha.');
      expect(second.toolCalls).to.equal(undefined);
      expect(server.requests).to.have.length(2);

      const firstBody = JSON.parse(server.requests[0].body) as Record<string, unknown>;
      expect(firstBody.tools).to.be.an('array');
      expect(firstBody.tool_choice).to.equal('auto');
      expect((firstBody.messages as unknown[]).length).to.equal(2);

      const secondBody = JSON.parse(server.requests[1].body) as Record<string, unknown>;
      expect(secondBody.tools).to.be.an('array');
      const sentMessages = secondBody.messages as Array<Record<string, unknown>>;
      expect(sentMessages).to.have.length(4);
      expect(sentMessages[2].tool_calls).to.deep.equal([
        { id: 'call_read_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.txt"}' } },
      ]);
      expect(sentMessages[3].role).to.equal('tool');
      expect(sentMessages[3].tool_call_id).to.equal('call_read_1');
      expect(sentMessages[3].content).to.contain('alpha');
    } finally {
      await server.close();
    }
  });
});

suite('capability gating for native tools (D1)', () => {
  function service(type: string, model: string, baseUrl: string, sink: MemoryLogSink): CompletionService {
    const storage = new MemorySecretStorage();
    storage.values.set(`quantsmind.provider.${type}.apiKey`, TEST_SECRET);
    return new CompletionService(
      new SecretStore(storage),
      createSettings({ type, model, baseUrl, stream: true, allowInsecureLocalhost: true }),
      new Logger(sink),
    );
  }

  test('a supported profile and model receives native tool definitions', async () => {
    const server = await startMockServer((_incoming, response) => {
      sendJson(response, 200, { choices: [{ message: { content: 'ok' } }] });
    });
    try {
      const sink = new MemoryLogSink();
      const completion = service('openai', 'gpt-4o-mini', server.baseUrl, sink);
      await completion.complete([{ role: 'user', content: 'hi' }], { tools: [READ_FILE_TOOL] });
      const body = JSON.parse(server.requests[0].body) as Record<string, unknown>;
      expect(body.tools).to.be.an('array');
      expect(body.stream).to.equal(false);
      expect(sink.text).to.not.contain('native tools withheld');
      expect(sink.text).to.not.contain(TEST_SECRET);
    } finally {
      await server.close();
    }
  });

  test('an unsupported local model keeps the JSON protocol and is not sent native tools', async () => {
    const server = await startMockServer((_incoming, response) => {
      sendJson(response, 200, { choices: [{ message: { content: '{"final":"ok"}' } }] });
    });
    try {
      const sink = new MemoryLogSink();
      const completion = service('lm-studio', 'local-model', server.baseUrl, sink);
      const result = await completion.complete([{ role: 'user', content: 'hi' }], { tools: [READ_FILE_TOOL] });
      expect(result.text).to.equal('{"final":"ok"}');
      const body = JSON.parse(server.requests[0].body) as Record<string, unknown>;
      expect(body.tools).to.equal(undefined);
      expect(body.tool_choice).to.equal(undefined);
      expect(sink.text).to.contain('native tools withheld');
      expect(sink.text).to.contain('reason=adapter-or-model-unsupported');
      expect(sink.text).to.not.contain(TEST_SECRET);
    } finally {
      await server.close();
    }
  });

  test('a tool-capable model on a local profile is sent native tools', async () => {
    const server = await startMockServer((_incoming, response) => {
      sendJson(response, 200, { choices: [{ message: { content: 'ok' } }] });
    });
    try {
      const completion = service('ollama', 'qwen2.5-coder:7b', server.baseUrl, new MemoryLogSink());
      await completion.complete([{ role: 'user', content: 'hi' }], { tools: [READ_FILE_TOOL] });
      const body = JSON.parse(server.requests[0].body) as Record<string, unknown>;
      expect(body.tools).to.be.an('array');
    } finally {
      await server.close();
    }
  });

  test('a non-tool model on a tool-capable adapter is not sent native tools', async () => {
    const server = await startMockServer((_incoming, response) => {
      sendJson(response, 200, { choices: [{ message: { content: 'ok' } }] });
    });
    try {
      const completion = service('openai', 'text-embedding-3-small', server.baseUrl, new MemoryLogSink());
      await completion.complete([{ role: 'user', content: 'hi' }], { tools: [READ_FILE_TOOL] });
      const body = JSON.parse(server.requests[0].body) as Record<string, unknown>;
      expect(body.tools).to.equal(undefined);
    } finally {
      await server.close();
    }
  });
});

suite('gemini tool-message handling (D1)', () => {
  const geminiDefaults = { temperature: 0.2, maxOutputTokens: 256 };

  test('translates a tool result without losing the call id or tool name', () => {
    const body = buildGeminiBody(
      {
        model: 'gemini-2.0-flash',
        stream: false,
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'read a.txt' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call_9', name: 'read_file', arguments: { path: 'a.txt' } }] },
          { role: 'tool', toolCallId: 'call_9', content: 'alpha' },
        ],
      },
      geminiDefaults,
    );
    const contents = body.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    expect(contents).to.have.length(3);
    expect(contents[1].role).to.equal('model');
    expect(contents[1].parts[0].text).to.contain('"id":"call_9"');
    expect(contents[1].parts[0].text).to.contain('"name":"read_file"');
    expect(contents[2].role).to.equal('user');
    expect(contents[2].parts[0].text).to.contain('call_9');
    expect(contents[2].parts[0].text).to.contain('read_file');
    expect(contents[2].parts[0].text).to.contain('alpha');
    expect(body.systemInstruction).to.not.equal(undefined);
  });

  test('runs the JSON tool protocol multi-turn over HTTP', async () => {
    let turn = 0;
    const server = await startMockServer((_incoming, response) => {
      turn += 1;
      const text = turn === 1
        ? '{"tool_calls":[{"id":"call_g1","name":"read_file","arguments":{"path":"a.txt"}}]}'
        : '{"final":"alpha"}';
      sendJson(response, 200, { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
    });
    try {
      const provider = createGeminiProvider({
        apiKey: TEST_SECRET,
        model: 'gemini-2.0-flash',
        baseUrl: server.baseUrl,
        temperature: 0.2,
        maxOutputTokens: 256,
        stream: false,
        timeoutMs: 5_000,
        allowInsecureLocalhost: true,
      });
      const messages: ChatMessage[] = [{ role: 'user', content: 'read a.txt' }];
      const first = await provider.complete({ model: 'gemini-2.0-flash', messages, stream: false });
      const parsed = JSON.parse(first.text) as { tool_calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> };
      expect(parsed.tool_calls[0].id).to.equal('call_g1');

      messages.push({ role: 'assistant', content: first.text, toolCalls: parsed.tool_calls });
      messages.push({ role: 'tool', toolCallId: 'call_g1', content: '{"ok":true,"output":"alpha"}' });

      const second = await provider.complete({ model: 'gemini-2.0-flash', messages, stream: false });
      expect(second.text).to.equal('{"final":"alpha"}');
      expect(server.requests).to.have.length(2);
      const secondBody = JSON.parse(server.requests[1].body) as { contents: Array<{ role: string; parts: Array<{ text: string }> }> };
      expect(secondBody.contents).to.have.length(3);
      expect(secondBody.contents[2].parts[0].text).to.contain('call_g1');
      expect(secondBody.contents[2].parts[0].text).to.contain('alpha');
      expect(server.requests[1].url).to.contain(':generateContent');
    } finally {
      await server.close();
    }
  });

  test('refuses native tool definitions instead of dropping them silently', async () => {
    const provider = createGeminiProvider({
      model: 'gemini-2.0-flash',
      baseUrl: 'http://127.0.0.1:9/v1',
      temperature: 0.2,
      maxOutputTokens: 256,
      stream: false,
      allowInsecureLocalhost: true,
    });
    await expectConfigurationError(
      () => provider.complete({
        model: 'gemini-2.0-flash',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [READ_FILE_TOOL],
      }),
      'does not support native tool definitions',
    );
  });

  test('accepts an empty tool list and rejects an unannounced tool result', async () => {
    const provider = createGeminiProvider({
      model: 'gemini-2.0-flash',
      temperature: 0.2,
      maxOutputTokens: 256,
      stream: false,
      baseUrl: 'http://127.0.0.1:9/v1',
      allowInsecureLocalhost: true,
    });
    await expectConfigurationError(
      () => provider.complete({
        model: 'gemini-2.0-flash',
        stream: false,
        messages: [{ role: 'tool', toolCallId: 'call_x', content: 'result' }],
        tools: [],
      }),
      'announced by a preceding assistant message',
    );
  });
});