import { expect } from 'chai';
import { ProviderError } from '../../src/providers/errors';
import { MAX_SSE_EVENT_CHARS, parseServerSentEvents } from '../../src/providers/sse';
import { streamFromChunks } from './helpers';

async function collect(
  chunks: readonly (string | Uint8Array)[],
): Promise<string[]> {
  const events: string[] = [];
  for await (const event of parseServerSentEvents(streamFromChunks(chunks))) {
    events.push(event);
  }
  return events;
}

suite('server-sent events parser', () => {
  test('parses individual data events and the done sentinel', async () => {
    const events = await collect([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    expect(events).to.have.length(3);
    expect(events[0]).to.contain('Hel');
    expect(events[2]).to.equal('[DONE]');
  });

  test('joins multi-line data fields with newlines', async () => {
    const events = await collect(['data: line one\ndata: line two\n\n']);
    expect(events).to.deep.equal(['line one\nline two']);
  });

  test('tolerates CRLF and CR line endings', async () => {
    const crlf = await collect(['data: alpha\r\n\r\ndata: beta\r\n\r\n']);
    expect(crlf).to.deep.equal(['alpha', 'beta']);

    const cr = await collect(['data: alpha\r\rdata: beta\r\r']);
    expect(cr).to.deep.equal(['alpha', 'beta']);
  });

  test('handles events split across network chunks', async () => {
    const events = await collect(['data: {"content":', '"split"}\n', '\n', 'data: second\n\n']);
    expect(events).to.deep.equal(['{"content":"split"}', 'second']);
  });

  test('ignores comments and non-data fields', async () => {
    const events = await collect([': keep-alive\n\nevent: message\nid: 1\ndata: payload\n\n']);
    expect(events).to.deep.equal(['payload']);
  });

  test('flushes a final event without a trailing blank line', async () => {
    const events = await collect(['data: final']);
    expect(events).to.deep.equal(['final']);
  });

  test('ignores blank and comment-only events', async () => {
    const events = await collect(['\n\n: comment only\n\n']);
    expect(events).to.deep.equal([]);
  });

  test('rejects a single event above the size limit', async () => {
    let failure: unknown;
    try {
      await collect(['a'.repeat(MAX_SSE_EVENT_CHARS + 10)]);
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(ProviderError);
    expect((failure as ProviderError).code).to.equal('invalid_response');
  });
});
