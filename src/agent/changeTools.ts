import { validateChangeInputs, type ChangePlan, type FileChangeInput } from '../changes/model';
import type { PreparedPlan, ApplyReport } from '../changes/changeService';
import type { AgentTool, AgentToolResult } from './codingAgent';
import { normalizeWorkspacePath } from './workspaceTools';

export interface ChangeApprovalService {
  prepare(plan: ChangePlan, taskId: string): Promise<PreparedPlan>;
  apply(
    plan: ChangePlan,
    approvedIds: readonly string[],
    taskId: string,
    summary: string,
  ): Promise<ApplyReport>;
  undo(taskId: string): Promise<{ restored: number; conflicts: number } | undefined>;
}

export interface ChangeToolApproval {
  (review: {
    readonly taskId: string;
    readonly summary: string;
    readonly files: readonly { readonly kind: string; readonly path: string; readonly summary: string }[];
  }): Promise<readonly string[] | undefined>;
}

export class ChangeTools {
  private pendingPlan: ChangePlan | undefined;
  private pendingTaskId: string | undefined;

  constructor(
    private readonly changes: ChangeApprovalService,
    private readonly approval: ChangeToolApproval,
  ) {}

  async prepareFileChange(input: {
    readonly changes: readonly FileChangeInput[];
    readonly summary?: string;
  }): Promise<AgentToolResult> {
    const validation = validateChangeInputs(input.changes ?? []);
    if (validation.errors.length > 0) {
      return { ok: false, tool: 'prepare_file_change', error: validation.errors.join(' '), durationMs: 0 };
    }
    const taskId = `agent-change-${Date.now().toString(36)}`;
    const summary = (input.summary ?? 'Agent-proposed file changes').trim().slice(0, 500);
    const plan: ChangePlan = {
      id: taskId,
      summary,
      changes: validation.changes,
    };
    try {
      const prepared = await this.changes.prepare(plan, taskId);
      if (prepared.errors.length > 0) {
        return { ok: false, tool: 'prepare_file_change', error: prepared.errors.join(' '), durationMs: 0 };
      }
      this.pendingPlan = prepared.plan;
      this.pendingTaskId = taskId;
      const files = prepared.review.map((change) => ({
        kind: change.kind,
        path: change.path,
        summary: change.summary,
        diff: change.diff.length > 4000 ? `${change.diff.slice(0, 4000)}\n...[truncated]` : change.diff,
      }));
      return {
        ok: true,
        tool: 'prepare_file_change',
        output: JSON.stringify({ taskId, summary, files, warnings: prepared.warnings }, null, 2),
        durationMs: 0,
      };
    } catch (error) {
      return { ok: false, tool: 'prepare_file_change', error: error instanceof Error ? error.message : 'Unable to prepare changes.', durationMs: 0 };
    }
  }

  async applyPendingChange(approvedIds?: readonly string[]): Promise<AgentToolResult> {
    if (this.pendingPlan === undefined || this.pendingTaskId === undefined) {
      return { ok: false, tool: 'apply_prepared_change', error: 'No prepared change set is waiting for approval.', durationMs: 0 };
    }
    const reviewFiles = this.pendingPlan.changes.map((change) => ({
      kind: change.kind,
      path: change.path,
      summary: change.summary,
    }));
    const approved = await this.approval({
      taskId: this.pendingTaskId,
      summary: this.pendingPlan.summary,
      files: reviewFiles,
    });
    if (approved === undefined || approved.length === 0) {
      return {
        ok: false,
        tool: 'apply_prepared_change',
        error: 'Change application requires explicit approval.',
        output: JSON.stringify({ taskId: this.pendingTaskId, approvedIds: [] }, null, 2),
        durationMs: 0,
      };
    }
    const ids = approvedIds !== undefined && approvedIds.length > 0 ? approvedIds : approved;
    try {
      const report = await this.changes.apply(this.pendingPlan, ids, this.pendingTaskId, this.pendingPlan.summary);
      const applied = report.outcome.applied.map((file) => `${file.kind}: ${file.path}`);
      const conflicts = report.outcome.conflicts.map((file) => `${file.path}`);
      const failed = report.outcome.failed.map((file) => `${file.path}`);
      const result = {
        ok: applied.length > 0,
        tool: 'apply_prepared_change',
        output: JSON.stringify({ taskId: this.pendingTaskId, applied, conflicts, failed }, null, 2),
        durationMs: 0,
      };
      this.pendingPlan = undefined;
      this.pendingTaskId = undefined;
      return result;
    } catch (error) {
      return { ok: false, tool: 'apply_prepared_change', error: error instanceof Error ? error.message : 'Unable to apply changes.', durationMs: 0 };
    }
  }

  async undoChange(taskId: string): Promise<AgentToolResult> {
    if (typeof taskId !== 'string' || taskId.trim().length === 0) {
      return { ok: false, tool: 'undo_file_change', error: 'A task id is required.', durationMs: 0 };
    }
    try {
      const result = await this.changes.undo(taskId.trim());
      if (result === undefined) {
        return { ok: true, tool: 'undo_file_change', output: 'No undoable change set was found.', durationMs: 0 };
      }
      return {
        ok: true,
        tool: 'undo_file_change',
        output: JSON.stringify({ restored: result.restored, conflicts: result.conflicts }, null, 2),
        durationMs: 0,
      };
    } catch (error) {
      return { ok: false, tool: 'undo_file_change', error: error instanceof Error ? error.message : 'Unable to undo changes.', durationMs: 0 };
    }
  }

  toAgentTools(): readonly AgentTool[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return [
      {
        name: 'prepare_file_change',
        description: 'Prepare a reviewable file change set. Nothing is written until apply_prepared_change is approved.',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            changes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['create', 'modify', 'delete', 'rename'] },
                  path: { type: 'string' },
                  fromPath: { type: 'string' },
                  content: { type: 'string' },
                  summary: { type: 'string' },
                },
                required: ['kind', 'path'],
              },
            },
          },
          required: ['changes'],
        },
        async execute(args) {
          const changes = Array.isArray(args.changes) ? args.changes : [];
          const inputs = changes
            .filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null)
            .map((value) => ({
              kind: value.kind,
              path: value.path,
              fromPath: value.fromPath,
              content: value.content,
              summary: value.summary,
            }));
          return self.prepareFileChange({ changes: inputs as FileChangeInput[], summary: typeof args.summary === 'string' ? args.summary : undefined });
        },
      },
      {
        name: 'apply_prepared_change',
        description: 'Apply the currently prepared change set after explicit approval.',
        parameters: { type: 'object', properties: { approvedIds: { type: 'array', items: { type: 'string' } } } },
        async execute(args) {
          const approvedIds = Array.isArray(args.approvedIds) ? args.approvedIds.filter((value): value is string => typeof value === 'string') : undefined;
          return self.applyPendingChange(approvedIds);
        },
      },
      {
        name: 'undo_file_change',
        description: 'Undo a previously applied change set by task id.',
        parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
        async execute(args) {
          return self.undoChange(typeof args.taskId === 'string' ? args.taskId : '');
        },
      },
    ];
  }
}

export function normalizeToolChangePath(raw: unknown): string | undefined {
  return normalizeWorkspacePath(raw);
}
