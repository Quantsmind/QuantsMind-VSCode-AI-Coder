import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Bounded-retention sweep for change backups. Backups are plaintext before-images
 * written under `backupRoot/<safeTask>/<safeApply>/<changeId>.json` at apply time.
 * The history store is capped (MAX_CHANGE_HISTORY); this module deletes backup
 * leaves whose (task, apply) pair is no longer tracked by that capped history.
 *
 * Guarantees:
 * - containment: paths are resolved against the root and refused outside it;
 * - preservation: a leaf directory is deleted only when it holds exclusively
 *   `.json` files — anything else (marker files, future layouts) is preserved;
 * - best-effort: every failure lands in `skipped`; this function does not throw.
 */

export function safeBackupSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'task';
}

export function backupRetentionKey(taskId: string, applyId: string): string {
  return `${safeBackupSegment(taskId)}/${safeBackupSegment(applyId)}`;
}

export interface PruneBackupsResult {
  readonly deleted: readonly string[];
  readonly kept: readonly string[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

export function isContainedPath(parent: string, candidate: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

export async function pruneBackupFolders(
  rootFsPath: string,
  keep: ReadonlySet<string>,
): Promise<PruneBackupsResult> {
  const deleted: string[] = [];
  const kept: string[] = [];
  const skipped: { path: string; reason: string }[] = [];

  let root: string;
  try {
    root = path.resolve(rootFsPath);
  } catch {
    return { deleted, kept, skipped: [{ path: String(rootFsPath), reason: 'unresolvable root' }] };
  }

  let taskDirs: import('node:fs').Dirent[];
  try {
    taskDirs = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    // Missing root or unreadable tree: nothing can be pruned, nothing is deleted.
    return { deleted, kept, skipped: [{ path: root, reason: messageOf(error) }] };
  }

  for (const taskDir of taskDirs) {
    const taskPath = path.resolve(root, taskDir.name);
    if (!taskDir.isDirectory()) {
      skipped.push({ path: taskPath, reason: 'not a directory; preserved' });
      continue;
    }
    if (!isContainedPath(root, taskPath)) {
      skipped.push({ path: taskPath, reason: 'escapes the backup root; preserved' });
      continue;
    }
    const taskKey = safeBackupSegment(taskDir.name);

    let applyDirs: import('node:fs').Dirent[];
    try {
      applyDirs = await fsp.readdir(taskPath, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: taskPath, reason: messageOf(error) });
      continue;
    }

    for (const applyDir of applyDirs) {
      const applyPath = path.resolve(taskPath, applyDir.name);
      if (!applyDir.isDirectory()) {
        skipped.push({ path: applyPath, reason: 'not a directory; preserved' });
        continue;
      }
      if (!isContainedPath(taskPath, applyPath)) {
        skipped.push({ path: applyPath, reason: 'escapes its task folder; preserved' });
        continue;
      }
      const applyKey = `${taskKey}/${safeBackupSegment(applyDir.name)}`;
      if (keep.has(applyKey)) {
        kept.push(applyPath);
        continue;
      }
      // Shape guard: a leaf only qualifies for deletion when it holds
      // exclusively .json files (the backup shape). Anything else is preserved.
      let leafEntries: import('node:fs').Dirent[];
      try {
        leafEntries = await fsp.readdir(applyPath, { withFileTypes: true });
      } catch (error) {
        skipped.push({ path: applyPath, reason: messageOf(error) });
        continue;
      }
      const hasForeignContent = leafEntries.some(
        (entry) => entry.isDirectory() || !entry.name.endsWith('.json'),
      );
      if (hasForeignContent) {
        skipped.push({ path: applyPath, reason: 'contains non-backup content; preserved' });
        continue;
      }
      try {
        await fsp.rm(applyPath, { recursive: true, force: true });
        deleted.push(applyPath);
      } catch (error) {
        skipped.push({ path: applyPath, reason: messageOf(error) });
      }
    }

    // Best effort: drop the task folder itself when it holds nothing.
    try {
      const remaining = await fsp.readdir(taskPath);
      if (remaining.length === 0) {
        await fsp.rmdir(taskPath);
      }
    } catch {
      // The task folder stays; pruning other leaves is unaffected.
    }
  }

  return { deleted, kept, skipped };
}
