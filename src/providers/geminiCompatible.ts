import { validateCredential } from '../security/credential';
import { redactSecrets } from '../security/redact';
import { withAbort } from './cancellation';
import { normalizeBaseUrl } from './endpoint';
import {
  ProviderError,
  isProviderError,
  normalizeHttpError,
  normalizeThrownError,
} from './errors';
import { parseServerSentEvents } from './sse';
import { withProviderRetry } from './retry';
import { userAgent } from './openaiCompatible';
import type {
  AiProvider,
  ChatMessage,
  ChatRole,
  CompletionOptions,
  CompletionRequest,
  CompletionResult,
  CompletionToolCall,
  CompletionUsage,
} from './types';

export const GEMINI_PROVIDER_ID = 'gemini';
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_JSON_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_REQUEST_CHARS = 2_000_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const VALID_ROLES: ReadonlySet<ChatRole> = new Set(['system', 'user', 'assistant', 'tool']);
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type FetchLike = typeof fetch;

export interface GeminiConfig {
  readonly apiKey?: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly stream: boolean;
  readonly baseUrl?: string;
  readonly allowInsecureLocalhost?: boolean;
}

export interface GeminiDependencies {
  readonly fetchImpl?: FetchLike;
}

interface NormalizedGeminiConfig {
  readonly apiKey: string | undefined;
  readonly model: string;
  readonly timeoutMs: number;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly stream: boolean;
  readonly baseUrl: string;
}

function normalizeConfig(config: GeminiConfig): NormalizedGeminiConfig {
  const normalizedConfig = config as unknown as Record<string, unknown>;
  const model = typeof normalizedConfig.model === 'string' ? normalizedConfig.model.trim() : '';
  if (model.length === 0) {
    throw new ProviderError('configuration', 'The provider model name is not configured.');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(model) || model.length > 200) {
    throw new ProviderError('configuration', 'The provider model name is invalid.');
  }
  const timeoutMs =
    typeof normalizedConfig.timeoutMs === 'number' ? normalizedConfig.timeoutMs : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) {
    throw new ProviderError(
      'configuration',
      'The provider request timeout must be between 1000 and 600000 milliseconds.',
    );
  }
  const temperature = config.temperature;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
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
  if (typeof config.stream !== 'boolean') {
    throw new ProviderError('configuration', 'The streaming flag must be a boolean.');
  }
  let apiKey: string | undefined;
  if (typeof config.apiKey === 'string' && config.apiKey.trim().length > 0) {
    apiKey = validateCredential(config.apiKey);
  }
  const allowInsecureLocalhost =
    typeof config.allowInsecureLocalhost === 'boolean' ? config.allowInsecureLocalhost : true;
  let baseUrl = GEMINI_API_BASE;
  if (typeof config.baseUrl === 'string' && config.baseUrl.trim().length > 0) {
    baseUrl = normalizeBaseUrl(config.baseUrl, { allowInsecureLocalhost });
  }
  return {
    apiKey,
    model,
    timeoutMs,
    temperature,
    maxOutputTokens: config.maxOutputTokens,
    stream: config.stream,
    baseUrl: baseUrl.replace(/\/+$/, ''),
  };
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateToolCalls(value: unknown): readonly CompletionToolCall[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ProviderError('configuration', 'Assistant tool calls must be an array.');
  }
  return value.map((call) => {
    if (!isSchemaRecord(call)) {
      throw new ProviderError('configuration', 'The request contains an invalid tool call.');
    }
    const id = typeof call.id === 'string' ? call.id.trim() : '';
    if (id.length === 0 || id.length > 200) {
      throw new ProviderError('configuration', 'A tool call must carry a non-empty id.');
    }
    const name = typeof call.name === 'string' ? call.name.trim() : '';
    if (!TOOL_NAME_PATTERN.test(name)) {
      throw new ProviderError('configuration', 'A tool call must carry a valid tool name.');
    }
    if (!isSchemaRecord(call.arguments)) {
      throw new ProviderError('configuration', 'Tool call arguments must be a JSON object.');
    }
    return { id, name, arguments: call.arguments };
  });
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
  // The Gemini adapter implements the JSON tool-call protocol only. Dropping
  // native definitions silently would misreport what was sent, so refuse them.
  if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length > 0)) {
    throw new ProviderError(
      'configuration',
      'The Gemini adapter does not support native tool definitions. Use the JSON tool-call protocol instead.',
    );
  }
  let totalChars = 0;
  const announcedCallIds = new Set<string>();
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

    if (message.role !== 'assistant' && message.toolCalls !== undefined) {
      throw new ProviderError('configuration', 'Only assistant messages may carry tool calls.');
    }
    if (message.role !== 'tool' && message.toolCallId !== undefined) {
      throw new ProviderError('configuration', 'Only tool messages may carry a tool call id.');
    }

    const toolCalls = message.role === 'assistant' ? validateToolCalls(message.toolCalls) : undefined;
    if (toolCalls !== undefined) {
      for (const call of toolCalls) {
        announcedCallIds.add(call.id);
        totalChars += call.id.length + call.name.length + JSON.stringify(call.arguments).length;
      }
    }

    let toolCallId = '';
    if (message.role === 'tool') {
      toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId.trim() : '';
      if (toolCallId.length === 0) {
        throw new ProviderError(
          'configuration',
          'A tool message must reference the tool call id it answers.',
        );
      }
      if (!announcedCallIds.has(toolCallId)) {
        throw new ProviderError(
          'configuration',
          'A tool message must answer a tool call announced by a preceding assistant message.',
        );
      }
      totalChars += toolCallId.length;
    }

    return {
      role: message.role,
      content: message.content,
      ...(toolCalls !== undefined && toolCalls.length > 0 ? { toolCalls } : {}),
      ...(message.role === 'tool' ? { toolCallId } : {}),
    };
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

