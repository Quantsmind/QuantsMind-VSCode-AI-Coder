import { CHANGE_HISTORY_KEY, MAX_CHANGE_HISTORY } from '../config/defaults';
import {
  undoAppliedChanges,
  type AppliedFile,
  type ApplyOutcome,
  type UndoOutcome,
} from './apply';
import type { ChangeFs } from './fs';
import type { ChangePlan, ChangeKind } from './model';

export interface MementoLike {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

export type HistoryStatus =
  | 'awaiting-approval'
  | 'applied'
  | 'partial'
  | 'rejected'
  | 'undone'
  | 'failed';

export interface HistoryFile {
  readonly changeId: string;
  readonly kind: ChangeKind;
  readonly path: string;
  readonly fromPath?: string;
  readonly status: 'applied' | 'skipped' | 'conflict' | 'failed';
  readonly backupName?: string;
}

export interface HistoryEntry {
  readonly taskId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly summary: string;
  readonly status: HistoryStatus;
  readonly files: readonly HistoryFile[];
  readonly undoable: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): HistoryEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    typeof value.taskId !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.summary !== 'string' ||
    typeof value.status !== 'string' ||
    !Array.isArray(value.files)
  ) {
    return undefined;
  }

  const statuses = [
    'awaiting-approval',
    'applied',
    'partial',
    'rejected',
    'undone',
    'failed',
  ];
  if (!statuses.includes(value.status)) {
    return undefined;
  }

  const files: HistoryFile[] = [];
  for (const file of value.files) {
    if (!isRecord(file)) {
      continue;
    }
    if (typeof file.changeId !== 'string' || typeof file.path !== 'string') {
      continue;
    }
    if (typeof file.kind !== 'string' || typeof file.status !== 'string') {
      continue;
    }
    if (!['create', 'modify', 'delete', 'rename'].includes(file.kind)) {
      continue;
    }
    if (!['applied', 'skipped', 'conflict', 'failed'].includes(file.status)) {
      continue;
    }
    files.push({
      changeId: file.changeId,
      kind: file.kind as ChangeKind,
      path: file.path,
      fromPath: typeof file.fromPath === 'string' ? file.fromPath : undefined,
      status: file.status as HistoryFile['status'],
      backupName: typeof file.backupName === 'string' ? file.backupName : undefined,
    });
  }

  return {
    taskId: value.taskId,
    createdAt: value.createdAt,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : value.createdAt,
    summary: value.summary.slice(0, 4_000),
    status: value.status as HistoryStatus,
    files,
    undoable: value.undoable === true,
  };
}

export class ChangeHistoryStore {
  constructor(private readonly memento: MementoLike) {}

  list(): HistoryEntry[] {
    const raw = this.memento.get(CHANGE_HISTORY_KEY);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map(parseEntry)
      .filter((entry): entry is HistoryEntry => entry !== undefined)
      .slice(0, MAX_CHANGE_HISTORY);
  }

  get(taskId: string): HistoryEntry | undefined {
    return this.list().find((entry) => entry.taskId === taskId);
  }

  async add(entry: HistoryEntry): Promise<void> {
    const entries = this.list().filter((item) => item.taskId !== entry.taskId);
    entries.unshift(entry);
    await this.memento.update(CHANGE_HISTORY_KEY, entries.slice(0, MAX_CHANGE_HISTORY));
  }

  async update(taskId: string, patch: Partial<Omit<HistoryEntry, 'taskId'>>): Promise<void> {
    const entries = this.list();
    const index = entries.findIndex((entry) => entry.taskId === taskId);
    if (index < 0) {
      return;
    }
    entries[index] = {
      ...entries[index],
      ...patch,
      taskId,
      updatedAt: new Date().toISOString(),
    };
    await this.memento.update(CHANGE_HISTORY_KEY, entries);
  }

  async fail(taskId: string, summary: string): Promise<void> {
    await this.add({
      taskId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      summary,
      status: 'failed',
      files: [],
      undoable: false,
    });
  }
}

export function historyFilesFor(plan: ChangePlan, outcome: ApplyOutcome): HistoryFile[] {
  const appliedByName = new Map(outcome.applied.map((file) => [file.changeId, file]));
  return outcome.results.map((result) => {
    const applied = appliedByName.get(result.changeId);
    const change = plan.changes.find((item) => item.id === result.changeId);
    return {
      changeId: result.changeId,
      kind: result.kind,
      path: result.path,
      fromPath: change?.fromPath,
      status: result.status,
      backupName: applied?.backupName,
    };
  });
}

export async function undoHistoryEntry(
  entry: HistoryEntry,
  fs: ChangeFs,
): Promise<UndoOutcome> {
  const applied: AppliedFile[] = [];

  for (const file of entry.files) {
    if (file.status !== 'applied' || file.backupName === undefined) {
      continue;
    }
    const raw = await fs.readBackup(file.backupName);
    if (raw === undefined) {
      continue;
    }
    try {
      const record = JSON.parse(raw) as Record<string, unknown>;
      applied.push({
        changeId: file.changeId,
        kind: file.kind,
        path: file.path,
        fromPath: file.fromPath,
        before: typeof record.before === 'string' ? record.before : undefined,
        after:
          file.kind === 'rename'
            ? typeof record.before === 'string'
              ? record.before
              : undefined
            : typeof record.after === 'string'
              ? record.after
              : undefined,
        backupName: file.backupName,
      });
    } catch {
      continue;
    }
  }

  return undoAppliedChanges(applied, fs);
}
