import { runApprovedCommand, type CommandResult } from '../commands/runner';
import type { Diagnostic } from '../agent/models';

export type ExecutionKind = 'command' | 'build' | 'test';
export type ExecutionStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed-out';

/** One completed or in-progress unit of work, kept for the lifetime of the extension host. */
export interface ExecutionRecord {
  readonly id: string;
  readonly kind: ExecutionKind;
  readonly taskId?: string;
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly status: ExecutionStatus;
  readonly exitCode: number | null;
  readonly output: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly error?: string;
  readonly diagnostics?: readonly Diagnostic[];
  readonly tests?: ExecutionTestCounts;
}

export interface ExecutionTestCounts {
  readonly passed?: number;
  readonly failed?: number;
  readonly skipped?: number;
  readonly total?: number;
  readonly durationMs?: number;
}

export interface ExecutionRunOptions {
  readonly kind: ExecutionKind;
  readonly taskId?: string;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly allowlist: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputChars?: number;
  readonly secret?: string;
  readonly trusted: boolean;
  readonly signal?: AbortSignal;
  readonly diagnostics?: readonly Diagnostic[];
  readonly tests?: ExecutionTestCounts;
}

/** Wire a single external signal into the per-execution controller. */
function linkSignal(external: AbortSignal | undefined, controller: AbortController): () => void {
  if (external === undefined) {
    return () => undefined;
  }
  const onAbort = (): void => controller.abort();
  if (external.aborted) {
    onAbort();
    return () => external.removeEventListener('abort', onAbort);
  }
  external.addEventListener('abort', onAbort, { once: true });
  return () => external.removeEventListener('abort', onAbort);
}

function statusOf(result: CommandResult): ExecutionStatus {
  if (result.cancelled) {
    return 'cancelled';
  }
  if (result.timedOut) {
    return 'timed-out';
  }
  return result.exitCode === 0 && result.error === undefined ? 'succeeded' : 'failed';
}

/**
 * Tracks a bounded, in-memory history of approved executions for the current
 * task and extension host. The service owns validation, cancellation, timeout
 * and output capture through the existing allowlisted runner; it does not
 * itself approve or execute anything outside that policy.
 */
export class ExecutionService {
  private readonly maxEntries: number;
  private records: ExecutionRecord[] = [];
  private sequence = 0;
  private readonly active = new Map<string, AbortController>();
  private readonly listeners = new Set<(record: ExecutionRecord) => void>();

  constructor(maxEntries = 50) {
    this.maxEntries = Math.max(10, Math.min(maxEntries, 500));
  }

  /** Newest-first records, capped at {@link maxEntries}. */
  list(): readonly ExecutionRecord[] {
    return [...this.records].reverse();
  }

  historyForTask(taskId: string | undefined): readonly ExecutionRecord[] {
    return this.records.filter((record) => record.taskId === taskId);
  }

  isRunning(): boolean {
    return this.active.size > 0;
  }

  runningIds(): readonly string[] {
    return [...this.active.keys()];
  }

  /** Cancel a specific execution. Returns true when a run was signalled. */
  cancel(id: string): boolean {
    const controller = this.active.get(id);
    if (controller === undefined) {
      return false;
    }
    controller.abort();
    return true;
  }

  /** Cancel every in-flight execution (used when the session is cancelled). */
  cancelAll(): void {
    for (const controller of [...this.active.values()]) {
      controller.abort();
    }
  }

  /** Merge diagnostics or test counts into a recorded execution. */
  update(
    id: string,
    patch: { readonly diagnostics?: readonly Diagnostic[]; readonly tests?: ExecutionTestCounts },
  ): ExecutionRecord | undefined {
    const current = this.records.find((record) => record.id === id);
    if (current === undefined) {
      return undefined;
    }
    const updated: ExecutionRecord = {
      ...current,
      ...(patch.diagnostics !== undefined ? { diagnostics: patch.diagnostics } : {}),
      ...(patch.tests !== undefined ? { tests: patch.tests } : {}),
    };
    this.upsert(updated);
    this.emit(updated);
    return updated;
  }

  subscribe(listener: (record: ExecutionRecord) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private emit(record: ExecutionRecord): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(record);
      } catch {
        // Observers must not break execution; the record still lands in the list.
      }
    }
  }

  private activeRecords(): readonly ExecutionRecord[] {
    return this.records.filter((record) => record.status === 'running');
  }

  private upsert(record: ExecutionRecord): void {
    const index = this.records.findIndex((candidate) => candidate.id === record.id);
    if (index >= 0) {
      this.records[index] = record;
      return;
    }
    this.records.push(record);
    while (this.records.length > this.maxEntries) {
      const dropped = this.records.shift();
      if (dropped !== undefined) {
        this.records = this.records.filter((entry) => entry.id !== dropped.id);
      }
    }
  }

  /**
   * Runs exactly one allowlisted command through the existing runner, records
   * it in the bounded history, and returns the finished record. Approval is
   * the caller's responsibility (command tools apply the allowlist + modal
   * before invoking this).
   */
  async run(raw: string, options: ExecutionRunOptions): Promise<ExecutionRecord> {
    const id = `exec-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
    const startedAt = new Date().toISOString();
    const trimmedCommand = raw.trim();
    // Duplicate protection: never run the same invocation twice concurrently in the same directory.
    for (const active of this.activeRecords()) {
      if (active.command === trimmedCommand && active.cwd === options.cwd) {
        const blocked: ExecutionRecord = {
          id,
          kind: options.kind,
          ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
          command: trimmedCommand,
          cwd: options.cwd,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: 0,
          status: 'failed',
          exitCode: null,
          output: '',
          truncated: false,
          timedOut: false,
          cancelled: false,
          error: 'The same command is already running in this workspace.',
        };
        this.upsert(blocked);
        this.emit(blocked);
        return blocked;
      }
    }
    const base: ExecutionRecord = {
      id,
      kind: options.kind,
      ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
      command: raw.trim(),
      cwd: options.cwd,
      startedAt,
      status: 'running',
      exitCode: null,
      output: '',
      truncated: false,
      timedOut: false,
      cancelled: false,
    };
    const controller = new AbortController();
    const unlink = linkSignal(options.signal, controller);
    this.active.set(id, controller);
    this.upsert(base);
    this.emit(base);

    try {
      const result = await runApprovedCommand(raw, {
        cwd: options.cwd,
        workspaceRoot: options.workspaceRoot,
        allowlist: options.allowlist,
        timeoutMs: options.timeoutMs,
        maxOutputChars: options.maxOutputChars,
        secret: options.secret,
        trusted: options.trusted,
        signal: controller.signal,
      });
      const finished: ExecutionRecord = {
        ...base,
        finishedAt: new Date().toISOString(),
        durationMs: result.durationMs,
        status: statusOf(result),
        exitCode: result.exitCode,
        output: result.output,
        truncated: result.truncated,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        error: result.error,
        ...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
        ...(options.tests !== undefined ? { tests: options.tests } : {}),
      };
      this.upsert(finished);
      this.emit(finished);
      return finished;
    } finally {
      this.active.delete(id);
      unlink();
    }
  }
}
