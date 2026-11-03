import { redactSecrets } from '../security/redact';
import {
  clampText,
  type IToolRouter,
  type ToolExecutionResult,
  type ToolKind,
  type ToolRequest,
} from './models';

export interface ToolHandlerResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly output?: string;
}

export type ToolHandler = (request: ToolRequest) => Promise<ToolHandlerResult>;

const TOOL_KINDS: readonly ToolKind[] = [
  'read-file',
  'list-files',
  'apply-change-set',
  'run-command',
  'collect-diagnostics',
];

function validRequest(value: ToolRequest): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 80 &&
    TOOL_KINDS.includes(value.kind) &&
    typeof value.payload === 'object' &&
    value.payload !== null &&
    !Array.isArray(value.payload) &&
    typeof value.requestedAt === 'string'
  );
}

/**
 * Local tool router. No handler is registered by default for write or execute
 * kinds, and no model response can reach it. A missing handler fails closed.
 */
export class ToolRouter implements IToolRouter {
  private readonly handlers = new Map<ToolKind, ToolHandler>();

  register(kind: ToolKind, handler: ToolHandler): void {
    this.handlers.set(kind, handler);
  }

  unregister(kind: ToolKind): void {
    this.handlers.delete(kind);
  }

  registeredKinds(): ToolKind[] {
    return [...this.handlers.keys()];
  }

  async route(request: ToolRequest): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    if (!validRequest(request)) {
      return {
        requestId: typeof request?.id === 'string' ? request.id : 'invalid',
        ok: false,
        detail: 'The tool request is malformed.',
        durationMs: Date.now() - startedAt,
      };
    }
    const handler = this.handlers.get(request.kind);
    if (handler === undefined) {
      return {
        requestId: request.id,
        ok: false,
        detail: `No handler is registered for ${request.kind}.`,
        durationMs: Date.now() - startedAt,
      };
    }
    try {
      const result = await handler(request);
      return {
        requestId: request.id,
        ok: result.ok,
        detail: clampText(redactSecrets(result.detail, []).text, 2_000),
        output:
          result.output !== undefined
            ? clampText(redactSecrets(result.output, []).text, 20_000)
            : undefined,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        requestId: request.id,
        ok: false,
        detail: clampText(
          redactSecrets(error instanceof Error ? error.message : 'The tool failed.', []).text,
          2_000,
        ),
        durationMs: Date.now() - startedAt,
      };
    }
  }
}

export function isKnownToolKind(value: unknown): value is ToolKind {
  return typeof value === 'string' && TOOL_KINDS.includes(value as ToolKind);
}
