// Agent runtime for QuantsMind. Provider and workspace integrations are injected
// by callers; this module intentionally has no VS Code dependency.

export interface AgentToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface AgentToolResult {
  readonly ok: boolean;
  readonly tool: string;
  readonly output?: string;
  readonly error?: string;
  readonly durationMs: number;
}

export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  execute(args: Readonly<Record<string, unknown>>): Promise<AgentToolResult>;
}

export interface AgentToolRegistryLike {
  get(name: string): AgentTool | undefined;
  list(): readonly AgentTool[];
  execute(call: AgentToolCall): Promise<AgentToolResult>;
}

export class AgentToolRegistry implements AgentToolRegistryLike {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    if (tool.name.trim().length === 0) {
      throw new Error('Tool name must not be empty.');
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  list(): readonly AgentTool[] {
    return [...this.tools.values()];
  }

  async execute(call: AgentToolCall): Promise<AgentToolResult> {
    const startedAt = Date.now();
    const tool = this.tools.get(call.name);
    if (tool === undefined) {
      return {
        ok: false,
        tool: call.name,
        error: `Unknown tool "${call.name}".`,
        durationMs: Date.now() - startedAt,
      };
    }
    if (typeof call.arguments !== 'object' || call.arguments === null || Array.isArray(call.arguments)) {
      return {
        ok: false,
        tool: call.name,
        error: 'Tool arguments must be a JSON object.',
        durationMs: Date.now() - startedAt,
      };
    }
    try {
      return await tool.execute(call.arguments);
    } catch (error) {
      return {
        ok: false,
        tool: call.name,
        error: error instanceof Error ? error.message : 'Tool execution failed.',
        durationMs: Date.now() - startedAt,
      };
    }
  }
}

export interface NormalizedModelResponse {
  readonly text: string;
  readonly toolCalls: readonly AgentToolCall[];
  readonly finishReason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readToolCall(value: unknown, index: number): AgentToolCall | undefined {
  const record = isRecord(value) ? value : undefined;
  if (record === undefined) {
    return undefined;
  }
  const nested = isRecord(record.function) ? record.function : undefined;
  const name =
    (typeof record.name === 'string' && record.name.trim().length > 0
      ? record.name.trim()
      : undefined) ??
    (typeof nested?.name === 'string' && nested.name.trim().length > 0
      ? nested.name.trim()
      : undefined);
  if (name === undefined) {
    return undefined;
  }
  const rawArguments =
    record.arguments ?? record.args ?? record.parameters ?? nested?.arguments;
  let args: Record<string, unknown> = {};
  if (typeof rawArguments === 'string') {
    try {
      const parsed = JSON.parse(rawArguments);
      if (isRecord(parsed)) {
        args = parsed;
      }
    } catch {
      return undefined;
    }
  } else if (isRecord(rawArguments)) {
    args = rawArguments;
  } else if (rawArguments !== undefined) {
    return undefined;
  }
  return {
    id: typeof record.id === 'string' && record.id.length > 0 ? record.id : `tool-call-${index + 1}`,
    name,
    arguments: args,
  };
}

function extractJsonCandidate(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced !== null ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return undefined;
  }
  return candidate.slice(start, end + 1);
}

export function parseToolCallsFromText(text: string): readonly AgentToolCall[] {
  const candidate = extractJsonCandidate(text);
  if (candidate === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return [];
  }
  const records: unknown[] = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) &&
        (Array.isArray(parsed.tool_calls) ||
          Array.isArray(parsed.tools) ||
          Array.isArray(parsed.calls))
      ? ((parsed.tool_calls ?? parsed.tools ?? parsed.calls) as unknown[])
      : isRecord(parsed) && (parsed.name !== undefined || parsed.function !== undefined)
        ? [parsed]
        : [];
  const calls: AgentToolCall[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const call = readToolCall(records[index], index);
    if (call !== undefined) {
      calls.push(call);
    }
  }
  return calls;
}

export function normalizeModelResponse(result: {
  readonly text?: string;
  readonly toolCalls?: readonly AgentToolCall[];
  readonly finishReason?: string;
}): NormalizedModelResponse {
  const text = typeof result.text === 'string' ? result.text : '';
  const nativeCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  const parsedCalls = nativeCalls.length > 0 ? [] : parseToolCallsFromText(text);
  return {
    text,
    toolCalls: nativeCalls.length > 0 ? nativeCalls : parsedCalls,
    finishReason: result.finishReason,
  };
}

export interface AgentModelResponse {
  readonly text: string;
  readonly toolCalls?: readonly AgentToolCall[];
  readonly finishReason?: string;
}

export interface AgentModelClient {
  complete(
    messages: readonly { role: string; content: string }[],
    options?: { readonly tools?: readonly AgentTool[]; readonly signal?: AbortSignal },
  ): Promise<AgentModelResponse>;
}

