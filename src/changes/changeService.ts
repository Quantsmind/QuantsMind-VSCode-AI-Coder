import * as vscode from 'vscode';
import { backupRetentionKey, pruneBackupFolders, safeBackupSegment } from './prune';
import type { SettingsService } from '../config/settings';
import { isPathExcluded } from '../context/filters';
import type { Logger } from '../security/logger';
import { applyChangePlan, undoAppliedChanges, type ApplyOutcome, type UndoOutcome, type UndoResult } from './apply';
import { WorkspaceChangeFs, type ChangeFs } from './fs';
import {
  ChangeHistoryStore,
  historyFilesFor,
  undoHistoryEntry,
  type HistoryEntry,
} from './history';
import { hashContent, withExpectedHash, type ChangePlan } from './model';
import { buildReviewChanges, type ReviewChange } from './review';
import { selectWorkspaceRoot } from '../workspace/rootPolicy';

export interface PreparedPlan {
  readonly plan: ChangePlan;
  readonly beforeByPath: ReadonlyMap<string, string | undefined>;
  readonly review: readonly ReviewChange[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface ApplyReport {
  readonly outcome: ApplyOutcome;
  readonly entry: HistoryEntry;
}

export class ChangeService {
  constructor(
    private readonly settings: SettingsService,
    private readonly history: ChangeHistoryStore,
    private readonly backupRoot: vscode.Uri,
    private readonly logger: Logger,
  ) {}

  createFs(taskId: string): ChangeFs {
    return this.createApplyFs(taskId, taskId);
  }

  createApplyFs(taskId: string, applyId: string): ChangeFs {
    // Containment and writes must target the same root the index selected.
    const root = selectWorkspaceRoot(vscode.workspace.workspaceFolders);
    if (root === undefined) {
      throw new Error('Open a workspace folder before applying changes.');
    }
    return new WorkspaceChangeFs(
      root.uri,
      vscode.Uri.joinPath(
        this.backupRoot,
        this.safeTaskId(taskId),
        this.safeTaskId(applyId),
      ),
    );
  }

  private safeTaskId(taskId: string): string {
    return safeBackupSegment(taskId);
  }

  /**
   * Deletes backup leaves under `backupRoot` whose change set is no longer in
   * the bounded history store. Plaintext before-images must not accumulate
   * forever. Best-effort: a failed sweep is logged, never applied to the result.
   * The sweep preserves leaves holding non-backup content (see prune.ts).
   */
  private async pruneBackups(): Promise<void> {
    try {
      const keep = new Set<string>();
      for (const entry of this.history.list()) {
        keep.add(backupRetentionKey(entry.taskId, entry.applyId));
      }
      const result = await pruneBackupFolders(this.backupRoot.fsPath, keep);
      for (const item of result.skipped) {
        this.logger.warn(`change backup sweep skipped ${item.path}: ${item.reason}`);
      }
      this.logger.info(
        `change backup sweep: kept=${result.kept.length} pruned=${result.deleted.length} skipped=${result.skipped.length}`,
      );
    } catch (error) {
      this.logger.warn(
        `change backup pruning skipped: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  async prepare(plan: ChangePlan, taskId: string): Promise<PreparedPlan> {
    this.requireTrusted('prepare file changes');
    const fs = this.createFs(taskId);
    const excludeGlobs = this.settings.getContextSettings().excludeGlobs;
    const errors: string[] = [];
    const warnings: string[] = [];
    const beforeByPath = new Map<string, string | undefined>();
    const prepared = [];

    for (const change of plan.changes) {
      const sourcePath = change.kind === 'rename' ? change.fromPath : change.path;
      if (
        isPathExcluded(change.path, excludeGlobs) ||
        (sourcePath !== undefined && isPathExcluded(sourcePath, excludeGlobs))
      ) {
        errors.push(`${change.path} is excluded by the workspace security rules.`);
        continue;
      }

      if (sourcePath === undefined) {
        errors.push(`${change.path} has no safe source path.`);
        continue;
      }

      let before: string | undefined;
      try {
        before = await fs.readText(sourcePath);
      } catch (error) {
        errors.push(
          `${sourcePath} could not be read: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        continue;
      }

      if (change.kind === 'create') {
        if (before !== undefined) {
          warnings.push(`${change.path} already exists; apply will refuse to overwrite it.`);
        }
        prepared.push(change);
        beforeByPath.set(change.path, before);
        continue;
      }

      if (before === undefined) {
        errors.push(`${sourcePath} does not exist in the workspace.`);
        continue;
      }

      if (change.kind === 'rename' && (await fs.exists(change.path))) {
        warnings.push(`${change.path} already exists; the rename will be refused.`);
      }

      prepared.push(withExpectedHash(change, hashContent(before)));
      beforeByPath.set(change.path, before);
    }

    if (errors.length > 0) {
      return {
        plan: { ...plan, changes: [] },
        beforeByPath,
        review: [],
        errors,
        warnings,
      };
    }

    const preparedPlan: ChangePlan = { ...plan, changes: prepared };
    return {
      plan: preparedPlan,
      beforeByPath,
      review: buildReviewChanges(preparedPlan.changes, beforeByPath),
      errors,
      warnings,
    };
  }

  private requireTrusted(action: string): void {
    if (vscode.workspace.isTrusted !== true) {
      throw new Error(`Workspace trust is required to ${action}.`);
    }
  }

  async apply(
    plan: ChangePlan,
    approvedIds: readonly string[],
    taskId: string,
    summary: string,
    applyId?: string,
    shouldCancel?: () => boolean,
  ): Promise<ApplyReport> {
    this.requireTrusted('apply file changes');
    const resolvedApplyId =
      applyId && applyId.length > 0
        ? applyId
        : `${taskId}-apply-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const fs = this.createApplyFs(taskId, resolvedApplyId);
    const outcome = await applyChangePlan(plan, fs, { approvedIds, ...(shouldCancel !== undefined ? { shouldCancel } : {}) });
    const appliedCount = outcome.applied.length;
    const total = plan.changes.length;
    const status =
      appliedCount === 0
        ? 'rejected'
        : outcome.conflicts.length > 0 || outcome.failed.length > 0
          ? 'partial'
          : appliedCount === total
            ? 'applied'
            : 'partial';

    const entry: HistoryEntry = {
      applyId: resolvedApplyId,
      taskId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      summary,
      status,
      files: historyFilesFor(plan, outcome),
      undoable: appliedCount > 0,
    };
    await this.history.add(entry);
    // Bounded retention: the history store is capped, so backup directories for
    // entries that fell out of the cap are deleted (best-effort, never fatal).
    await this.pruneBackups();
    this.logger.info(
      `change set ${taskId} apply ${resolvedApplyId}: applied=${appliedCount} conflicts=${outcome.conflicts.length} failed=${outcome.failed.length}`,
    );

    return { outcome, entry };
  }

  async undo(taskId: string): Promise<UndoOutcome | undefined> {
    this.requireTrusted('undo file changes');
    const entries = this.history
      .listForTask(taskId)
      .filter((entry) => entry.undoable)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (entries.length === 0) {
      return undefined;
    }

    const results: UndoResult[] = [];
    let restored = 0;
    let conflicts = 0;
    let failed = 0;
    for (const entry of [...entries].reverse()) {
      const fs = this.createApplyFs(taskId, entry.applyId);
      const outcome = await undoHistoryEntry(entry, fs);
      results.push(...outcome.results);
      restored += outcome.restored;
      conflicts += outcome.conflicts;
      failed += outcome.failed;
      const complete = outcome.conflicts === 0 && outcome.failed === 0;
      await this.history.update(entry.applyId, {
        status: complete ? 'undone' : 'partial',
        undoable: !complete,
      });
    }
    this.logger.info(
      `change set ${taskId} undo: restored=${restored} conflicts=${conflicts} failed=${failed}`,
    );
    return { results, restored, conflicts, failed };
  }

  async undoWithFiles(
    applied: Parameters<typeof undoAppliedChanges>[0],
    taskId: string,
  ): Promise<UndoOutcome> {
    const fs = this.createFs(taskId);
    const outcome = await undoAppliedChanges(applied, fs);
    const complete = outcome.conflicts === 0 && outcome.failed === 0;
    await this.history.update(taskId, {
      status: complete ? 'undone' : 'partial',
      undoable: !complete,
    });
    return outcome;
  }

  /** Lists all change-set history entries, most recent first. */
  listHistory(): readonly import('./history').HistoryEntry[] {
    return this.history.list();
  }
}
