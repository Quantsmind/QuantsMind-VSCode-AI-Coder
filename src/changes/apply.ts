import type { ChangeFs } from './fs';
import {
  describeChange,
  hashContent,
  type FileChange,
  type ChangePlan,
} from './model';

export type FileApplyStatus = 'applied' | 'skipped' | 'conflict' | 'failed';

export interface FileApplyResult {
  readonly changeId: string;
  readonly path: string;
  readonly kind: FileChange['kind'];
  readonly status: FileApplyStatus;
  readonly message?: string;
}

export interface AppliedFile {
  readonly changeId: string;
  readonly kind: FileChange['kind'];
  readonly path: string;
  readonly fromPath?: string;
  readonly before?: string;
  readonly after?: string;
  readonly backupName: string;
}

export interface ApplyOutcome {
  readonly results: readonly FileApplyResult[];
  readonly applied: readonly AppliedFile[];
  readonly conflicts: readonly FileApplyResult[];
  readonly failed: readonly FileApplyResult[];
}

export interface UndoResult {
  readonly changeId: string;
  readonly path: string;
  readonly status: 'restored' | 'conflict' | 'failed';
  readonly message?: string;
}

export interface UndoOutcome {
  readonly results: readonly UndoResult[];
  readonly restored: number;
  readonly conflicts: number;
}

interface BackupRecord {
  readonly changeId: string;
  readonly kind: FileChange['kind'];
  readonly path: string;
  readonly fromPath?: string;
  readonly before?: string;
  readonly after?: string;
  readonly createdAt: string;
}

export interface ApplyOptions {
  readonly approvedIds?: readonly string[];
}

function backupName(changeId: string): string {
  return `${changeId}.json`;
}

function backupJson(record: BackupRecord): string {
  return JSON.stringify(record, undefined, 2);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown file-system error.';
}

async function preflight(
  change: FileChange,
  fs: ChangeFs,
): Promise<{ status: 'ok'; before?: string } | { status: 'conflict'; message: string }> {
  if (change.kind === 'create') {
    if (await fs.exists(change.path)) {
      return {
        status: 'conflict',
        message: 'The target file already exists; it will not be overwritten.',
      };
    }
    return { status: 'ok' };
  }

  if (change.kind === 'rename') {
    if (change.fromPath === undefined) {
      return { status: 'conflict', message: 'The source path is missing.' };
    }
    const source = await fs.readText(change.fromPath);
    if (source === undefined) {
      return { status: 'conflict', message: 'The source file no longer exists.' };
    }
    if (change.expectedHash !== undefined && hashContent(source) !== change.expectedHash) {
      return {
        status: 'conflict',
        message: 'The source file changed after the plan was created.',
      };
    }
    if (await fs.exists(change.path)) {
      return { status: 'conflict', message: 'The rename target already exists.' };
    }
    return { status: 'ok', before: source };
  }

  const current = await fs.readText(change.path);
  if (current === undefined) {
    return { status: 'conflict', message: 'The file no longer exists.' };
  }
  if (change.expectedHash === undefined) {
    return {
      status: 'conflict',
      message: 'No baseline content hash was recorded; regenerate the plan.',
    };
  }
  if (hashContent(current) !== change.expectedHash) {
    return { status: 'conflict', message: 'The file changed after the plan was created.' };
  }
  return { status: 'ok', before: current };
}

/**
 * Applies approved changes only. Every file is preflighted against its
 * baseline hash first, and a backup is written before any mutation.
 */
