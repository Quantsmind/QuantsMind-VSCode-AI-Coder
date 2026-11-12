/**
 * Shared, bounded context for tasks within a session/run. Subtasks exchange
 * discoveries here (decisions, paths, notes) instead of re-deriving facts.
 * Storage is in-memory and per task; it is lost on restart and never
 * persisted, which keeps secrets and large payloads out of task history.
 */
export const CONTEXT_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
export const MAX_KEY_LENGTH = 64;
export const MAX_VALUE_LENGTH = 2048;
export const MAX_ENTRIES_PER_TASK = 100;
export const MAX_TOTAL_ENTRIES = 1000;
export const MAX_TASKS = 200;

export interface ContextEntry {
  readonly key: string;
  readonly value: string;
  readonly taskId: string;
}

export interface ContextSetResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface ContextListEntry {
  readonly key: string;
  readonly preview: string;
  readonly taskId: string;
}

export class TaskContextStore {
  private readonly tasks = new Map<string, Map<string, string>>();
  private totalEntries = 0;

  private task(taskId: string, create: boolean): Map<string, string> | undefined {
    let entries = this.tasks.get(taskId);
    if (entries === undefined && create) {
      if (this.tasks.size >= MAX_TASKS) {
        const oldest = this.tasks.keys().next().value;
        if (oldest !== undefined) {
          this.totalEntries -= this.tasks.get(oldest)?.size ?? 0;
          this.tasks.delete(oldest);
        }
      }
      entries = new Map<string, string>();
      this.tasks.set(taskId, entries);
    }
    return entries;
  }

  private normalizeTaskId(taskId: unknown): string | undefined {
    const value = String(taskId ?? '').trim();
    return value.length > 0 && value.length <= 128 ? value : undefined;
  }

  set(taskId: unknown, key: unknown, value: unknown): ContextSetResult {
    const task = this.normalizeTaskId(taskId);
    if (task === undefined) {
      return { ok: false, error: 'A task id is required.' };
    }
    const keyValue = String(key ?? '').trim();
    if (!CONTEXT_KEY_PATTERN.test(keyValue)) {
      return { ok: false, error: 'Context keys must match [A-Za-z0-9_.-]{1,64}.' };
    }
    const text = String(value ?? '');
    if (text.length === 0 || text.length > MAX_VALUE_LENGTH) {
      return { ok: false, error: `Context values must be 1-${MAX_VALUE_LENGTH} characters.` };
    }
    const entries = this.task(task, true);
    if (entries === undefined) {
      return { ok: false, error: 'Context store limit reached.' };
    }
    const exists = entries.has(keyValue);
    if (!exists && entries.size >= MAX_ENTRIES_PER_TASK) {
      return { ok: false, error: `This task already has ${MAX_ENTRIES_PER_TASK} context entries.` };
    }
    if (!exists && this.totalEntries >= MAX_TOTAL_ENTRIES) {
      return { ok: false, error: 'The context store is full. Clear some entries first.' };
    }
    if (exists) {
      this.totalEntries -= 1;
    }
    entries.set(keyValue, text);
    this.totalEntries += 1;
    return { ok: true };
  }

  get(taskId: unknown, key: unknown): string | undefined {
    const task = this.normalizeTaskId(taskId);
    if (task === undefined) {
      return undefined;
    }
    const keyValue = String(key ?? '').trim();
    return this.task(task, false)?.get(keyValue);
  }

  has(taskId: unknown, key: unknown): boolean {
    return this.get(taskId, key) !== undefined;
  }

  list(taskId: unknown): readonly ContextListEntry[] {
    const task = this.normalizeTaskId(taskId);
    if (task === undefined) {
      return [];
    }
    const entries = this.task(task, false);
    if (entries === undefined) {
      return [];
    }
    return [...entries.entries()].slice(0, MAX_ENTRIES_PER_TASK).map(([key, value]) => ({
      key,
      preview: value.length > 80 ? `${value.slice(0, 80)}…` : value,
      taskId: task,
    }));
  }

  snapshot(taskId: unknown): Readonly<Record<string, string>> {
    const task = this.normalizeTaskId(taskId);
    if (task === undefined) {
      return {};
    }
    const entries = this.task(task, false);
    return entries === undefined ? {} : Object.fromEntries(entries);
  }

  clear(taskId?: unknown): void {
    if (taskId === undefined) {
      this.tasks.clear();
      this.totalEntries = 0;
      return;
    }
    const task = this.normalizeTaskId(taskId);
    if (task === undefined) {
      return;
    }
    this.totalEntries -= this.tasks.get(task)?.size ?? 0;
    this.tasks.delete(task);
  }
}

/**
 * Agent tools for the shared context. Read tools are unrestricted; writes are
 * bounded and never require approval because no user data leaves the machine
 * and nothing on disk is modified.
 */
export function contextTools(store: TaskContextStore): readonly import('./codingAgent').AgentTool[] {
  const ok = (tool: string, output: unknown) => ({
    ok: true,
    tool,
    output: JSON.stringify(output, null, 2),
    durationMs: 0,
  });
  return [
    {
      name: 'context_set',
      description: 'Store a small note shared with subtasks of the current task (decisions, discovered paths, constraints). In-memory only.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          taskId: { type: 'string' },
        },
        required: ['key', 'value'],
      },
      async execute(args) {
        const result = store.set(args.taskId ?? 'agent', args.key, args.value);
        return result.ok ? ok('context_set', { stored: args.key }) : { ok: false, tool: 'context_set', error: result.error, durationMs: 0 };
      },
    },
    {
      name: 'context_get',
      description: 'Read a note stored by this task or its subtasks.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          taskId: { type: 'string' },
        },
        required: ['key'],
      },
      async execute(args) {
        const value = store.get(args.taskId ?? 'agent', args.key);
        return value === undefined
          ? { ok: false, tool: 'context_get', error: 'No context entry for that key.', durationMs: 0 }
          : ok('context_get', { key: args.key, value });
      },
    },
    {
      name: 'context_list',
      description: 'List the keys and previews of the shared context for a task.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
        },
      },
      async execute(args) {
        return ok('context_list', { entries: store.list(args.taskId ?? 'agent') });
      },
    },
  ];
}
