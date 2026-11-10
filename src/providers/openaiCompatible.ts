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
  CompletionToolCall,
  CompletionToolDefinition,
  CompletionUsage,
} from './types';

export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';

const USER_AGENT_PRODUCT = 'QuantsMind-VSCode-AI-Coder';
let userAgentVersion = 'dev';

/**
 * Activation sets this from the manifest version. Keeping it out of a literal is
 * deliberate: a pinned string silently ships the previous release's version in
 * every request header after a bump.
 */
export function setUserAgentVersion(version: string): void {
  userAgentVersion = version;
}

export function userAgent(): string {
  return `${USER_AGENT_PRODUCT}/${userAgentVersion}`;
}

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_JSON_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_REQUEST_CHARS = 2_000_000;
const VALID_ROLES: ReadonlySet<ChatRole> = new Set(['system', 'user', 'assistant', 'tool']);
const MAX_TOOL_DEFINITIONS = 128;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

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

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateToolDefinitions(tools: unknown): readonly CompletionToolDefinition[] | undefined {
  if (tools === undefined) {
    return undefined;
  }
  if (!Array.isArray(tools)) {
    throw new ProviderError('configuration', 'Tool definitions must be an array.');
  }
  if (tools.length > MAX_TOOL_DEFINITIONS) {
    throw new ProviderError(
      'configuration',
      `The request declares too many tools (maximum ${MAX_TOOL_DEFINITIONS}).`,
    );
  }
  const seen = new Set<string>();
  return tools.map((tool) => {
    if (!isSchemaRecord(tool)) {
      throw new ProviderError('configuration', 'The request contains an invalid tool definition.');
    }
    const name = typeof tool.name === 'string' ? tool.name : '';
    if (!TOOL_NAME_PATTERN.test(name)) {
      throw new ProviderError(
        'configuration',
        'Tool names must use 1-64 characters from A-Z, a-z, 0-9, underscore or hyphen.',
      );
    }
    if (seen.has(name)) {
      throw new ProviderError('configuration', 'Tool definitions must have unique names.');
    }
    seen.add(name);
    if (!isSchemaRecord(tool.parameters)) {
      throw new ProviderError('configuration', 'Tool parameters must be a JSON schema object.');
    }
    return {
      name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: tool.parameters,
    };
  });
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

  const tools = validateToolDefinitions(request.tools);
  let totalChars = tools === undefined ? 0 : JSON.stringify(tools).length;
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
    ...(tools !== undefined ? { tools } : {}),
  };
}

export function buildCompletionBody(request: CompletionRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map((message) => {
      const result: Record<string, unknown> = {
        role: message.role,
        content: message.content,
      };
      if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
        result.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        }));
      }
      if (message.role === 'tool' && typeof message.toolCallId === 'string') {
        result.tool_call_id = message.toolCallId;
      }
      return result;
    }),
    stream: request.stream,
  };

  if (typeof request.temperature === 'number') {
    body.temperature = request.temperature;
  }
  if (typeof request.maxOutputTokens === 'number') {
    body.max_tokens = request.maxOutputTokens;
  }
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    body.tool_choice = 'auto';
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
    'User-Agent': userAgent(),
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

function parseToolCalls(value: unknown, secret: string | undefined): CompletionToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const calls: CompletionToolCall[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === undefined) {
      continue;
    }
    const nested = asRecord(record.function);
    const name = readString(record, 'name') ?? readString(nested, 'name');
    if (name === undefined || name.trim().length === 0) {
      continue;
    }
    const rawArguments = record.arguments ?? nested?.arguments;
    let args: Record<string, unknown> = {};
    if (typeof rawArguments === 'string') {
      try {
        const parsed = JSON.parse(rawArguments);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = { raw: rawArguments };
      }
    } else if (typeof rawArguments === 'object' && rawArguments !== null && !Array.isArray(rawArguments)) {
      args = rawArguments as Record<string, unknown>;
    }
    calls.push({
      id: readString(record, 'id') ?? `tool-call-${calls.length + 1}`,
      name: name.trim(),
      arguments: args,
    });
  }
  // secret is retained for signature compatibility; arguments are parsed as data.
  void secret;
  return calls;
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
  const toolCalls = parseToolCalls(message?.tool_calls, secret);
  const text = extractContainerText(message);
  if (text === undefined && toolCalls.length === 0) {
    throw new ProviderError(
      'invalid_response',
      'The provider response did not contain message text.',
    );
  }

  return {
    text: text ?? '',
    model: readString(record, 'model'),
    finishReason: readString(choice, 'finish_reason'),
    usage: parseUsage(record.usage),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
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
  const streamedToolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();

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
    const deltaRecord = asRecord(choice.delta);
    const delta = extractContainerText(deltaRecord);
    if (delta !== undefined && delta.length > 0) {
      text += delta;
      onDelta?.(delta);
    }

    const rawToolCalls = Array.isArray(deltaRecord?.tool_calls) ? deltaRecord.tool_calls : [];
    for (const raw of rawToolCalls) {
      const record = asRecord(raw);
      if (record === undefined) {
        continue;
      }
      const index = typeof record.index === 'number' ? record.index : streamedToolCalls.size;
      const existing = streamedToolCalls.get(index) ?? { arguments: '' };
      if (typeof record.id === 'string') {
        existing.id = record.id;
      }
      const fn = asRecord(record.function);
      if (typeof fn?.name === 'string') {
        existing.name = fn.name;
      }
      const args = fn?.arguments;
      if (typeof args === 'string') {
        existing.arguments += args;
      }
      streamedToolCalls.set(index, existing);
    }
  }

  if (!sawEvent) {
    throw new ProviderError(
      'invalid_response',
      'The provider returned an empty streaming response.',
    );
  }

  const accumulatedToolCalls = [...streamedToolCalls.values()].map((call, index) => ({
    id: call.id ?? `tool-call-${index + 1}`,
    type: 'function',
    function: {
      name: call.name ?? '',
      arguments: call.arguments,
    },
  }));
  const toolCalls = parseToolCalls(accumulatedToolCalls, secret);

  return {
    text,
    model,
    finishReason,
    usage,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
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
            throw normalizeHttpError(response.status, errorBody, this.config.apiKey, response.headers);
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
