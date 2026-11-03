import { ProviderError } from './errors';

export const MAX_SSE_EVENT_CHARS = 1_000_000;

function extractData(rawEvent: string): string | undefined {
  const lines = rawEvent.split('\n');
  const data: string[] = [];

  for (const line of lines) {
    if (line.startsWith(':')) {
      continue;
    }
    if (!line.startsWith('data:')) {
      continue;
    }
    let value = line.slice(5);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    data.push(value);
  }

  return data.length > 0 ? data.join('\n') : undefined;
}

/**
 * Incremental server-sent-events parser. It accepts CRLF, LF, and CR line
 * endings, tolerates events split across network chunks, ignores comments and
 * non-data fields, and caps a single event to avoid unbounded memory growth.
 */
export async function* parseServerSentEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = extractData(rawEvent);
        if (data !== undefined) {
          yield data;
        }
        boundary = buffer.indexOf('\n\n');
      }

      if (buffer.length > MAX_SSE_EVENT_CHARS) {
        throw new ProviderError(
          'invalid_response',
          'The provider sent a server-sent event larger than the supported limit.',
        );
      }
    }

    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (buffer.trim().length > 0) {
      const data = extractData(buffer);
      if (data !== undefined) {
        yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
