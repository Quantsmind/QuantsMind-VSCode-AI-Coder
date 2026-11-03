import type { ResolvedAgentSettings } from '../config/resolve';
import type { UndoOutcome } from '../changes/apply';
import type { ChangePlan } from '../changes/model';
import type { PreparedPlan, ChangeService } from '../changes/changeService';
import type { ReviewChange } from '../changes/review';
import type { CommandResult } from '../commands/runner';
import type { RedactedContextItem } from '../context/filters';
import type {
  CancellationTokenLike,
  CompletionResult,
  ChatMessage,
} from '../providers/types';
import { isProviderError } from '../providers/errors';
import type { WorkspaceSummary } from '../workspace/analyze';
import { buildPlanMessages, parseChangePlan } from '../changes/plan';

export type TaskStatus =
  | 'running'
  | 'awaiting-approval'
  | 'applied'
  | 'validation-failed'
  | 'rejected'
  | 'cancelled'
  | 'failed'
  | 'undone';

export type TaskStageName =
  | 'retrieve'
  | 'plan'
  | 'review'
  | 'approval'
  | 'apply'
  | 'validate'
  | 'repair';

export type StageStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped';

export interface TaskStage {
  readonly name: TaskStageName;
  readonly status: StageStatus;
  readonly detail?: string;
}

export interface TaskValidation {
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly passed: boolean;
}

export interface AgentTaskView {
  readonly id: string;
  readonly prompt: string;
  readonly status: TaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stages: readonly TaskStage[];
  readonly providerCalls: number;
  readonly repairIterations: number;
  readonly planSummary?: string;
  readonly planNotes?: string;
  readonly review: readonly ReviewChange[];
  readonly warnings: readonly string[];
  readonly validation?: TaskValidation;
  readonly error?: string;
  readonly hint?: string;
}

export interface TaskRunnerDependencies {
  readonly complete: (
    messages: readonly ChatMessage[],
    token: CancellationTokenLike,
  ) => Promise<CompletionResult>;
  readonly retrieve: (
    query: string,
    token: CancellationTokenLike,
  ) => Promise<{
    readonly summary: WorkspaceSummary;
    readonly items: readonly RedactedContextItem[];
    readonly reasons: Readonly<Record<string, string>>;
    readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  }>;
  readonly changes: ChangeService;
  readonly runCommand: (
    command: string,
    signal: AbortSignal,
  ) => Promise<CommandResult>;
  readonly agentSettings: () => ResolvedAgentSettings;
  readonly logger: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string, error?: unknown): void;
  };
  readonly onChange: (task: AgentTaskView) => void;
}

interface InternalTask {
  id: string;
  prompt: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  stages: TaskStage[];
  providerCalls: number;
  repairIterations: number;
  plan?: ChangePlan;
  planSummary?: string;
  planNotes?: string;
  review: ReviewChange[];
  warnings: string[];
  validation?: TaskValidation;
  error?: string;
  hint?: string;
}

const STAGE_ORDER: readonly TaskStageName[] = [
  'retrieve',
  'plan',
  'review',
  'approval',
  'apply',
  'validate',
  'repair',
];

const STAGE_LABELS: Record<TaskStageName, string> = {
  retrieve: 'Select relevant workspace files',
  plan: 'Ask the provider for a change plan',
  review: 'Build reviewable diffs',
  approval: 'Wait for explicit approval',
  apply: 'Apply approved changes',
  validate: 'Run the approved validation command',
  repair: 'Repair after validation failure',
};

function taskErrorHint(message: string): string | undefined {
  if (/JSON plan|invalid JSON|malformed|changes array/i.test(message)) {
    return 'Try a more specific request, or switch to Ask mode to inspect the code first.';
  }
  if (/excluded|unsafe|outside the workspace/i.test(message)) {
    return 'Choose a different target; sensitive and out-of-workspace paths are blocked.';
  }
  if (/did not exist|no longer exists|changed after/i.test(message)) {
    return 'Regenerate the plan so it matches the current workspace.';
  }
  return undefined;
}

export class AgentTaskRunner {
  private readonly tasks = new Map<string, InternalTask>();
  private sequence = 0;

