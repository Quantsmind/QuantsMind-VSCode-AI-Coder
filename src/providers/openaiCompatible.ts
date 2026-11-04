import { validateCredential } from '../security/credential';
import { redactSecrets } from '../security/redact';
import { withAbort } from './cancellation';
import { buildChatCompletionsUrl, normalizeBaseUrl } from './endpoint';
import {
  ProviderError,
  isProviderError,
  normalizeHttpError,
  normalizeThrownError,
} from './errors';
import { parseServerSentEvents } from './sse';
import type {
  AiProvider,
  ChatMessage,
  ChatRole,
  CompletionOptions,
  CompletionRequest,
  CompletionResult,
  CompletionUsage,
} from './types';

export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';
export const USER_AGENT = 'QuantsMind-VSCode-AI-Coder/0.3.4';

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_JSON_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_REQUEST_CHARS = 2_000_000;
const VALID_ROLES: ReadonlySet<ChatRole> = new Set(['system', 'user', 'assistant']);

export type FetchLike = typeof fetch;

export interface OpenAiCompatibleConfig {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly stream: boolean;
  readonly allowInsecureLocalhost: boolean;
}

export interface OpenAiCompatibleDependencies {
  readonly fetchImpl?: FetchLike;
}

function normalizeConfig(config: OpenAiCompatibleConfig): OpenAiCompatibleConfig {
  const baseUrl = normalizeBaseUrl(config.baseUrl, {
    allowInsecureLocalhost: config.allowInsecureLocalhost,
  });
  const model = config.model.trim();

  if (model.length === 0) {
    throw new ProviderError('configuration', 'The provider model name is not configured.');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(model) || model.length > 200) {
    throw new ProviderError('configuration', 'The provider model name is invalid.');
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 600_000) {
    throw new ProviderError(
      'configuration',
      'The provider request timeout must be between 1000 and 600000 milliseconds.',
    );
  }
  if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) {
    throw new ProviderError('configuration', 'The provider temperature must be between 0 and 2.');
  }
  if (
    !Number.isInteger(config.maxOutputTokens) ||
    config.maxOutputTokens < 1 ||
    config.maxOutputTokens > 131_072
  ) {
    throw new ProviderError(
      'configuration',
      'The maximum output token count must be an integer between 1 and 131072.',
    );
  }

  let apiKey: string | undefined;
  if (typeof config.apiKey === 'string' && config.apiKey.trim().length > 0) {
    apiKey = validateCredential(config.apiKey);
  }

  return {
    baseUrl,
    model,
    apiKey,
    timeoutMs: config.timeoutMs,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    stream: config.stream,
    allowInsecureLocalhost: config.allowInsecureLocalhost,
  };
}

function validateRequest(request: CompletionRequest): CompletionRequest {
  if (typeof request !== 'object' || request === null) {
    throw new ProviderError('configuration', 'The completion request is missing.');
  }

  const model = typeof request.model === 'string' ? request.model.trim() : '';
  if (model.length === 0) {
    throw new ProviderError('configuration', 'A model name is required for the request.');
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new ProviderError('configuration', 'At least one chat message is required.');
  }
  if (typeof request.stream !== 'boolean') {
    throw new ProviderError('configuration', 'The streaming flag must be a boolean.');
  }

  let totalChars = 0;
  const messages: ChatMessage[] = request.messages.map((message) => {
    if (
      typeof message !== 'object' ||
      message === null ||
      !VALID_ROLES.has(message.role) ||
      typeof message.content !== 'string'
    ) {
      throw new ProviderError('configuration', 'The request contains an invalid chat message.');
    }
    totalChars += message.content.length;
    return { role: message.role, content: message.content };
  });

  if (totalChars > MAX_REQUEST_CHARS) {
    throw new ProviderError(
      'configuration',
      `The request is too large (${totalChars} characters; maximum ${MAX_REQUEST_CHARS}).`,
    );
  }

  return {
    model,
    messages,
    stream: request.stream,
    temperature: request.temperature,
    maxOutputTokens: request.maxOutputTokens,
  };
}

export function buildCompletionBody(request: CompletionRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    stream: request.stream,
  };

  if (typeof request.temperature === 'number') {
    body.temperature = request.temperature;
  }
  if (typeof request.maxOutputTokens === 'number') {
    body.max_tokens = request.maxOutputTokens;
  }

  return body;
}

export function buildRequestHeaders(
  apiKey: string | undefined,
  stream: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': USER_AGENT,
  };
  if (apiKey !== undefined && apiKey.length > 0) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => readString(asRecord(part), 'text'))
      .filter((part): part is string => part !== undefined);
    return parts.length > 0 ? parts.join('') : undefined;
  }
  return undefined;
}

function extractContainerText(container: Record<string, unknown> | undefined): string | undefined {
  const content = extractText(container?.content);
  if (content !== undefined) {
    return content;
  }
  return readString(container, 'refusal');
}

function parseUsage(value: unknown): CompletionUsage | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const promptTokens = readNumber(record, 'prompt_tokens');
  const completionTokens = readNumber(record, 'completion_tokens');
  const totalTokens = readNumber(record, 'total_tokens');
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return { promptTokens, completionTokens, totalTokens };
}

function payloadError(
  record: Record<string, unknown>,
  secret: string | undefined,
): ProviderError | undefined {
  const error = record.error;
  if (error === undefined || error === null) {
    return undefined;
  }
  const rawMessage =
    typeof error === 'string' ? error : readString(asRecord(error), 'message');
  const safe = redactSecrets(
    rawMessage ?? 'The provider returned an unspecified error payload.',
    [secret],
  ).text;
  return new ProviderError('invalid_response', `The provider returned an error: ${safe}`);
}

