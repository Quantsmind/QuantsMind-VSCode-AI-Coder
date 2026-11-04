import { expect } from 'chai';
import { buildMessages } from '../../src/chat/prompts';
import type { RedactedContextItem } from '../../src/context/filters';
import { createOpenAiCompatibleProvider } from '../../src/providers/openaiCompatible';
import type { ChatMessage } from '../../src/providers/types';
import {
  sendJson,
  sendSse,
  startMockServer,
  type MockServer,
  type MockHandler,
} from './helpers';

const TEST_SECRET = 'sk-test-abcdefghijklmnopqrstuvwxyz';
const LITERAL_PROMPT = 'Reply with exactly: READY';
const GENERIC_REPLY =
  "Please provide the code or details you'd like assistance with, and I'll be happy to help!";
const LIVE_MODEL = 'openai/gpt-4o-mini';

/** Mirrors a durable transcript restored after a window reload. */
function restoredHistory(turns: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < turns; index += 1) {
    const role: ChatMessage['role'] = index % 2 === 0 ? 'user' : 'assistant';
    messages.push({ role, content: `${role} turn ${index}` });
  }
  return messages;
}

function attachment(): RedactedContextItem {
  return {
    path: 'src/example.ts',
    content: 'export const value = 1;',
    languageId: 'typescript',
    sizeBytes: 23,
    redactions: 0,
  };
}

async function withServer(
  handler: MockHandler,
  run: (server: MockServer) => Promise<void>,
): Promise<void> {
  const server = await startMockServer(handler);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

function bodyOf(recorded: string): Record<string, unknown> {
  return JSON.parse(recorded) as Record<string, unknown>;
}

function messagesOf(recorded: string): { role: string; content: string }[] {
  return bodyOf(recorded).messages as { role: string; content: string }[];
}

suite('provider request regression: verbatim literal prompts', () => {
  test('a fresh chat turn sends the literal prompt unchanged', () => {
    const messages = buildMessages({
      mode: 'ask',
      question: LITERAL_PROMPT,
      attachments: [],
      history: [],
    });

    expect(messages).to.have.lengthOf(2);
    expect(messages[0].role).to.equal('system');
    expect(messages[1]).to.deep.equal({ role: 'user', content: LITERAL_PROMPT });
  });

  test('whitespace-only prompts fall back once, never silently for real text', () => {
    const blank = buildMessages({ mode: 'ask', question: '   ', attachments: [], history: [] });
    expect(blank[1].content).to.equal('Help me with the attached code.');

    const spaced = buildMessages({
      mode: 'ask',
      question: `  ${LITERAL_PROMPT}  `,
      attachments: [],
      history: [],
    });
    expect(spaced[1].content).to.equal(LITERAL_PROMPT);
  });

  test('attachments keep the literal prompt as the final line of the user turn', () => {
    const messages = buildMessages({
      mode: 'ask',
      question: LITERAL_PROMPT,
      attachments: [attachment()],
      history: [],
    });

    expect(messages[1].content).to.contain('<attached_context>');
    expect(messages[1].content.endsWith(`User request:\n${LITERAL_PROMPT}`)).to.equal(true);
  });

  test('a restored multi-turn transcript is replayed and the prompt stays last', () => {
    const history = restoredHistory(17);
    const messages = buildMessages({
      mode: 'ask',
      question: LITERAL_PROMPT,
      attachments: [],
      history,
    });

    expect(messages).to.have.lengthOf(19);
    expect(messages[0].role).to.equal('system');
    expect(messages.slice(1, 18).map((m) => m.content)).to.deep.equal(
      history.map((m) => m.content),
    );
    expect(messages[18]).to.deep.equal({ role: 'user', content: LITERAL_PROMPT });
  });

  test('the wire request uses the configured model, endpoint and verbatim prompt', async () => {
    const messages = buildMessages({
      mode: 'ask',
      question: LITERAL_PROMPT,
      attachments: [],
      history: restoredHistory(17),
    });

    await withServer(
      (_incoming, response) =>
        sendJson(response, 200, {
          model: LIVE_MODEL,
          choices: [{ message: { role: 'assistant', content: GENERIC_REPLY }, finish_reason: 'stop' }],
        }),
      async (server) => {
        const provider = createOpenAiCompatibleProvider({
          apiKey: TEST_SECRET,
          baseUrl: server.baseUrl,
          model: LIVE_MODEL,
          timeoutMs: 10_000,
          temperature: 0.2,
          maxOutputTokens: 256,
          stream: false,
          allowInsecureLocalhost: true,
        });

        const result = await provider.complete({
          model: LIVE_MODEL,
          messages,
          temperature: 0.2,
          maxOutputTokens: 256,
          stream: false,
        });

        expect(server.requests).to.have.lengthOf(1);
        const recorded = server.requests[0];
        expect(recorded.method).to.equal('POST');
        expect(recorded.url).to.equal('/v1/chat/completions');
        expect(recorded.headers.authorization).to.equal(`Bearer ${TEST_SECRET}`);

        const sent = messagesOf(recorded.body);
        expect(sent).to.have.lengthOf(19);
        expect(bodyOf(recorded.body).model).to.equal(LIVE_MODEL);
        expect(sent[sent.length - 1]).to.deep.equal({ role: 'user', content: LITERAL_PROMPT });
        expect(sent[0].role).to.equal('system');

        // The transcript is the only thing that can be generic; the request is not.
        expect(recorded.body).to.not.contain(TEST_SECRET);
        expect(result.text).to.equal(GENERIC_REPLY);
        expect(result.finishReason).to.equal('stop');
      },
    );
  });

  test('streamed deltas reassemble to the provider text without loss', async () => {
    const messages = buildMessages({
      mode: 'ask',
      question: LITERAL_PROMPT,
      attachments: [],
      history: [],
    });
    const parts = ['Please provide the ', 'code or details ', `you'd like assistance with, and I'll be happy to help!`];

    await withServer(
      (_incoming, response) =>
        sendSse(
          response,
          parts.map((content) => ({
            model: LIVE_MODEL,
            choices: [{ delta: { content }, finish_reason: null }],
          })),
        ),
      async (server) => {
        const provider = createOpenAiCompatibleProvider({
          apiKey: TEST_SECRET,
          baseUrl: server.baseUrl,
          model: LIVE_MODEL,
          timeoutMs: 10_000,
          temperature: 0.2,
          maxOutputTokens: 256,
          stream: true,
          allowInsecureLocalhost: true,
        });

        const deltas: string[] = [];
        const result = await provider.complete(
          {
            model: LIVE_MODEL,
            messages,
            temperature: 0.2,
            maxOutputTokens: 256,
            stream: true,
          },
          { onDelta: (delta) => deltas.push(delta) },
        );

        expect(deltas.join('')).to.equal(GENERIC_REPLY);
        expect(result.text).to.equal(GENERIC_REPLY);
        expect(messagesOf(server.requests[0].body)[1].content).to.equal(LITERAL_PROMPT);
      },
    );
  });

  test('a long replayed transcript does not displace the newest user turn', () => {
    const history = restoredHistory(40);
    const messages = buildMessages({
      mode: 'ask',
      question: LITERAL_PROMPT,
      attachments: [],
      history,
    });

    expect(messages[messages.length - 1].content).to.equal(LITERAL_PROMPT);
    expect(messages.filter((m) => m.role === 'system')).to.have.lengthOf(1);
  });
});