export function buildGeminiUrl(model: string, stream: boolean, baseUrl?: string): string {
  const base = (baseUrl ?? GEMINI_API_BASE).trim().replace(/\/+$/, '');
  const normalizedModel = model.trim().replace(/^models\//, '');
  const encoded = encodeURIComponent(normalizedModel);
  if (stream) {
    return `${base}/${encoded}:streamGenerateContent?alt=sse`;
  }
  return `${base}/${encoded}:generateContent`;
}

export function buildGeminiHeaders(apiKey: string | undefined, stream: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': userAgent(),
  };
  if (apiKey !== undefined && apiKey.length > 0) {
    headers['x-goog-api-key'] = apiKey;
  }
  return headers;
}

export function buildGeminiBody(
  request: CompletionRequest,
  defaults: { temperature: number; maxOutputTokens: number },
): Record<string, unknown> {
  const systemTexts: string[] = [];
  const contents: Array<Record<string, unknown>> = [];
  // Gemini has no tool_call_id field, so the JSON tool-call protocol carries the
  // id and tool name in the text instead of dropping the correlation.
  const toolNames = new Map<string, string>();
  for (const message of request.messages) {
    if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        toolNames.set(call.id, call.name);
      }
    }
  }
  for (const message of request.messages) {
    if (message.role === 'system') {
      systemTexts.push(message.content);
    } else if (message.role === 'assistant') {
      const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
      const text =
        message.content.length > 0 || calls.length === 0
          ? message.content
          : JSON.stringify({
              tool_calls: calls.map((call) => ({
                id: call.id,
                name: call.name,
                arguments: call.arguments,
              })),
            });
      contents.push({ role: 'model', parts: [{ text }] });
    } else if (message.role === 'tool') {
      const callId = message.toolCallId ?? 'unknown';
      const name = toolNames.get(callId);
      const label =
        name === undefined ? `Tool result for call ${callId}` : `Tool result for ${name} (call ${callId})`;
      contents.push({ role: 'user', parts: [{ text: `${label}:\n${message.content}` }] });
    } else {
      contents.push({ role: 'user', parts: [{ text: message.content }] });
    }
  }
  const hasNonSystemContent = contents.length > 0;
  if (!hasNonSystemContent) {
    if (systemTexts.length > 0) {
      contents.push({ role: 'user', parts: [{ text: systemTexts.join('\n\n') }] });
    }
  }
  const body: Record<string, unknown> = { contents };
  if (systemTexts.length > 0 && hasNonSystemContent) {
    body.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] };
  }
  const temperature =
    typeof request.temperature === 'number' ? request.temperature : defaults.temperature;
  const maxOutputTokens =
    typeof request.maxOutputTokens === 'number'
      ? request.maxOutputTokens
      : defaults.maxOutputTokens;
  body.generationConfig = { temperature, maxOutputTokens };
  return body;
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

function extractCandidateText(candidate: Record<string, unknown> | undefined): string | undefined {
  const content = asRecord(candidate?.content);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const texts = parts
    .map((part) => readString(asRecord(part), 'text'))
    .filter((text): text is string => text !== undefined);
  if (texts.length === 0) {
    return undefined;
  }
  return texts.join('');
}

function parseGeminiUsage(value: unknown): CompletionUsage | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const promptTokens = readNumber(record, 'promptTokenCount');
  const completionTokens = readNumber(record, 'candidatesTokenCount');
  const totalTokens = readNumber(record, 'totalTokenCount');
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
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
  const errorRecord = asRecord(error);
  const rawMessage =
    typeof error === 'string'
      ? error
      : (readString(errorRecord, 'message') ?? readString(record, 'message'));
  const safe = redactSecrets(
    rawMessage ?? 'The provider returned an unspecified error payload.',
    [secret],
  ).text;
  return new ProviderError('invalid_response', `The provider returned an error: ${safe}`);
}