  constructor(private readonly deps: TaskRunnerDependencies) {}

  private stage(name: TaskStageName): TaskStage {
    return { name, status: 'pending' };
  }

  private updateStage(task: InternalTask, name: TaskStageName, status: StageStatus, detail?: string): void {
    task.stages = task.stages.map((stage) =>
      stage.name === name ? { name, status, detail: detail ?? stage.detail } : stage,
    );
    task.updatedAt = new Date().toISOString();
  }

  private view(task: InternalTask): AgentTaskView {
    return {
      id: task.id,
      prompt: task.prompt,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      stages: task.stages.map((stage) => ({ ...stage })),
      providerCalls: task.providerCalls,
      repairIterations: task.repairIterations,
      planSummary: task.planSummary,
      planNotes: task.planNotes,
      review: task.review.map((change) => ({ ...change })),
      warnings: [...task.warnings],
      validation: task.validation,
      error: task.error,
      hint: task.hint,
    };
  }

  private emit(task: InternalTask): void {
    this.deps.onChange(this.view(task));
  }

  private fail(task: InternalTask, message: string, code?: string): AgentTaskView {
    task.status = 'failed';
    task.error = message;
    task.hint = code ?? taskErrorHint(message);
    task.updatedAt = new Date().toISOString();
    const running = task.stages.find((stage) => stage.status === 'running');
    if (running !== undefined) {
      this.updateStage(task, running.name, 'failed', message);
    }
    this.deps.logger.warn(`agent task ${task.id} failed: ${message}`);
    this.emit(task);
    return this.view(task);
  }

  private cancelled(task: InternalTask): AgentTaskView {
    task.status = 'cancelled';
    task.error = 'The task was cancelled.';
    task.updatedAt = new Date().toISOString();
    for (const stage of task.stages) {
      if (stage.status === 'running') {
        this.updateStage(task, stage.name, 'skipped', 'Cancelled by the user.');
      }
    }
    this.emit(task);
    return this.view(task);
  }

  viewById(taskId: string): AgentTaskView | undefined {
    const task = this.tasks.get(taskId);
    return task !== undefined ? this.view(task) : undefined;
  }

  pendingApproval(taskId: string): { readonly plan: ChangePlan; readonly review: readonly ReviewChange[] } | undefined {
    const task = this.tasks.get(taskId);
    if (task === undefined || task.plan === undefined || task.status !== 'awaiting-approval') {
      return undefined;
    }
    return { plan: task.plan, review: task.review };
  }

  async start(prompt: string, token: CancellationTokenLike): Promise<AgentTaskView> {
    this.sequence += 1;
    const task: InternalTask = {
      id: `task-${Date.now().toString(36)}-${this.sequence}`,
      prompt,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stages: STAGE_ORDER.map((name) => this.stage(name)),
      providerCalls: 0,
      repairIterations: 0,
      review: [],
      warnings: [],
    };
    this.tasks.set(task.id, task);
    this.emit(task);

    return this.planForTask(task, token, undefined);
  }

