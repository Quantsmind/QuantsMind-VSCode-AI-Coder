import * as vscode from 'vscode';
import type { SettingsService } from '../config/settings';
import { isPathExcluded } from '../context/filters';
import type { Logger } from '../security/logger';
import { applyChangePlan, undoAppliedChanges, type ApplyOutcome, type UndoOutcome } from './apply';
import { WorkspaceChangeFs, type ChangeFs } from './fs';
import {
  ChangeHistoryStore,
  historyFilesFor,
  undoHistoryEntry,
  type HistoryEntry,
} from './history';
import { hashContent, withExpectedHash, type ChangePlan } from './model';
import { buildReviewChanges, type ReviewChange } from './review';

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
    const root = vscode.workspace.workspaceFolders?.[0];
    if (root === undefined) {
      throw new Error('Open a workspace folder before applying changes.');
    }
    return new WorkspaceChangeFs(
      root.uri,
      vscode.Uri.joinPath(this.backupRoot, this.safeTaskId(taskId)),
    );
  }

  private safeTaskId(taskId: string): string {
    return taskId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'task';
  }

  async prepare(plan: ChangePlan, taskId: string): Promise<PreparedPlan> {
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

  async apply(
    plan: ChangePlan,
    approvedIds: readonly string[],
    taskId: string,
    summary: string,
  ): Promise<ApplyReport> {
    const fs = this.createFs(taskId);
    const outcome = await applyChangePlan(plan, fs, { approvedIds });
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
      taskId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      summary,
      status,
      files: historyFilesFor(plan, outcome),
      undoable: appliedCount > 0,
    };
    await this.history.add(entry);
    this.logger.info(
      `change set ${taskId}: applied=${appliedCount} conflicts=${outcome.conflicts.length} failed=${outcome.failed.length}`,
    );

    return { outcome, entry };
  }

  async undo(taskId: string): Promise<UndoOutcome | undefined> {
    const entry = this.history.get(taskId);
    if (entry === undefined || !entry.undoable) {
      return undefined;
    }

    const fs = this.createFs(taskId);
    const outcome = await undoHistoryEntry(entry, fs);
    const status = outcome.conflicts > 0 ? 'partial' : 'undone';
    await this.history.update(taskId, {
      status,
      undoable: outcome.conflicts > 0,
    });
    this.logger.info(
      `change set ${taskId} undo: restored=${outcome.restored} conflicts=${outcome.conflicts}`,
    );
    return outcome;
  }

  async undoWithFiles(
    applied: Parameters<typeof undoAppliedChanges>[0],
    taskId: string,
  ): Promise<UndoOutcome> {
    const fs = this.createFs(taskId);
    const outcome = await undoAppliedChanges(applied, fs);
    await this.history.update(taskId, {
      status: outcome.conflicts > 0 ? 'partial' : 'undone',
      undoable: outcome.conflicts > 0,
    });
    return outcome;
  }
}