export async function applyChangePlan(
  plan: ChangePlan,
  fs: ChangeFs,
  options: ApplyOptions = {},
): Promise<ApplyOutcome> {
  const approved = options.approvedIds !== undefined ? new Set(options.approvedIds) : undefined;
  const results: FileApplyResult[] = [];
  const applied: AppliedFile[] = [];

  const selected = plan.changes.filter((change) => approved === undefined || approved.has(change.id));
  for (const change of plan.changes) {
    if (approved !== undefined && !approved.has(change.id)) {
      results.push({
        changeId: change.id,
        path: change.path,
        kind: change.kind,
        status: 'skipped',
        message: 'Not approved.',
      });
    }
  }

  const preflightByChange = new Map<string, { before?: string } | { message: string }>();
  for (const change of selected) {
    try {
      const check = await preflight(change, fs);
      if (check.status === 'conflict') {
        preflightByChange.set(change.id, { message: check.message });
      } else {
        preflightByChange.set(change.id, { before: check.before });
      }
    } catch (error) {
      preflightByChange.set(change.id, { message: messageOf(error) });
    }
  }

  for (const change of selected) {
    const check = preflightByChange.get(change.id);
    if (check === undefined || 'message' in check) {
      results.push({
        changeId: change.id,
        path: change.path,
        kind: change.kind,
        status: 'conflict',
        message: check?.message ?? 'The change could not be validated.',
      });
      continue;
    }

    const before = check.before;
    const record: BackupRecord = {
      changeId: change.id,
      kind: change.kind,
      path: change.path,
      fromPath: change.fromPath,
      before,
      after: change.content,
      createdAt: new Date().toISOString(),
    };
    const name = backupName(change.id);

    try {
      await fs.writeBackup(name, backupJson(record));
      switch (change.kind) {
        case 'create':
        case 'modify':
          await fs.writeText(change.path, change.content ?? '');
          break;
        case 'delete':
          await fs.deleteFile(change.path);
          break;
        case 'rename':
          if (change.fromPath === undefined) {
            throw new Error('The source path is missing.');
          }
          await fs.move(change.fromPath, change.path);
          break;
        default:
          throw new Error('Unsupported change kind.');
      }

      applied.push({
        changeId: change.id,
        kind: change.kind,
        path: change.path,
        fromPath: change.fromPath,
        before,
        after: change.kind === 'rename' ? before : change.content,
        backupName: name,
      });
      results.push({
        changeId: change.id,
        path: change.path,
        kind: change.kind,
        status: 'applied',
        message: describeChange(change),
      });
    } catch (error) {
      results.push({
        changeId: change.id,
        path: change.path,
        kind: change.kind,
        status: 'failed',
        message: messageOf(error),
      });
    }
  }

  return {
    results,
    applied,
    conflicts: results.filter((result) => result.status === 'conflict'),
    failed: results.filter((result) => result.status === 'failed'),
  };
}

function statusFor(result: UndoResult): UndoResult {
  return result;
}

/**
 * Restores the pre-apply state in reverse order. Files modified by the user
 * after apply are never overwritten; they are reported as conflicts.
 */
export async function undoAppliedChanges(
  applied: readonly AppliedFile[],
  fs: ChangeFs,
): Promise<UndoOutcome> {
  const results: UndoResult[] = [];

  for (const file of [...applied].reverse()) {
    const base = { changeId: file.changeId, path: file.path };
    try {
      switch (file.kind) {
        case 'create': {
          if (!(await fs.exists(file.path))) {
            results.push(statusFor({ ...base, status: 'restored', message: 'Already removed.' }));
            break;
          }
          const current = await fs.readText(file.path);
          if (current !== undefined && file.after !== undefined && current !== file.after) {
            results.push(
              statusFor({
                ...base,
                status: 'conflict',
                message: 'The created file was modified after apply; it was left in place.',
              }),
            );
            break;
          }
          await fs.deleteFile(file.path);
          results.push(statusFor({ ...base, status: 'restored' }));
          break;
        }
        case 'modify': {
          const current = await fs.readText(file.path);
          if (current === undefined) {
            results.push(
              statusFor({ ...base, status: 'conflict', message: 'The file no longer exists.' }),
            );
            break;
          }
          if (file.after !== undefined && current !== file.after) {
            results.push(
              statusFor({
                ...base,
                status: 'conflict',
                message: 'The file was modified after apply; the backup was not restored.',
              }),
            );
            break;
          }
          await fs.writeText(file.path, file.before ?? '');
          results.push(statusFor({ ...base, status: 'restored' }));
          break;
        }
        case 'delete': {
          if (await fs.exists(file.path)) {
            results.push(
              statusFor({
                ...base,
                status: 'conflict',
                message: 'A new file exists at the deleted path; it was not overwritten.',
              }),
            );
            break;
          }
          await fs.writeText(file.path, file.before ?? '');
          results.push(statusFor({ ...base, status: 'restored' }));
          break;
        }
        case 'rename': {
          if (file.fromPath === undefined) {
            results.push(
              statusFor({ ...base, status: 'failed', message: 'The original path is unknown.' }),
            );
            break;
          }
          if (!(await fs.exists(file.path)) || (await fs.exists(file.fromPath))) {
            results.push(
              statusFor({
                ...base,
                status: 'conflict',
                message: 'The rename cannot be reversed safely because the paths changed.',
              }),
            );
            break;
          }
          await fs.move(file.path, file.fromPath);
          results.push(statusFor({ ...base, status: 'restored' }));
          break;
        }
        default:
          results.push(
            statusFor({ ...base, status: 'failed', message: 'Unsupported change kind.' }),
          );
      }

      if (results[results.length - 1]?.status === 'restored') {
        await fs.removeBackup(file.backupName);
      }
    } catch (error) {
      results.push(
        statusFor({ ...base, status: 'failed', message: messageOf(error) }),
      );
    }
  }

  return {
    results,
    restored: results.filter((result) => result.status === 'restored').length,
    conflicts: results.filter((result) => result.status === 'conflict').length,
  };
}