  private async planForTask(
    task: InternalTask,
    token: CancellationTokenLike,
    repairContext: string | undefined,
  ): Promise<AgentTaskView> {
    try {
      this.updateStage(task, 'retrieve', 'running');
      const retrieval = await this.deps.retrieve(task.prompt, token);
      if (token.isCancellationRequested) {
        return this.cancelled(task);
      }
      this.updateStage(
        task,
        'retrieve',
        'complete',
        `${retrieval.items.length} file(s) selected` +
          (retrieval.skipped.length > 0 ? `, ${retrieval.skipped.length} skipped` : ''),
      );

      if (task.providerCalls >= this.deps.agentSettings().maxSteps) {
        return this.fail(
          task,
          `The task reached the configured maximum of ${this.deps.agentSettings().maxSteps} provider step(s).`,
          'Increase "quantsmind.agent.maxSteps" or narrow the request.',
        );
      }

      this.updateStage(task, 'plan', 'running');
      const messages = buildPlanMessages({
        request: repairContext !== undefined ? `${task.prompt}\n\n${repairContext}` : task.prompt,
        summary: retrieval.summary,
        items: retrieval.items,
        reasons: retrieval.reasons,
      });
      task.providerCalls += 1;
      const result = await this.deps.complete(messages, token);
      if (token.isCancellationRequested) {
        return this.cancelled(task);
      }

      const parsed = parseChangePlan(result.text);
      if (parsed.plan === undefined) {
        this.updateStage(task, 'plan', 'failed', parsed.errors.join(' '));
        return this.fail(task, parsed.errors.join(' ') || 'The plan could not be parsed.');
      }

      const pendingPlan: ChangePlan = { id: task.id, ...parsed.plan };
      if (pendingPlan.changes.length === 0) {
        this.updateStage(task, 'plan', 'complete', 'The provider requested no file changes.');
        task.plan = pendingPlan;
        task.planSummary = pendingPlan.summary;
        task.planNotes = pendingPlan.notes;
        task.review = [];
        task.status = 'awaiting-approval';
        this.updateStage(task, 'approval', 'running');
        this.emit(task);
        return this.view(task);
      }

      this.updateStage(task, 'plan', 'complete', `${pendingPlan.changes.length} file change(s) proposed`);

      this.updateStage(task, 'review', 'running');
      const prepared: PreparedPlan = await this.deps.changes.prepare(pendingPlan, task.id);
      if (prepared.errors.length > 0) {
        this.updateStage(task, 'review', 'failed', prepared.errors.join(' '));
        return this.fail(task, prepared.errors.join(' '));
      }

      task.plan = prepared.plan;
      task.planSummary = prepared.plan.summary;
      task.planNotes = prepared.plan.notes;
      task.review = [...prepared.review];
      task.warnings = [...prepared.warnings];
      task.validation = undefined;
      task.status = 'awaiting-approval';
      task.error = undefined;
      task.hint = undefined;
      this.updateStage(task, 'review', 'complete', `${prepared.review.length} diff(s) ready`);
      this.updateStage(task, 'approval', 'running');
      this.emit(task);
      return this.view(task);
    } catch (error) {
      if (isProviderError(error) && error.code === 'cancelled') {
        return this.cancelled(task);
      }
      const message = error instanceof Error ? error.message : 'The task failed unexpectedly.';
      return this.fail(task, message);
    }
  }

  async approve(
    taskId: string,
    approvedIds: readonly string[],
    token: CancellationTokenLike,
  ): Promise<AgentTaskView> {
    const task = this.tasks.get(taskId);
    if (task === undefined || task.plan === undefined || task.status !== 'awaiting-approval') {
      throw new Error('The task is not awaiting approval.');
    }
    if (token.isCancellationRequested) {
      return this.cancelled(task);
    }

    if (approvedIds.length === 0) {
      task.status = 'rejected';
      task.plan = undefined;
      this.updateStage(task, 'approval', 'complete', 'All changes were rejected.');
      this.emit(task);
      return this.view(task);
    }

    const validIds = new Set(task.plan.changes.map((change) => change.id));
    const selected = approvedIds.filter((id) => validIds.has(id));
    if (selected.length === 0) {
      return this.fail(task, 'None of the selected changes belong to this plan.');
    }

    this.updateStage(task, 'approval', 'complete', `${selected.length} of ${task.plan.changes.length} approved`);
    this.updateStage(task, 'apply', 'running');

    try {
      const report = await this.deps.changes.apply(task.plan, selected, task.id, task.planSummary ?? task.prompt);
      const applied = report.outcome.applied.length;
      const problems = report.outcome.conflicts.length + report.outcome.failed.length;

      if (applied === 0) {
        this.updateStage(task, 'apply', 'failed', 'No files were applied.');
        return this.fail(
          task,
          'No files were applied. The workspace may have changed since the plan was created.',
          'Regenerate the plan and review the diffs again.',
        );
      }

      task.status = 'applied';
      task.plan = undefined;
      this.updateStage(
        task,
        'apply',
        problems === 0 ? 'complete' : 'failed',
        `${applied} file(s) applied` + (problems > 0 ? `, ${problems} problem(s)` : ''),
      );
      this.updateStage(task, 'validate', 'pending', 'Choose an allowlisted validation command.');
      this.emit(task);
      return this.view(task);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Applying the plan failed.';
      return this.fail(task, message);
    }
  }

