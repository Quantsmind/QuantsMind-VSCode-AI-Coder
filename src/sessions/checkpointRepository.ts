import {
  CHECKPOINT_SCHEMA_VERSION,
  clampText,
} from '../agent/models';
import type {
  AppliedFile,
  CheckpointStatus,
  CheckpointTaskResult,
  ExecutionCheckpoint,
  ExecutionTaskResult,
  TaskStatus,
} from '../agent/models';

export const CHECKPOINT_STORAGE_KEY = 'quantsmind.execution.checkpoints.v1';

export interface CheckpointKeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface CheckpointRepositoryLogger {
  warn(message: string): void;
  info?(message: string): void;
}

const MAX_CHECKPOINTS_PER_EXECUTION = 50;
const MAX_TOTAL_CHECKPOINTS = 250;
const MAX_TASK_IDS = 200;
const MAX_TASK_RESULTS = 200;
const MAX_REFERENCE_IDS = 200;

const CHECKPOINT_STATUSES: readonly CheckpointStatus[] = [
  'created',
  'valid',
  'restoring',
  'restored',
  'invalid',
];

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown, max = 256): string | undefined {
  return typeof value === 'string' && value.length > 0 ? clampText(value, max) : undefined;
}

function iso(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 60) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : value;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown, max: number): string[] {
  return arrayOf(value)
    .slice(0, max)
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .map((item) => clampText(item, 256));
}

const TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  'blocked',
  'running',
  'awaiting-approval',
  'applied',
  'validation-failed',
  'repairing',
  'completed',
  'failed',
  'skipped',
  'cancelled',
];

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

function sanitizeTaskResult(raw: unknown): CheckpointTaskResult | undefined {
  const record = recordOf(raw);
  if (record === undefined) {
    return undefined;
  }
  const taskId = str(record.taskId, 128);
  const status = record.status;
  if (taskId === undefined || !isTaskStatus(status)) {
    return undefined;
  }
  return {
    taskId,
    status,
    attempts:
      typeof record.attempts === 'number' && Number.isFinite(record.attempts)
        ? Math.floor(record.attempts)
        : undefined,
    summary: str(record.summary, 1_000),
    error: str(record.error, 2_000),
    completedAt: iso(record.completedAt),
  };
}

function sanitizeExecutionTaskResult(raw: unknown): ExecutionTaskResult | undefined {
  const record = recordOf(raw);
  if (record === undefined) {
    return undefined;
  }
  const taskId = str(record.taskId, 128);
  const status = record.status;
  if (taskId === undefined || !isTaskStatus(status)) {
    return undefined;
  }
  return {
    taskId,
    status,
    attempts:
      typeof record.attempts === 'number' && Number.isFinite(record.attempts)
        ? Math.floor(record.attempts)
        : 0,
    startedAt: iso(record.startedAt),
    finishedAt: iso(record.finishedAt),
    changeSetId: str(record.changeSetId, 128),
    validationRunId: str(record.validationRunId, 128),
    historyTaskId: str(record.historyTaskId, 128),
    repairProposalId: str(record.repairProposalId, 128),
    appliedFiles: sanitizeAppliedFiles(record.appliedFiles),
    error: str(record.error, 2_000),
  };
}

function sanitizeAppliedFile(raw: unknown): AppliedFile | undefined {
  const record = recordOf(raw);
  if (record === undefined) {
    return undefined;
  }
  const path = str(record.path, 512);
  const hash = str(record.hash, 64);
  const kind = record.kind;
  if (
    path === undefined ||
    hash === undefined ||
    (kind !== 'create' && kind !== 'modify' && kind !== 'delete' && kind !== 'rename')
  ) {
    return undefined;
  }
  return { path, hash, kind };
}

function sanitizeAppliedFiles(raw: unknown): AppliedFile[] {
  return arrayOf(raw)
    .map(sanitizeAppliedFile)
    .filter((file): file is AppliedFile => file !== undefined);
}

export function sanitizeCheckpoint(raw: unknown): ExecutionCheckpoint | undefined {
  const record = recordOf(raw);
  if (record === undefined) {
    return undefined;
  }
  const id = str(record.id, 128);
  const sessionId = str(record.sessionId, 128);
  const executionId = str(record.executionId, 128);
  const planId = str(record.planId, 256);
  const planVersion =
    typeof record.planVersion === 'string' ? clampText(record.planVersion, 256) : undefined;
  const createdAt = iso(record.createdAt);
  const status = record.status;
  if (
    id === undefined ||
    sessionId === undefined ||
    executionId === undefined ||
    planId === undefined ||
    planVersion === undefined ||
    createdAt === undefined ||
    typeof status !== 'string' ||
    !(CHECKPOINT_STATUSES as readonly string[]).includes(status)
  ) {
    return undefined;
  }
  const sequence = num(record.sequence);
  if (sequence <= 0) {
    return undefined;
  }
  const schemaVersion =
    typeof record.schemaVersion === 'number' && Number.isFinite(record.schemaVersion)
      ? Math.floor(record.schemaVersion)
      : CHECKPOINT_SCHEMA_VERSION;
  if (schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    return undefined;
  }
  return {
    id,
    sessionId,
    executionId,
    sequence,
    planId,
    planVersion,
    currentTaskId: str(record.currentTaskId, 128),
    completedTaskIds: stringArray(record.completedTaskIds, MAX_TASK_IDS),
    pendingTaskIds: stringArray(record.pendingTaskIds, MAX_TASK_IDS),
    failedTaskIds: stringArray(record.failedTaskIds, MAX_TASK_IDS),
    blockedTaskIds: stringArray(record.blockedTaskIds, MAX_TASK_IDS),
    taskResults: arrayOf(record.taskResults)
      .slice(0, MAX_TASK_RESULTS)
      .map(sanitizeTaskResult)
      .filter((result): result is CheckpointTaskResult => result !== undefined),
    pendingApprovalIds: stringArray(record.pendingApprovalIds, MAX_REFERENCE_IDS),
    changeSetIds: stringArray(record.changeSetIds, MAX_REFERENCE_IDS),
    appliedChangeIds: stringArray(record.appliedChangeIds, MAX_REFERENCE_IDS),
    validationRunIds: stringArray(record.validationRunIds, MAX_REFERENCE_IDS),
    executionResults: arrayOf(record.executionResults)
      .slice(0, MAX_TASK_RESULTS)
      .map(sanitizeExecutionTaskResult)
      .filter((result): result is ExecutionTaskResult => result !== undefined),
    repositoryStateRef: str(record.repositoryStateRef, 512),
    createdAt,
    status: status as CheckpointStatus,
    schemaVersion,
    integrity: str(record.integrity, 256),
    recoveryVersion:
      typeof record.recoveryVersion === 'number' && Number.isFinite(record.recoveryVersion)
        ? Math.max(0, Math.floor(record.recoveryVersion))
        : undefined,
  };
}