export interface AgentRunEvent {
  readonly type: 'start' | 'model' | 'tool' | 'final' | 'error' | 'cancelled' | 'limit';
  readonly message: string;
  readonly iteration?: number;
  readonly tool?: string;
  readonly ok?: boolean;
  readonly output?: string;
}

export interface AgentRunResult {
  readonly status: 'completed' | 'cancelled' | 'limit' | 'error';
  readonly finalText: string;
  readonly iterations: number;
  readonly toolResults: readonly AgentToolResult[];
  readonly messages: readonly { role: string; content: string }[];
}

export interface RunCodingAgentOptions {
  readonly task: string;
  readonly model: AgentModelClient;
  readonly tools: readonly AgentTool[];
  readonly maxIterations?: number;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: AgentRunEvent) => void;
  readonly systemPrompt?: string;
}

const DEFAULT_SYSTEM_PROMPT = `You are QuantsMind AI Coder, a coding agent with access to workspace tools.

Use tools only when they are needed to inspect or change the workspace. When you need a tool, respond with JSON only:
{"tool_calls":[{"name":"tool_name","arguments":{"key":"value"}}]}

When you have enough information, respond with JSON only:
{"final":"your final answer"}

Mutation rules:
- Use prepare_file_change to propose changes. Nothing is written until apply_prepared_change is approved.
- Use run_validation_command after applying changes.
- If validation fails, analyze the returned output and propose a repair with prepare_file_change.
- Use undo_file_change to restore a failed or unwanted change set.
- Never claim that files were modified unless an apply tool succeeded.`;

export async function runCodingAgent(options: RunCodingAgentOptions): Promise<AgentRunResult> {
  const maxIterations = Math.max(1, Math.min(options.maxIterations ?? 8, 32));
  const tools = options.tools;
  const registry = new AgentToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }
  const toolDescriptions = tools
    .map((tool) => `- ${tool.name}: ${tool.description}\n  parameters: ${JSON.stringify(tool.parameters)}`)
    .join('\n');
  const systemPrompt =
    options.systemPrompt ??
    `${DEFAULT_SYSTEM_PROMPT}\n\nAvailable tools:\n${toolDescriptions || '(none)'}`;

  const messages: import('../providers/types').ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: options.task },
  ];
  const toolResults: AgentToolResult[] = [];
  options.onEvent?.({ type: 'start', message: 'Starting coding agent.', iteration: 0 });

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (options.signal?.aborted) {
      options.onEvent?.({ type: 'cancelled', message: 'Cancelled before model request.', iteration });
      return { status: 'cancelled', finalText: '', iterations: iteration - 1, toolResults, messages };
    }

    let response: AgentModelResponse;
    try {
      response = await options.model.complete(messages, {
        tools,
        signal: options.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Model request failed.';
      options.onEvent?.({ type: 'error', message, iteration });
      return { status: 'error', finalText: message, iterations: iteration, toolResults, messages };
    }

    const normalized = normalizeModelResponse(response);
    options.onEvent?.({ type: 'model', message: normalized.text || 'Model returned tool calls.', iteration });

    if (normalized.toolCalls.length === 0) {
      let finalText = normalized.text.trim();
      try {
        const candidate = extractJsonCandidate(finalText);
        if (candidate !== undefined) {
          const parsed = JSON.parse(candidate);
          if (isRecord(parsed) && typeof parsed.final === 'string') {
            finalText = parsed.final.trim();
          }
        }
      } catch {
        // Keep the raw model text when it is not a final-answer envelope.
      }
      options.onEvent?.({ type: 'final', message: finalText, iteration });
      return { status: 'completed', finalText, iterations: iteration, toolResults, messages };
    }

    messages.push({
      role: 'assistant',
      content: normalized.text.trim(),
      toolCalls: normalized.toolCalls,
    });

    for (const call of normalized.toolCalls) {
      if (options.signal?.aborted) {
        options.onEvent?.({ type: 'cancelled', message: 'Cancelled before tool execution.', iteration });
        return { status: 'cancelled', finalText: '', iterations: iteration, toolResults, messages };
      }
      const result = await registry.execute(call);
      toolResults.push(result);
      options.onEvent?.({
        type: 'tool',
        message: result.ok ? `Tool ${call.name} succeeded.` : `Tool ${call.name} failed: ${result.error ?? 'unknown error'}`,
        iteration,
        tool: call.name,
        ok: result.ok,
        output: result.output,
      });
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify(
          {
            ok: result.ok,
            output: result.output,
            error: result.error,
            durationMs: result.durationMs,
          },
          null,
          2,
        ),
      });
    }
  }

  options.onEvent?.({ type: 'limit', message: 'Iteration limit reached.', iteration: maxIterations });
  return {
    status: 'limit',
    finalText: '',
    iterations: maxIterations,
    toolResults,
    messages,
  };
}

export const CodingAgent = {
  run: runCodingAgent,
};