export function parseGeminiResponse(payload: unknown, secret?: string): CompletionResult {
  const record = asRecord(payload);
  if (record === undefined) {
    throw new ProviderError('invalid_response', 'The provider returned an invalid JSON response.');
  }
  const error = payloadError(record, secret);
  if (error !== undefined) {
    throw error;
  }
  const promptFeedback = asRecord(record.promptFeedback);
  const blockReason = readString(promptFeedback, 'blockReason');
  if (blockReason !== undefined) {
    throw new ProviderError(
      'invalid_response',
      `The provider blocked the request (reason: ${blockReason}).`,
    );
  }
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  const candidate = asRecord(candidates[0]);
  if (candidate === undefined) {
    throw new ProviderError(
      'invalid_response',
      'The provider response did not contain a completion candidate.',
    );
  }
  const text = extractCandidateText(candidate);
  if (text === undefined || text.length === 0) {
    throw new ProviderError(
      'invalid_response',
      'The provider response did not contain completion text.',
    );
  }
  const finishReason = readString(candidate, 'finishReason') ?? 'stop';
  const model = readString(record, 'modelVersion');
  return { text, model, finishReason, usage: parseGeminiUsage(record.usageMetadata) };
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

async function parseStreamingResponse(
  body: ReadableStream<Uint8Array>,
  secret: string | undefined,
  onDelta: ((delta: string) => void) | undefined,
  signal?: AbortSignal,
): Promise<CompletionResult> {
  let text = '';
  let model: string | undefined;
  let finishReason: string | undefined;
  let usage: CompletionUsage | undefined;
  let sawEvent = false;
  for await (const data of parseServerSentEvents(body, { signal })) {
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
      throw new ProviderError('invalid_response', 'The provider returned an invalid streaming payload.');
    }
    const error = payloadError(record, secret);
    if (error !== undefined) {
      throw error;
    }
    sawEvent = true;
    model = readString(record, 'modelVersion') ?? model;
    usage = parseGeminiUsage(record.usageMetadata) ?? usage;
    const candidates = Array.isArray(record.candidates) ? record.candidates : [];
    const candidate = asRecord(candidates[0]);
    if (candidate === undefined) {
      continue;
    }
    finishReason = readString(candidate, 'finishReason') ?? finishReason;
    const delta = extractCandidateText(candidate);
    if (delta !== undefined && delta.length > 0) {
      text += delta;
      onDelta?.(delta);
    }
  }
  if (!sawEvent) {
    throw new ProviderError('invalid_response', 'The provider returned an empty streaming response.');
  }
  if (text.length === 0) {
    throw new ProviderError(
      'invalid_response',
      'The provider response did not contain completion text.',
    );
  }
  return { text, model, finishReason: finishReason ?? 'stop', usage };
}

class GeminiProvider implements AiProvider {
  readonly id = GEMINI_PROVIDER_ID;
  readonly displayName = 'Google Gemini';

  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: NormalizedGeminiConfig,
    dependencies: GeminiDependencies = {},
  ) {
    this.fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  }

  async complete(
    request: CompletionRequest,
    options: CompletionOptions = {},
  ): Promise<CompletionResult> {
    const validated = validateRequest(request);
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    if (this.config.apiKey === undefined || this.config.apiKey.length === 0) {
      throw new ProviderError(
        'authentication',
        'No API key is configured for this provider.',
      );
    }
    try {
      return await withAbort(
        async (signal) => {
          let streamStarted = false;
          return await withProviderRetry(
            async (retrySignal) => {
              const response = await this.fetchImpl(
                buildGeminiUrl(validated.model, validated.stream, this.config.baseUrl),
                {
                  method: 'POST',
                  headers: buildGeminiHeaders(this.config.apiKey, validated.stream),
                  body: JSON.stringify(
                    buildGeminiBody(validated, {
                      temperature: this.config.temperature,
                      maxOutputTokens: this.config.maxOutputTokens,
                    }),
                  ),
                  signal: retrySignal,
                  redirect: 'error',
                },
              );
              if (!response.ok) {
                const errorBody = await readResponseText(response, MAX_ERROR_BODY_BYTES, 'truncate');
                throw normalizeHttpError(response.status, errorBody, this.config.apiKey, response.headers);
              }
              const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
              const useStreaming = validated.stream && !contentType.includes('application/json');
              if (useStreaming) {
                if (response.body === null) {
                  throw new ProviderError(
                    'invalid_response',
                    'The provider returned an empty streaming response body.',
                  );
                }
                const wrappedOnDelta =
                  options.onDelta === undefined
                    ? undefined
                    : (delta: string) => {
                        streamStarted = true;
                        options.onDelta?.(delta);
                      };
                return await parseStreamingResponse(response.body, this.config.apiKey, wrappedOnDelta, retrySignal);
              }
              const responseText = await readResponseText(response, MAX_JSON_RESPONSE_BYTES, 'error');
              let payload: unknown;
              try {
                payload = JSON.parse(responseText);
              } catch {
                throw new ProviderError(
                  'invalid_response',
                  'The provider returned invalid JSON. Check that the endpoint is Gemini-compatible.',
                );
              }
              return parseGeminiResponse(payload, this.config.apiKey);
            },
            { token: options.token, streamStarted: () => streamStarted },
            signal,
          );
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

export function createGeminiProvider(
  config: GeminiConfig,
  dependencies: GeminiDependencies = {},
): AiProvider {
  return new GeminiProvider(normalizeConfig(config), dependencies);
}