export class CheckpointRepository {
  private cache: ExecutionCheckpoint[] | undefined;

  constructor(
    private readonly store: CheckpointKeyValueStore,
    private readonly logger: CheckpointRepositoryLogger = { warn: () => undefined },
  ) {}

  private loadRaw(): ExecutionCheckpoint[] {
    if (this.cache !== undefined) {
      return this.cache;
    }
    const stored = this.store.get<unknown>(CHECKPOINT_STORAGE_KEY);
    let raw: readonly unknown[] = [];
    if (Array.isArray(stored)) {
      raw = stored;
    } else {
      const envelope = recordOf(stored);
      if (envelope !== undefined && Array.isArray(envelope.checkpoints)) {
        raw = envelope.checkpoints;
      }
    }
    const sanitized = raw
      .map(sanitizeCheckpoint)
      .filter((checkpoint): checkpoint is ExecutionCheckpoint => checkpoint !== undefined);
    this.cache = sanitized.slice(-MAX_TOTAL_CHECKPOINTS);
    return this.cache;
  }

  private persist(items: readonly ExecutionCheckpoint[]): void {
    const bounded = items.slice(-MAX_TOTAL_CHECKPOINTS);
    this.cache = [...bounded];
    void this.store.update(CHECKPOINT_STORAGE_KEY, {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      checkpoints: bounded,
    });
  }

  async save(checkpoint: ExecutionCheckpoint): Promise<void> {
    const sanitized = sanitizeCheckpoint(checkpoint);
    if (sanitized === undefined) {
      this.logger.warn('checkpoint save rejected: invalid checkpoint');
      throw new Error('Invalid checkpoint.');
    }
    const items = [...this.loadRaw()];
    const existingIndex = items.findIndex((item) => item.id === sanitized.id);
    if (existingIndex >= 0) {
      items[existingIndex] = sanitized;
    } else {
      const executionItems = items.filter((item) => item.executionId === sanitized.executionId);
      const maxSequence = executionItems.reduce(
        (max, item) => Math.max(max, item.sequence),
        0,
      );
      if (sanitized.sequence <= maxSequence && executionItems.length > 0) {
        this.logger.warn('checkpoint save rejected: non-increasing sequence');
        throw new Error('Checkpoint sequence must increase.');
      }
      items.push(sanitized);
    }
    // Bound per execution history.
    const byExecution = new Map<string, ExecutionCheckpoint[]>();
    for (const item of items) {
      const list = byExecution.get(item.executionId) ?? [];
      list.push(item);
      byExecution.set(item.executionId, list);
    }
    const bounded: ExecutionCheckpoint[] = [];
    for (const list of byExecution.values()) {
      const sorted = [...list].sort(
        (left, right) => left.sequence - right.sequence || left.createdAt.localeCompare(right.createdAt),
      );
      bounded.push(...sorted.slice(-MAX_CHECKPOINTS_PER_EXECUTION));
    }
    bounded.sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.sequence - right.sequence,
    );
    this.persist(bounded);
  }

  async get(id: string): Promise<ExecutionCheckpoint | undefined> {
    return this.loadRaw().find((checkpoint) => checkpoint.id === id);
  }

  async list(executionId: string): Promise<readonly ExecutionCheckpoint[]> {
    return this.loadRaw()
      .filter((checkpoint) => checkpoint.executionId === executionId)
      .sort((left, right) => left.sequence - right.sequence || left.createdAt.localeCompare(right.createdAt));
  }

  async latest(executionId: string): Promise<ExecutionCheckpoint | undefined> {
    const items = await this.list(executionId);
    const valid = items.filter((checkpoint) => checkpoint.status === 'valid' || checkpoint.status === 'created' || checkpoint.status === 'restored');
    if (valid.length === 0) {
      return undefined;
    }
    return valid.reduce((best, candidate) =>
      candidate.sequence > best.sequence ||
      (candidate.sequence === best.sequence && candidate.createdAt > best.createdAt)
        ? candidate
        : best,
    );
  }

  invalidateCache(): void {
    this.cache = undefined;
  }
}