async function readResponseText(
  response: Response,
  limitBytes: number,
  overflow: 'truncate' | 'error',
): Promise<string> {
  if (response.body === null) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const remaining = limitBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(Buffer.from(value.subarray(0, remaining)));
        }
        await reader.cancel();
        if (overflow === 'error') {
          throw new ProviderError(
            'invalid_response',
            'The provider response exceeded the supported size limit.',
          );
        }
        break;
      }
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonResponse(
  payload: unknown,
  secret: string | undefined,
): CompletionResult {
  const record = asRecord(payload);
  if (record === undefined) {
    throw new ProviderError('invalid_response', 'The provider returned an invalid JSON response.');
  }

  const error = payloadError(record, secret);
  if (error !== undefined) {
    throw error;
  }

  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choice = asRecord(choices[0]);
  if (choice === undefined) {
    throw new ProviderError(
      'invalid_response',
      'The provider response did not contain a completion choice.',
    );
  }

  const message = asRecord(choice.message);
  const text = extractContainerText(message);
  if (text === undefined) {
    throw new ProviderError(
      'invalid_response',
      'The provider response did not contain message text. Tool-call responses are not supported in this release.',
    );
  }

  return {
    text,
    model: readString(record, 'model'),
    finishReason: readString(choice, 'finish_reason'),
    usage: parseUsage(record.usage),
  };
}

async function parseStreamingResponse(
  body: ReadableStream<Uint8Array>,
  secret: string | undefined,
  onDelta: ((delta: string) => void) | undefined,
): Promise<CompletionResult> {
  let text = '';
  let model: string | undefined;
  let finishReason: string | undefined;
  let usage: CompletionUsage | undefined;
  let sawEvent = false;

  for await (const data of parseServerSentEvents(body)) {
    if (data === '[DONE]') {
      break;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new ProviderError(
        'invalid_response',
        'The provider returned malformed streaming data.',
      );
    }

    const record = asRecord(payload);
    if (record === undefined) {
      throw new ProviderError(
        'invalid_response',
        'The provider returned an invalid streaming payload.',
      );
    }

    const error = payloadError(record, secret);
    if (error !== undefined) {
      throw error;
    }

    sawEvent = true;
    model = readString(record, 'model') ?? model;
    usage = parseUsage(record.usage) ?? usage;

    const choices = Array.isArray(record.choices) ? record.choices : [];
    const choice = asRecord(choices[0]);
    if (choice === undefined) {
      continue;
    }

    finishReason = readString(choice, 'finish_reason') ?? finishReason;
    const delta = extractContainerText(asRecord(choice.delta));
    if (delta !== undefined && delta.length > 0) {
      text += delta;
      onDelta?.(delta);
    }
  }

  if (!sawEvent) {
    throw new ProviderError(
      'invalid_response',
      'The provider returned an empty streaming response.',
    );
  }

  return { text, model, finishReason, usage };
}

class OpenAiCompatibleProvider implements AiProvider {
  readonly id = OPENAI_COMPATIBLE_PROVIDER_ID;
  readonly displayName = 'OpenAI-compatible';

  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: OpenAiCompatibleConfig,
    dependencies: OpenAiCompatibleDependencies = {},
  ) {
    this.fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  }

  async complete(
    request: CompletionRequest,
    options: CompletionOptions = {},
  ): Promise<CompletionResult> {
    const validated = validateRequest(request);
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;

    try {
      return await withAbort(
        async (signal) => {
          const response = await this.fetchImpl(buildChatCompletionsUrl(this.config.baseUrl), {
            method: 'POST',
            headers: buildRequestHeaders(this.config.apiKey, validated.stream),
            body: JSON.stringify(buildCompletionBody(validated)),
            signal,
            redirect: 'error',
          });

          if (!response.ok) {
            const errorBody = await readResponseText(
              response,
              MAX_ERROR_BODY_BYTES,
              'truncate',
            );
            throw normalizeHttpError(response.status, errorBody, this.config.apiKey);
          }

          const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
          const useStreaming =
            validated.stream && !contentType.includes('application/json');

          if (useStreaming) {
            if (response.body === null) {
              throw new ProviderError(
                'invalid_response',
                'The provider returned an empty streaming response body.',
              );
            }
            return await parseStreamingResponse(
              response.body,
              this.config.apiKey,
              options.onDelta,
            );
          }

          const responseText = await readResponseText(
            response,
            MAX_JSON_RESPONSE_BYTES,
            'error',
          );

          let payload: unknown;
          try {
            payload = JSON.parse(responseText);
          } catch {
            throw new ProviderError(
              'invalid_response',
              'The provider returned invalid JSON. Check that the endpoint is OpenAI-compatible.',
            );
          }

          return parseJsonResponse(payload, this.config.apiKey);
        },
        { token: options.token, timeoutMs },
      );
    } catch (error) {
      if (isProviderError(error)) {
        throw error;
      }
      throw normalizeThrownError(error, this.config.apiKey);
    }
  }
}

export function createOpenAiCompatibleProvider(
  config: OpenAiCompatibleConfig,
  dependencies: OpenAiCompatibleDependencies = {},
): AiProvider {
  return new OpenAiCompatibleProvider(normalizeConfig(config), dependencies);
}