  async validate(
    taskId: string,
    command: string,
    signal: AbortSignal,
  ): Promise<AgentTaskView> {
    const task = this.tasks.get(taskId);
    if (task === undefined || task.status !== 'applied') {
      throw new Error('Only an applied task can run validation.');
    }

    this.updateStage(task, 'validate', 'running', command);
    const result = await this.deps.runCommand(command, signal);
    const passed = result.exitCode === 0 && !result.timedOut && !result.cancelled;
    task.validation = {
      command: result.command,
      exitCode: result.exitCode,
      output: result.output,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      passed,
    };

    if (result.cancelled) {
      this.updateStage(task, 'validate', 'skipped', 'Cancelled by the user.');
      task.status = 'cancelled';
      this.emit(task);
      return this.view(task);
    }

    if (result.error !== undefined) {
      this.updateStage(task, 'validate', 'failed', result.error);
      task.status = 'validation-failed';
      task.error = result.error;
      task.updatedAt = new Date().toISOString();
      this.emit(task);
      return this.view(task);
    }

    if (passed) {
      this.updateStage(task, 'validate', 'complete', 'Validation passed.');
      task.error = undefined;
      task.hint = undefined;
    } else {
      this.updateStage(
        task,
        'validate',
        'failed',
        result.timedOut ? 'Validation timed out.' : 'Validation reported a failure.',
      );
      task.status = 'validation-failed';
      task.error = 'The validation command failed. Review the output or attempt a repair.';
    }
    task.updatedAt = new Date().toISOString();
    this.emit(task);
    return this.view(task);
  }

  async repair(taskId: string, token: CancellationTokenLike): Promise<AgentTaskView> {
    const task = this.tasks.get(taskId);
    if (task === undefined || task.status !== 'validation-failed' || task.validation === undefined) {
      throw new Error('The task is not awaiting repair.');
    }
    if (task.repairIterations >= this.deps.agentSettings().maxRepairIterations) {
      return this.fail(
        task,
        `The task reached the configured repair limit of ${this.deps.agentSettings().maxRepairIterations}.`,
        'Review the validation output and adjust the request manually.',
      );
    }
    if (token.isCancellationRequested) {
      return this.cancelled(task);
    }

    task.repairIterations += 1;
    task.status = 'running';
    this.updateStage(
      task,
      'repair',
      'running',
      `Repair attempt ${task.repairIterations} of ${this.deps.agentSettings().maxRepairIterations}`,
    );
    for (const name of ['apply', 'validate'] as const) {
      this.updateStage(task, name, 'pending');
    }
    this.emit(task);

    const validation = task.validation;
    const repairContext = [
      'A previous change plan was applied, but validation failed.',
      `Validation command: ${validation.command}`,
      `Exit code: ${validation.exitCode ?? 'unknown'}`,
      validation.timedOut ? 'The command timed out.' : '',
      'Validation output (truncated, redacted):',
      validation.output.slice(0, 6_000),
      '',
      'Produce a complete replacement plan for the original request that fixes the failure.',
    ]
      .filter((line) => line.length > 0)
      .join('\n');

    const result = await this.planForTask(task, token, repairContext);
    if (result.status === 'awaiting-approval') {
      this.updateStage(task, 'repair', 'complete', 'A revised plan is ready for review.');
      this.emit(task);
    }
    return this.viewById(task.id) ?? result;
  }

  async undo(
    taskId: string,
  ): Promise<{ readonly task: AgentTaskView; readonly outcome: UndoOutcome } | undefined> {
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      return undefined;
    }
    const outcome = await this.deps.changes.undo(taskId);
    if (outcome === undefined) {
      return undefined;
    }
    task.status = outcome.conflicts > 0 ? 'validation-failed' : 'undone';
    task.error =
      outcome.conflicts > 0
        ? 'Some files could not be restored because they were modified after apply.'
        : undefined;
    this.emit(task);
    return { task: this.view(task), outcome };
  }

  cancel(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task !== undefined) {
      this.cancelled(task);
    }
  }

  stageLabels(): Record<TaskStageName, string> {
    return { ...STAGE_LABELS };
  }
}
