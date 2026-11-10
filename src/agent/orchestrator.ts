import { hashContent, type ChangePlan, type FileChange } from '../changes/model';
import { buildPlanMessages, parseChangePlan } from '../changes/plan';
import { evaluateCommand } from '../commands/policy';
import type { CommandResult } from '../commands/runner';
import type { ResolvedAgentSettings, ResolvedCommandSettings } from '../config/resolve';
import type { ChatMessage, CompletionResult, CancellationTokenLike } from '../providers/types';
import { analyzeValidationFailure } from './diagnostics';
import {
  MAX_EVENT_MESSAGE_CHARS,
  MAX_SESSION_EVENTS,
  MAX_VALIDATION_OUTPUT_CHARS,
  SESSION_SCHEMA_VERSION,
  CHECKPOINT_SCHEMA_VERSION,
  clampText,
  createRequirement,
  isTerminalAgentState,
  isTerminalTaskStatus,
  type AgentSession,
  type AgentSessionView,
  type AgentState,
  type AgentTask,
  type AppliedFile,
  type ApplyOutcomeLike,
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalRequest,
  type ChangeSet,
  type ExecutionCheckpoint,
  type Diagnostic,
  type IApprovalService,
  type IFileChangeService,
  type IRepairService,
  type IValidationService,
  type PreparedChangeSet,
  type ProjectContext,
  type RepairProposal,
  type RetrievalResult,
  type SessionEvent,
  type SessionEventType,
  type TaskExecution,
  type TaskStatus,
  type UnifiedDiff,
  type ValidationOutcome,
  type ValidationRun,
} from './models';
import { buildDevelopmentPlanMessages, buildTaskRequest, parseDevelopmentPlan } from './planning';
import { computeContinuationPlan } from './continuation';
import { buildCompletionReport } from './report';
import { canTransitionTaskStatus, findTask, nextRunnableTasks, refreshBlockedTasks, schedule, updateTask } from './scheduler';
import { canPause, deriveProgress, deriveStages, transitionSession, STATE_LABELS } from './stateMachine';
import { bindValidation, changeSetVersion, deriveValidationSuggestions, type ValidationBinding } from './validation';
import type { ISessionRepository } from '../sessions/repository';
import type { CheckpointRepository } from '../sessions/checkpointRepository';
import { impactSummary, type ChangeImpact } from '../repository/impact';

export interface OrchestratorLogger {
  info(message: string): void;
  warn(message: string): void;
  error?(message: string, error?: unknown): void;
}

export interface OrchestratorDependencies {
  readonly workspaceRoot: string | (() => string);
  readonly complete: (
    messages: readonly ChatMessage[],
    token: CancellationTokenLike,
  ) => Promise<CompletionResult>;
  readonly inspect: (token: CancellationTokenLike) => Promise<ProjectContext>;
  readonly retrieve: (query: string, token: CancellationTokenLike) => Promise<RetrievalResult>;
  readonly changes: IFileChangeService;
  readonly runCommand: (command: string, signal: AbortSignal, taskId?: string) => Promise<CommandResult>;
  readonly agentSettings: () => ResolvedAgentSettings;
  readonly commandSettings: () => ResolvedCommandSettings;
  /** Maximum number of tasks that may run per execution; defaults to 1 and is clamped to 1..3. */
  readonly maxConcurrentTasks?: number;
  readonly hashFile?: (path: string) => Promise<string | undefined>;
  readonly checkpointRepository?: CheckpointRepository;
  readonly analyzeImpact?: (
    changes: readonly FileChange[],
    validationCommands: readonly string[],
  ) => Promise<ChangeImpact | undefined>;
  readonly repository?: ISessionRepository;
  readonly now?: () => string;
  readonly logger?: OrchestratorLogger;
  readonly onChange?: (view: AgentSessionView) => void;
  readonly isTrusted?: () => boolean;
}

export interface IAgentController
  extends IApprovalService,
    IValidationService,
    IRepairService {
  start(requirement: string, token: CancellationTokenLike): Promise<AgentSessionView>;
  pause(sessionId: string): Promise<AgentSessionView>;
  resume(sessionId: string, token: CancellationTokenLike): Promise<AgentSessionView>;
  cancel(sessionId: string): Promise<AgentSessionView>;
  cancelTask(sessionId: string, taskId: string): Promise<AgentSessionView>;
  view(sessionId: string): AgentSessionView | undefined;
  list(): readonly AgentSessionView[];
  pendingApproval(sessionId: string): ApprovalRequest | undefined;
  restore(sessionId: string): Promise<AgentSessionView | undefined>;
  retryTask(sessionId: string, taskId: string, token: CancellationTokenLike): Promise<AgentSessionView>;
}

/** Raised for invalid controller calls, not for workflow failures. */
export class AgentSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSessionError';
  }
}

const ACTIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'running',
  'awaiting-approval',
  'applied',
  'validation-failed',
  'repairing',
]);

const DEFAULT_MAX_CONCURRENT_TASKS = 1;
const MAX_TASK_CONCURRENCY_LIMIT = 3;

/**
 * Resolves the per-execution task concurrency bound. The default keeps the
 * historical sequential behavior; the engine accepts up to three concurrent
 * tasks and rejects anything above that.
 */
function resolveMaxConcurrentTasks(value: number | undefined): number {
  const parsed = value === undefined ? DEFAULT_MAX_CONCURRENT_TASKS : Math.floor(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_CONCURRENT_TASKS;
  }
  return Math.min(MAX_TASK_CONCURRENCY_LIMIT, Math.max(DEFAULT_MAX_CONCURRENT_TASKS, parsed));
}

const INTERRUPTED_WRITE_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  'applying',
  'repairing',
]);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The workflow failed unexpectedly.';
}

function mergeAppliedFiles(existing: readonly AppliedFile[], added: readonly AppliedFile[]): AppliedFile[] {
  const byPath = new Map(existing.map((file) => [file.path, file]));
  for (const file of added) {
    byPath.set(file.path, file);
  }
  return [...byPath.values()].slice(0, 50);
}

function upsertExecution(
  executions: readonly TaskExecution[],
  taskId: string,
  patch: Partial<Omit<TaskExecution, 'taskId'>>,
): TaskExecution[] {
  const index = executions.findIndex((execution) => execution.taskId === taskId);
  if (index < 0) {
    return [
      ...executions,
      {
        taskId,
        status: 'running',
        attempts: 0,
        appliedFiles: [],
        ...patch,
      },
    ];
  }
  const existingExecution = executions[index];
  if (
    patch.status !== undefined &&
    existingExecution !== undefined &&
    !canTransitionTaskStatus(existingExecution.status, patch.status)
  ) {
    throw new Error(
      `Invalid task execution transition: ${existingExecution.status} -> ${patch.status}.`,
    );
  }
  const next = [...executions];
  if (next[index] !== undefined) {
    next[index] = { ...next[index], ...patch };
  }
  return next;
}

function mergeDiagnostics(
  existing: readonly Diagnostic[],
  added: readonly Diagnostic[],
): Diagnostic[] {
  const seen = new Set(existing.map((diagnostic) => `${diagnostic.file ?? ''}:${diagnostic.line ?? ''}:${diagnostic.message}`));
  const merged = [...existing];
  for (const diagnostic of added) {
    const key = `${diagnostic.file ?? ''}:${diagnostic.line ?? ''}:${diagnostic.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(diagnostic);
    }
  }
  return merged
    .slice(-50)
    .map((diagnostic, index) => ({ ...diagnostic, id: `diag-${index + 1}` }));
}

export class AgentOrchestrator implements IAgentController {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly busy = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly cancelledTaskIds = new Map<string, Set<string>>();
  private readonly checkpointSequences = new Map<string, number>();
  private readonly restoredExecutions = new Set<string>();
  private readonly aborters = new Map<string, AbortController>();
  private readonly maxConcurrentTasks: number;
  private readonly applyingChangeSets = new Set<string>();
  private sequence = 0;

  constructor(private readonly deps: OrchestratorDependencies) {
    this.maxConcurrentTasks = resolveMaxConcurrentTasks(deps.maxConcurrentTasks);
  }

  private currentWorkspaceRoot(): string {
    return typeof this.deps.workspaceRoot === 'function'
      ? this.deps.workspaceRoot()
      : this.deps.workspaceRoot;
  }

  async detectInterruptedExecutions(): Promise<readonly string[]> {
    return this.list()
      .filter((view) => {
        const session = this.sessions.get(view.id);
        return (
          session !== undefined &&
          !isTerminalAgentState(session.state) &&
          session.state !== 'idle' &&
          session.state !== 'completed'
        );
      })
      .map((view) => view.id);
  }

  async restoreFromCheckpoint(
    sessionId: string,
    checkpointId?: string,
  ): Promise<{
    readonly outcome:
      | 'restored'
      | 'no-interrupted-execution'
      | 'no-valid-checkpoint'
      | 'checkpoint-rejected'
      | 'restoration-failed';
    readonly message: string;
    readonly checkpointId?: string;
  }> {
    try {
      this.requireTrusted('restore an execution checkpoint');
    } catch (error) {
      return {
        outcome: 'restoration-failed',
        message: messageOf(error),
      };
    }
    let session: AgentSession;
    try {
      session = this.require(sessionId);
    } catch (error) {
      return {
        outcome: 'restoration-failed',
        message: messageOf(error),
      };
    }
    if (isTerminalAgentState(session.state)) {
      return {
        outcome: 'no-interrupted-execution',
        message: 'The execution is not interrupted.',
      };
    }
    const repository = this.deps.checkpointRepository;
    if (repository === undefined) {
      return {
        outcome: 'no-valid-checkpoint',
        message: 'No checkpoint repository is configured.',
      };
    }
    let checkpoint: ExecutionCheckpoint | undefined;
    try {
      checkpoint =
        checkpointId === undefined
          ? await repository.latest(session.id)
          : await repository.get(checkpointId);
    } catch (error) {
      return {
        outcome: 'restoration-failed',
        message: messageOf(error),
      };
    }
    if (checkpoint === undefined) {
      return {
        outcome: 'no-valid-checkpoint',
        message: 'No valid checkpoint was found for this execution.',
      };
    }
    const checkpointVersion = checkpoint.recoveryVersion ?? 0;
    const sessionVersion = session.recoveryVersion ?? 0;
    if (checkpointVersion < sessionVersion) {
      return {
        outcome: 'checkpoint-rejected',
        message: 'Checkpoint is older than the current session state.',
        checkpointId: checkpoint.id,
      };
    }
    const plan = session.plan;
    const planVersion = plan === undefined ? '' : hashContent(JSON.stringify(plan));
    const taskIds = new Set(session.tasks.map((task) => task.id));
    if (checkpoint.sessionId !== session.id || checkpoint.executionId !== session.id) {
      return {
        outcome: 'checkpoint-rejected',
        message: 'Checkpoint identity does not match the session.',
        checkpointId: checkpoint.id,
      };
    }
    if (plan !== undefined && checkpoint.planId !== plan.id) {
      return {
        outcome: 'checkpoint-rejected',
        message: 'Checkpoint plan identity does not match.',
        checkpointId: checkpoint.id,
      };
    }
    if (
      plan !== undefined &&
      checkpoint.planVersion.length > 0 &&
      checkpoint.planVersion !== planVersion
    ) {
      return {
        outcome: 'checkpoint-rejected',
        message: 'Checkpoint plan version does not match.',
        checkpointId: checkpoint.id,
      };
    }
    if (checkpoint.taskResults.some((result) => !taskIds.has(result.taskId))) {
      return {
        outcome: 'checkpoint-rejected',
        message: 'Checkpoint contains unknown task IDs.',
        checkpointId: checkpoint.id,
      };
    }
    if (checkpoint.completedTaskIds.some((id) => !taskIds.has(id))) {
      return {
        outcome: 'checkpoint-rejected',
        message: 'Checkpoint contains unknown completed task IDs.',
        checkpointId: checkpoint.id,
      };
    }
    const appliedIds = new Set(
      session.changeSets.flatMap((changeSet) => changeSet.appliedChangeIds ?? []),
    );
    if (checkpoint.appliedChangeIds.some((id) => !appliedIds.has(id))) {
      return {
        outcome: 'checkpoint-rejected',
        message: 'Checkpoint contains applied operation IDs not present in the session.',
        checkpointId: checkpoint.id,
      };
    }

    try {
      const resultById = new Map(checkpoint.taskResults.map((result) => [result.taskId, result]));
      const executionById = new Map(
        (checkpoint.executionResults ?? []).map((result) => [result.taskId, result]),
      );
      const restoredTasks = session.tasks.map((task) => {
        const result = resultById.get(task.id);
        if (result === undefined) {
          return task;
        }
        return {
          ...task,
          status: result.status,
          attempts: result.attempts ?? task.attempts,
          error: result.error,
        };
      });
      const restoredExecutions = session.executions.map((execution) => {
        const result = executionById.get(execution.taskId);
        if (result === undefined) {
          return execution;
        }
        return {
          ...execution,
          status: result.status,
          attempts: result.attempts,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          changeSetId: result.changeSetId,
          validationRunId: result.validationRunId,
          historyTaskId: result.historyTaskId,
          repairProposalId: result.repairProposalId,
          appliedFiles: result.appliedFiles,
          error: result.error,
        };
      });
      let current: AgentSession = {
        ...session,
        tasks: restoredTasks,
        executions: restoredExecutions,
        state: 'paused',
        pausedFrom: session.state,
        updatedAt: this.timestamp(),
      };
      const knownCheckpointApprovals = new Set(checkpoint.pendingApprovalIds);
      if (session.taskApprovals !== undefined) {
        const kept = session.taskApprovals.filter((candidate) =>
          knownCheckpointApprovals.has(candidate.id),
        );
        current = { ...current, taskApprovals: kept };
      }
      if (
        session.pendingApproval !== undefined &&
        !knownCheckpointApprovals.has(session.pendingApproval.id)
      ) {
        current = { ...current, pendingApproval: undefined };
      }
      current = this.withEvent(
        current,
        'state',
        `Restored checkpoint ${checkpoint.id} (sequence ${checkpoint.sequence}).`,
      );
      await this.record(current);
      await this.checkpoint(current);
      return {
        outcome: 'restored',
        message: 'Execution state restored from checkpoint.',
        checkpointId: checkpoint.id,
      };
    } catch (error) {
      return {
        outcome: 'restoration-failed',
        message: messageOf(error),
        checkpointId: checkpoint.id,
      };
    }
  }
  private async checkpoint(
    session: AgentSession,
    currentTaskId?: string,
  ): Promise<void> {
    const taskApprovals = session.taskApprovals ?? [];
    const repository = this.deps.checkpointRepository;
    if (repository === undefined) {
      return;
    }
    const latest = this.sessions.get(session.id) ?? session;
    const executionId = session.id;
    const sequence = (this.checkpointSequences.get(executionId) ?? 0) + 1;
    this.checkpointSequences.set(executionId, sequence);
    const plan = session.plan;
    const tasks = session.tasks;
    const activeTaskId =
      currentTaskId ??
      tasks.find((task) =>
        ['running', 'awaiting-approval', 'applied', 'validation-failed', 'repairing'].includes(
          task.status,
        ),
      )?.id;
    const checkpoint: ExecutionCheckpoint = {
      id: `${executionId}-checkpoint-${sequence}`,
      sessionId: session.id,
      executionId,
      sequence,
      planId: plan?.id ?? '',
      planVersion:
        plan === undefined ? '' : hashContent(JSON.stringify(plan)),
      currentTaskId: activeTaskId,
      completedTaskIds: tasks
        .filter((task) => task.status === 'completed')
        .map((task) => task.id),
      pendingTaskIds: tasks
        .filter((task) => task.status === 'pending')
        .map((task) => task.id),
      failedTaskIds: tasks
        .filter((task) => task.status === 'failed')
        .map((task) => task.id),
      blockedTaskIds: tasks
        .filter((task) => task.status === 'blocked')
        .map((task) => task.id),
      taskResults: tasks.map((task) => ({
        taskId: task.id,
        status: task.status,
        attempts: task.attempts,
        summary: task.title,
        error: task.error,
      })),
      executionResults: session.executions.map((execution) => ({
        taskId: execution.taskId,
        status: execution.status,
        attempts: execution.attempts,
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
        changeSetId: execution.changeSetId,
        validationRunId: execution.validationRunId,
        historyTaskId: execution.historyTaskId,
        repairProposalId: execution.repairProposalId,
        appliedFiles: execution.appliedFiles,
        error: execution.error,
      })),
      pendingApprovalIds:
        taskApprovals.length > 0
          ? taskApprovals.map((candidate) => candidate.id)
          : session.pendingApproval === undefined
            ? []
            : [session.pendingApproval.id],
      changeSetIds: session.changeSets.map((changeSet) => changeSet.id),
      appliedChangeIds: [
        ...new Set(
          session.changeSets.flatMap((changeSet) => changeSet.appliedChangeIds ?? []),
        ),
      ],
      validationRunIds: session.validationRuns.map((run) => run.id),
      repositoryStateRef: session.workspaceRoot,
      recoveryVersion: latest.recoveryVersion ?? 0,
      createdAt: this.timestamp(),
      status: 'valid',
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    };
    try {
      await repository.save(checkpoint);
    } catch (error) {
      this.deps.logger?.warn(`checkpoint persistence failed: ${messageOf(error)}`);
    }
  }

  private timestamp(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.sequence}`;
  }

  private require(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new AgentSessionError('Unknown agent session.');
    }
    return session;
  }

  private requireIdle(sessionId: string, action: string): void {
    this.require(sessionId);
    if (this.busy.has(sessionId)) {
      throw new AgentSessionError(`The session is busy; cannot ${action} right now.`);
    }
  }

  /**
   * Task ids that currently hold an execution slot. A task holds a slot from the
   * moment it starts running until it reaches a terminal task status; approval,
   * apply, validation and repair states keep the task in flight.
   */
  private inFlightTaskIds(session: AgentSession): readonly string[] {
    return session.tasks
      .filter((task) => ACTIVE_TASK_STATUSES.has(task.status))
      .map((task) => task.id);
  }

  /** Whether a task has been individually cancelled and must not proceed further. */
  private taskCancelled(sessionId: string, taskId: string): boolean {
    return this.cancelledTaskIds.get(sessionId)?.has(taskId) ?? false;
  }

  private requireReviewed(session: AgentSession): void {
    if (session.needsReview) {
      throw new AgentSessionError('Restore and revalidate this session before continuing.');
    }
  }

  /**
   * Every decision names the request the user actually saw. A message that
   * names no request is refused rather than applied to whatever is pending now,
   * and a request that is already decided can never be decided twice. A
   * refused message leaves the pending request and the state machine untouched.
   */
  private requireRequest(
    session: AgentSession,
    kind: ApprovalKind,
    requestId: string | undefined,
    taskId?: string,
  ): ApprovalRequest {
    const taskScoped = (session.taskApprovals ?? []).filter(
      (candidate) => candidate.kind === kind && (taskId === undefined || candidate.taskId === taskId),
    );
    const pool: ApprovalRequest[] = taskScoped.length > 0
      ? taskScoped
      : [session.pendingApproval].filter(
          (candidate): candidate is ApprovalRequest =>
            candidate !== undefined && candidate.kind === kind,
        );
    if (pool.length === 0) {
      throw new AgentSessionError(`There is no pending ${kind} approval.`);
    }
    if (typeof requestId !== 'string' || requestId.trim().length === 0) {
      throw new AgentSessionError(
        `The ${kind} decision must name the pending request. Reopen the session and review the current request.`,
      );
    }
    const request = pool.find((candidate) => candidate.id === requestId);
    if (request === undefined) {
      throw new AgentSessionError(
        'That approval refers to a superseded request. Review the current request before continuing.',
      );
    }
    if (session.approvals.some((decision) => decision.requestId === request.id)) {
      throw new AgentSessionError('This approval request was already decided.');
    }
    return request;
  }

  /** What a validation result for this task would speak for, or nothing. */
  private bindingFor(session: AgentSession, taskId: string): ValidationBinding | undefined {
    const execution = session.executions.find((candidate) => candidate.taskId === taskId);
    return bindValidation(
      session.changeSets,
      session.repairProposals,
      execution?.changeSetId,
      execution?.repairProposalId,
    );
  }

  /**
   * Finds change sets that would write the same file paths as another change set.
   * Overlapping targets between distinct change sets are reported as conflicts.
   */
  private detectChangeSetConflicts(
    sessionId: string,
    changeSetId: string,
  ): { taskId: string; changeSetId: string; path: string; reason: string }[] {
    const session = this.require(sessionId);
    const targetChangeSet = session.changeSets.find((candidate) => candidate.id === changeSetId);
    const targets = new Set<string>((targetChangeSet?.plan.changes ?? []).map((change) => change.path));
    const conflicts: { taskId: string; changeSetId: string; path: string; reason: string }[] = [];
    for (const other of session.changeSets) {
      if (other.id === changeSetId) {
        continue;
      }
      const reserved = other.status === 'approved' || other.status === 'applied' || other.status === 'partial';
      if (!reserved) {
        continue;
      }
      for (const change of other.plan.changes) {
        if (targets.has(change.path)) {
          conflicts.push({ taskId: other.taskId, changeSetId: other.id, path: change.path, reason: 'overlapping-file-target' });
        }
      }
    }
    return conflicts;
  }

  /** Drops the task-scoped approval owned by a task that reached a terminal state. */
  private removeTaskApproval(sessionId: string, taskId: string, session?: AgentSession): AgentSession {
    const source = session ?? this.require(sessionId);
    const remaining = (source.taskApprovals ?? []).filter((candidate) => candidate.taskId !== taskId);
    if (remaining.length === (source.taskApprovals ?? []).length) {
      return source;
    }
    return { ...source, taskApprovals: remaining };
  }

  /**
   * Keeps the legacy `pendingApproval` alias pointing at a still-pending task
   * approval after one is consumed; clears it when nothing remains.
   */
  private withConsumedApproval(session: AgentSession): AgentSession {
    // After consuming an approval, always clear pendingApproval so the next
    // approval must be explicitly requested via requestValidation or approveChanges.
    // This prevents stale pending approvals from blocking subsequent validation.
    return { ...session, pendingApproval: undefined };
  }

  /** Records a check that produced no command evidence, so the report stays honest. */
  private withoutCommand(
    session: AgentSession,
    taskId: string,
    outcome: ValidationOutcome,
    detail: string,
    command = '',
  ): AgentSession {
    const at = this.timestamp();
    const execution = session.executions.find((candidate) => candidate.taskId === taskId);
    const binding = this.bindingFor(session, taskId);
    const run: ValidationRun = {
      id: this.nextId('validation'),
      taskId,
      command,
      startedAt: at,
      finishedAt: at,
      outcome,
      changeSetId: execution?.changeSetId,
      changeSetVersion: binding?.changeSetVersion,
      repairProposalId: execution?.repairProposalId,
      detail: clampText(detail, 500),
    };
    return { ...session, validationRuns: [...session.validationRuns, run] };
  }

  private withEvent(
    session: AgentSession,
    type: SessionEventType,
    message: string,
    taskId?: string,
  ): AgentSession {
    const at = this.timestamp();
    const event: SessionEvent = {
      id: this.nextId('event'),
      at,
      type,
      state: session.state,
      taskId,
      message: clampText(message, MAX_EVENT_MESSAGE_CHARS),
    };
    return {
      ...session,
      updatedAt: at,
      events: [...session.events, event].slice(-MAX_SESSION_EVENTS),
    };
  }

  private withDecision(
    session: AgentSession,
    request: ApprovalRequest,
    outcome: ApprovalDecision['outcome'],
    approvedIds: readonly string[],
  ): AgentSession {
    const decision: ApprovalDecision = {
      requestId: request.id,
      kind: request.kind,
      approvedIds: [...approvedIds],
      outcome,
      decidedAt: this.timestamp(),
    };
    const updated: AgentSession = {
      ...session,
      approvals: [...session.approvals, decision].slice(-50),
    };
    return this.withEvent(updated, 'approval', `${request.kind} ${outcome}.`);
  }

  private setTasks(session: AgentSession, tasks: readonly AgentTask[]): AgentSession {
    return {
      ...session,
      tasks,
      plan: session.plan !== undefined ? { ...session.plan, tasks } : undefined,
    };
  }

  private diffsOf(prepared: PreparedChangeSet): UnifiedDiff[] {
    return prepared.review.map((change) => ({
      path: change.path,
      text: change.diff,
      additions: change.additions,
      deletions: change.deletions,
      truncated: change.diffTruncated,
    }));
  }

  private changeTaskId(sessionId: string, taskId: string): string {
    return `${sessionId}-${taskId}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  }

  private toView(session: AgentSession): AgentSessionView {
    return {
      ...session,
      events: [...session.events],
      stages: deriveStages(session),
      progress: deriveProgress(session),
    };
  }

  private viewOf(sessionId: string): AgentSessionView {
    return this.toView(this.require(sessionId));
  }

  private async record(input: AgentSession): Promise<AgentSessionView> {
    const session: AgentSession = {
      ...input,
      recoveryVersion: (input.recoveryVersion ?? 0) + 1,
      events: input.events.slice(-MAX_SESSION_EVENTS),
    };
    this.sessions.set(session.id, session);
    if (this.deps.repository !== undefined) {
      try {
        await this.deps.repository.save(session);
      } catch (error) {
        this.deps.logger?.warn(`Could not persist agent session ${session.id}: ${messageOf(error)}`);
      }
    }
    const view = this.toView(session);
    try {
      this.deps.onChange?.(view);
    } catch (error) {
      this.deps.logger?.warn(`Agent session listener failed: ${messageOf(error)}`);
    }
    return view;
  }

  private async runBusy(
    sessionId: string,
    work: () => Promise<AgentSessionView>,
  ): Promise<AgentSessionView> {
    if (this.busy.has(sessionId)) {
      throw new AgentSessionError('The session is already running an operation.');
    }
    this.busy.add(sessionId);
    try {
      return await work();
    } catch (error) {
      if (error instanceof AgentSessionError) {
        throw error;
      }
      if (this.cancelled.has(sessionId)) {
        return this.viewOf(sessionId);
      }
      this.deps.logger?.warn(`Agent session ${sessionId} failed: ${messageOf(error)}`);
      return this.failSession(sessionId, messageOf(error));
    } finally {
      this.busy.delete(sessionId);
    }
  }

  private signalToken(signal: AbortSignal): CancellationTokenLike {
    return {
      get isCancellationRequested(): boolean {
        return signal.aborted;
      },
      onCancellationRequested(listener: () => void) {
        signal.addEventListener('abort', listener, { once: true });
        return {
          dispose: (): void => {
            signal.removeEventListener('abort', listener);
          },
        };
      },
    };
  }

  private async stopIfCancelled(
    sessionId: string,
    token: CancellationTokenLike,
    message: string,
  ): Promise<AgentSessionView | undefined> {
    if (this.cancelled.has(sessionId)) {
      return this.viewOf(sessionId);
    }
    if (token.isCancellationRequested) {
      return this.cancelSession(sessionId, message);
    }
    return undefined;
  }

  view(sessionId: string): AgentSessionView | undefined {
    const session = this.sessions.get(sessionId);
    return session !== undefined ? this.toView(session) : undefined;
  }

  list(): readonly AgentSessionView[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((session) => this.toView(session));
  }

  pendingApproval(sessionId: string): ApprovalRequest | undefined {
    return this.sessions.get(sessionId)?.pendingApproval;
  }

  private requireTrusted(action: string): void {
    if ((this.deps.isTrusted ?? (() => true))() === false) {
      throw new AgentSessionError(
        `Workspace trust is required to ${action}. Open a trusted workspace or grant trust before using agent mode.`,
      );
    }
  }

  async start(requirementText: string, token: CancellationTokenLike): Promise<AgentSessionView> {
    this.requireTrusted('start an agent session');
    const at = this.timestamp();
    const id = this.nextId('session');
    const requirement = createRequirement(`${id}-requirement`, requirementText, at);
    let session: AgentSession = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id,
      workspaceRoot: this.currentWorkspaceRoot(),
      requirement,
      state: 'idle',
      needsReview: false,
      createdAt: at,
      updatedAt: at,
      providerCalls: 0,
      tasks: [],
      executions: [],
      changeSets: [],
      approvals: [],
      validationRuns: [],
      validationSuggestions: [],
      diagnostics: [],
      repairProposals: [],
      events: [],
    };
    session = transitionSession(session, 'analyzing', {
      at,
      eventId: this.nextId('event'),
      message: 'Requirement received.',
    });
    session = transitionSession(session, 'inspecting', {
      at: this.timestamp(),
      eventId: this.nextId('event'),
      message: 'Inspecting the workspace.',
    });
    await this.record(session);

    return this.runBusy(id, async () => {
      if (token.isCancellationRequested) {
        return this.cancelSession(id, 'The session was cancelled before inspection.');
      }
      const context = await this.deps.inspect(token);
      const stopped = await this.stopIfCancelled(
        id,
        token,
        'The session was cancelled during workspace inspection.',
      );
      if (stopped !== undefined) {
        return stopped;
      }

      let current = this.require(id);
      current = this.withEvent(current, 'note', `Inspected ${context.rootName}.`);
      current = {
        ...current,
        validationSuggestions: deriveValidationSuggestions(
          context.scripts,
          this.deps.commandSettings().allowlist,
          context.packageManager,
        ),
      };
      await this.record(current);

      const retrieval = await this.deps.retrieve(current.requirement.text, token);
      const stoppedAfterRetrieval = await this.stopIfCancelled(
        id,
        token,
        'The session was cancelled while selecting context.',
      );
      if (stoppedAfterRetrieval !== undefined) {
        return stoppedAfterRetrieval;
      }

      current = this.require(id);
      current = this.withEvent(
        current,
        'note',
        `Selected ${retrieval.items.length} file(s)` +
          (retrieval.skipped.length > 0 ? ` and skipped ${retrieval.skipped.length}.` : '.'),
      );
      const agentSettings = this.deps.agentSettings();
      if (current.providerCalls >= agentSettings.maxSteps) {
        return this.failSession(
          id,
          `The session reached the configured maximum of ${agentSettings.maxSteps} provider step(s).`,
        );
      }

      current = transitionSession(current, 'planning', {
        at: this.timestamp(),
        eventId: this.nextId('event'),
        message: 'Requesting a development plan.',
      });
      current = { ...current, providerCalls: current.providerCalls + 1 };
      await this.record(current);

      const result = await this.deps.complete(
        buildDevelopmentPlanMessages({
          requirement: current.requirement,
          context,
          items: retrieval.items,
          reasons: retrieval.reasons,
        }),
        token,
      );
      const stoppedAfterPlan = await this.stopIfCancelled(
        id,
        token,
        'The session was cancelled while planning.',
      );
      if (stoppedAfterPlan !== undefined) {
        return stoppedAfterPlan;
      }

      current = this.require(id);
      const parsed = parseDevelopmentPlan(result.text, {
        requirementId: current.requirement.id,
        planId: `${id}-plan`,
        createdAt: this.timestamp(),
        allowlist: this.deps.commandSettings().allowlist,
      });
      if (parsed.plan === undefined) {
        return this.failSession(
          id,
          parsed.errors.join(' ') || 'The development plan could not be parsed.',
        );
      }

      current = { ...current, plan: parsed.plan, tasks: parsed.plan.tasks };
      current = this.withEvent(
        current,
        'note',
        `The development plan contains ${parsed.plan.tasks.length} task(s).`,
      );
      const request: ApprovalRequest = {
        id: this.nextId('approval'),
        sessionId: id,
        kind: 'plan',
        title: `Plan approval: ${clampText(parsed.plan.summary, 160)}`,
        detail: [
          parsed.plan.approach,
          ...parsed.plan.risks.map((risk) => `Risk: ${risk}`),
          ...parsed.plan.warnings,
        ]
          .filter((line) => line.length > 0)
          .join(' '),
        ids: parsed.plan.tasks.map((task) => task.id),
        subjectId: parsed.plan.id,
        createdAt: this.timestamp(),
      };
      current = { ...current, pendingApproval: request };
      current = transitionSession(current, 'awaiting-plan-approval', {
        at: this.timestamp(),
        eventId: this.nextId('event'),
        message: 'The development plan is awaiting approval.',
      });
      return this.record(current);
    });
  }

  async approvePlan(
    sessionId: string,
    token: CancellationTokenLike,
    requestId: string,
  ): Promise<AgentSessionView> {
    this.requireTrusted('approve an agent plan');
    this.requireIdle(sessionId, 'approve the plan');
    const session = this.require(sessionId);
    this.requireReviewed(session);
    if (session.state !== 'awaiting-plan-approval') {
      throw new AgentSessionError('The session is not waiting for plan approval.');
    }
    const request = this.requireRequest(session, 'plan', requestId);

    return this.runBusy(sessionId, async () => {
      let current = this.require(sessionId);
      current = this.withDecision(current, request, 'approved', request.ids);
      current = { ...current, pendingApproval: undefined };
      current = transitionSession(current, 'ready', {
        at: this.timestamp(),
        eventId: this.nextId('event'),
        message: 'The plan was approved; task scheduling starts.',
      });
      await this.record(current);

      await this.checkpoint(current);

      if (current.plan === undefined || current.plan.tasks.length === 0) {
        return this.completeSession(sessionId);
      }
      return this.scheduleNext(sessionId, token);
    });
  }

  async rejectPlan(sessionId: string, requestId: string): Promise<AgentSessionView> {
    this.requireIdle(sessionId, 'reject the plan');
    const session = this.require(sessionId);
    if (session.state !== 'awaiting-plan-approval') {
      throw new AgentSessionError('The session is not waiting for plan approval.');
    }
    const request = this.requireRequest(session, 'plan', requestId);
    let current = this.withDecision(session, request, 'rejected', []);
    current = { ...current, pendingApproval: undefined };
    return this.finishRejected(current, 'The plan was rejected by the user.');
  }

  async retryTask(
    sessionId: string,
    taskId: string,
    token: CancellationTokenLike,
  ): Promise<AgentSessionView> {
    this.requireTrusted('retry a task');
    this.requireIdle(sessionId, 'retry a task');
    const session = this.require(sessionId);
    const task = findTask(session.tasks, taskId);
    if (task === undefined) {
      throw new AgentSessionError(`Task "${taskId}" is missing from the session.`);
    }
    if (task.status !== 'failed') {
      throw new AgentSessionError(`Task "${taskId}" is not eligible for retry.`);
    }
    if (task.attempts >= 3) {
      throw new AgentSessionError(`Task "${taskId}" has reached the retry limit.`);
    }
    if (!task.dependsOn.every((dependency) =>
      session.tasks.some((other) => other.id === dependency && other.status === 'completed'),
    )) {
      throw new AgentSessionError(`Task "${taskId}" has unresolved dependencies.`);
    }
    const cancelled = this.cancelled.has(sessionId);
    if (cancelled) {
      throw new AgentSessionError('The session is cancelled.');
    }

    return this.runBusy(sessionId, async () => {
      let current = this.require(sessionId);
      current = this.setTasks(
        current,
        updateTask(current.tasks, taskId, {
          status: 'pending',
          error: undefined,
        }),
      );
      current = this.withEvent(
        current,
        'task',
        `Retrying task "${task.title}" (attempt ${task.attempts + 1}).`,
        taskId,
      );
      await this.record(current);
      await this.checkpoint(current, taskId);
      return this.scheduleNext(sessionId, token);
    });
  }
  /**
   * v0.9.0-A1: starts the next eligible task while execution capacity remains.
   * The task that called this already holds its execution slot (task status is an
   * in-flight status), so the scheduler only offers tasks while a slot is free and
   * independent tasks are started one after another without waiting for the caller
   * to finish.
   */
  private async dispatchNextEligible(
    sessionId: string,
    token: CancellationTokenLike,
  ): Promise<void> {
    const current = this.require(sessionId);
    const runnable = nextRunnableTasks(current.tasks, this.maxConcurrentTasks);
    const next = runnable[0];
    if (next === undefined) {
      return;
    }
    await this.executeTask(sessionId, next.id, token);
  }

  private async scheduleNext(
    sessionId: string,
    token: CancellationTokenLike,
  ): Promise<AgentSessionView> {
    if (this.cancelled.has(sessionId)) {
      return this.viewOf(sessionId);
    }
    let current = this.require(sessionId);
    const refreshed = refreshBlockedTasks(current.tasks);
    const statusChanged = refreshed.some(
      (task, index) => task.status !== current.tasks[index]?.status,
    );
    if (statusChanged) {
      current = this.setTasks(current, refreshed);
      await this.record(current);
      await this.checkpoint(current);
    }

    const decision = schedule(current.tasks);
    switch (decision.reason) {
      case 'done':
        return this.completeSession(sessionId);
      case 'runnable':
      case 'waiting': {
        // Bounded dispatch (v0.9.0-A): start tasks only while an execution slot is
        // free, and never more than `maxConcurrentTasks` tasks per execution. The
        // scheduler yields runnable tasks in deterministic order, so a slot frees
        // only after the task that held it reached a terminal task status.
        const runnable = nextRunnableTasks(current.tasks, this.maxConcurrentTasks);
        const next = runnable[0];
        if (next === undefined) {
          if (decision.reason === 'runnable') {
            return this.failSession(sessionId, 'The scheduler did not return a runnable task.');
          }
          // An active task still holds the session; wait for an execution slot.
          return this.viewOf(sessionId);
        }
        return this.executeTask(sessionId, next.id, token);
      }
      case 'deadlock':
      case 'stopped':
        return this.failSession(sessionId, decision.detail ?? 'No runnable task remains.');
    }
  }

  private enterExecuting(session: AgentSession, message: string): AgentSession {
    if (session.state === 'executing') {
      return this.withEvent(session, 'task', message);
    }
    return transitionSession(session, 'executing', {
      at: this.timestamp(),
      eventId: this.nextId('event'),
      message,
    });
  }

  private async executeTask(
    sessionId: string,
    taskId: string,
    token: CancellationTokenLike,
  ): Promise<AgentSessionView> {
    let current = this.require(sessionId);
    const task = findTask(current.tasks, taskId);
    if (task === undefined) {
      return this.failSession(sessionId, `Task "${taskId}" is missing from the session.`);
    }
    if (task.status !== 'pending') {
      return this.failSession(sessionId, `Task "${taskId}" is not runnable.`);
    }
    if (this.inFlightTaskIds(current).length >= this.maxConcurrentTasks) {
      // Defense in depth: the scheduler must not start a task while every
      // execution slot is taken.
      return this.failSession(
        sessionId,
        `The task concurrency limit of ${this.maxConcurrentTasks} was reached.`,
      );
    }

    const attempt = task.attempts + 1;
    current = this.enterExecuting(current, `Implementing task "${task.title}".`);
    current = this.setTasks(
      current,
      updateTask(current.tasks, taskId, { status: 'running', attempts: attempt, error: undefined }),
    );
    current = {
      ...current,
      executions: upsertExecution(current.executions, taskId, {
        status: 'running',
        attempts: attempt,
        startedAt: this.timestamp(),
        finishedAt: undefined,
        appliedFiles: [],
        changeSetId: undefined,
        validationRunId: undefined,
        historyTaskId: this.changeTaskId(sessionId, taskId),
        error: undefined,
      }),
    };
    await this.record(current);

    await this.checkpoint(current, taskId);

    // v0.9.0-A1: with a free execution slot, start the next eligible task so an
    // execution dispatches independent tasks concurrently instead of stopping at
    // the first runnable task. The current task holds its slot while this runs.
    await this.dispatchNextEligible(sessionId, token);

    if (this.taskCancelled(sessionId, taskId)) {
      return this.viewOf(sessionId);
    }

    const retrieval = await this.deps.retrieve(buildTaskRequest(task), token);
    const stopped = await this.stopIfCancelled(
      sessionId,
      token,
      `The session was cancelled while retrieving context for task "${task.title}".`,
    );
    if (stopped !== undefined) {
      return stopped;
    }
    if (this.taskCancelled(sessionId, taskId)) {
      return this.viewOf(sessionId);
    }

    current = this.require(sessionId);
    const agentSettings = this.deps.agentSettings();
    if (current.providerCalls >= agentSettings.maxSteps) {
      return this.failSession(
        sessionId,
        `The session reached the configured maximum of ${agentSettings.maxSteps} provider step(s).`,
      );
    }
    current = { ...current, providerCalls: current.providerCalls + 1 };
    await this.record(current);

    const result = await this.deps.complete(
      buildPlanMessages({
        request: buildTaskRequest(task),
        summary: retrieval.summary,
        items: retrieval.items,
        reasons: retrieval.reasons,
      }),
      token,
    );
    const stoppedAfterPlan = await this.stopIfCancelled(
      sessionId,
      token,
      `The session was cancelled while implementing task "${task.title}".`,
    );
    if (stoppedAfterPlan !== undefined) {
      return stoppedAfterPlan;
    }
    if (this.taskCancelled(sessionId, taskId)) {
      return this.viewOf(sessionId);
    }

    current = this.require(sessionId);
    const parsed = parseChangePlan(result.text);
    if (parsed.plan === undefined) {
      return this.failSession(
        sessionId,
        parsed.errors.join(' ') || `Task "${task.title}" did not return a change plan.`,
        taskId,
      );
    }

    const changeTaskId = this.changeTaskId(sessionId, taskId);
    const plan: ChangePlan = {
      id: `${changeTaskId}-plan`,
      ...parsed.plan,
    };
    if (plan.changes.length === 0) {
      const completedAt = this.timestamp();
      let next = this.require(sessionId);
      next = this.setTasks(next, updateTask(next.tasks, taskId, { status: 'completed', error: undefined }));
      next = {
        ...next,
        executions: upsertExecution(next.executions, taskId, {
          status: 'completed',
          finishedAt: completedAt,
        }),
      };
      next = this.removeTaskApproval(sessionId, taskId, next);
      next = this.withoutCommand(
        next,
        taskId,
        'skipped',
        `Task "${task.title}" produced no file changes, so there was nothing to validate.`,
      );
      next = this.withEvent(
        next,
        'task',
        `Task "${task.title}" required no file changes.`,
        taskId,
      );
      await this.record(next);
      await this.checkpoint(next, taskId);
      return this.scheduleNext(sessionId, token);
    }

    let prepared: PreparedChangeSet;
    try {
      prepared = await this.deps.changes.prepare(plan, changeTaskId);
    } catch (error) {
      return this.failSession(sessionId, messageOf(error));
    }
    if (prepared.errors.length > 0) {
      return this.failSession(sessionId, prepared.errors.join(' '));
    }
    if (this.taskCancelled(sessionId, taskId)) {
      return this.viewOf(sessionId);
    }

    // Impact evidence is informational only. A failure here must never block
    // preparing or approving the change set.
    let impact: ChangeImpact | undefined;
    if (this.deps.analyzeImpact !== undefined) {
      try {
        impact = await this.deps.analyzeImpact(prepared.plan.changes, []);
      } catch (error) {
        this.deps.logger?.warn(`change impact analysis failed: ${messageOf(error)}`);
      }
    }

    const changeSetVersionForPlan = changeSetVersion({
      id: '',
      taskId: '',
      summary: '',
      plan: prepared.plan,
      diffs: [],
      warnings: [],
      createdAt: '',
      version: '',
      status: 'pending',
    });
    const changeSet: ChangeSet = {
      id: `${sessionId}-changeset-${current.changeSets.length + 1}`,
      taskId,
      summary: prepared.plan.summary,
      plan: prepared.plan,
      diffs: this.diffsOf(prepared),
      warnings: [...prepared.warnings],
      version: changeSetVersionForPlan,
      createdAt: this.timestamp(),
      status: 'pending',
      appliedChangeIds: undefined,
      ...(impact === undefined ? {} : { impact }),
    };
    let next = this.require(sessionId);
    next = { ...next, changeSets: [...next.changeSets, changeSet] };
    next = this.setTasks(next, updateTask(next.tasks, taskId, { status: 'awaiting-approval' }));
    next = {
      ...next,
      executions: upsertExecution(next.executions, taskId, {
        status: 'awaiting-approval',
        changeSetId: changeSet.id,
      }),
    };
    const request: ApprovalRequest = {
      id: this.nextId('approval'),
      sessionId,
      kind: 'change-set',
      title: `Change approval for "${task.title}"`,
      detail: [
        `${prepared.plan.summary} (version ${changeSetVersionForPlan.slice(0, 16)})`,
        impact === undefined ? '' : `Impact: ${impactSummary(impact)}`,
        impact === undefined || impact.indirectFiles.length === 0
          ? ''
          : `Affected: ${impact.indirectFiles
              .slice(0, 5)
              .map((file) => file.path)
              .join(', ')}${impact.indirectFiles.length > 5 ? ', …' : ''}`,
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
      ids: prepared.plan.changes.map((change) => change.id),
      subjectId: changeSet.id,
      changeSetVersion: changeSetVersionForPlan,
      taskId,
      createdAt: this.timestamp(),
    };
    next = { ...next, pendingApproval: request, taskApprovals: [...(next.taskApprovals ?? []), request] };
    next =
      next.state === 'awaiting-change-approval'
        ? this.withEvent(next, 'task', `The change set for task "${task.title}" is awaiting approval.`, taskId)
        : transitionSession(next, 'awaiting-change-approval', {
            at: this.timestamp(),
            eventId: this.nextId('event'),
            message: `The change set for task "${task.title}" is awaiting approval.`,
          });
    await this.checkpoint(next, taskId);
    return this.record(next);
  }

  async approveChanges(
    sessionId: string,
    approvedIds: readonly string[],
    token: CancellationTokenLike,
    requestId: string,
  ): Promise<AgentSessionView> {
    this.requireTrusted('apply file changes');
    this.requireIdle(sessionId, 'approve changes');
    const session = this.require(sessionId);
    this.requireReviewed(session);
    if (session.state !== 'awaiting-change-approval') {
      throw new AgentSessionError('The session is not waiting for change approval.');
    }
    const request = this.requireRequest(session, 'change-set', requestId);
    if (request.subjectId === undefined) {
      throw new AgentSessionError('There is no pending change set approval.');
    }

    return this.runBusy(sessionId, async () => {
      let current = this.require(sessionId);
      const changeSet = current.changeSets.find((candidate) => candidate.id === request.subjectId);
      if (changeSet === undefined) {
        return this.failSession(sessionId, 'The pending change set is missing from the session.');
      }
      if (changeSet.status === 'failed' || changeSet.status === 'rejected') {
        return this.failTask(
          sessionId,
          changeSet.taskId,
          `Change set "${changeSet.id}" is already ${changeSet.status} and cannot be applied.`,
        );
      }
      if (
        request.changeSetVersion !== undefined &&
        request.changeSetVersion !== changeSet.version
      ) {
        return this.failSession(
          sessionId,
          'The change set version no longer matches the approval. Re-review the change set before applying.',
          changeSet.taskId,
        );
      }
      if (request.taskId !== undefined && request.taskId !== changeSet.taskId) {
        return this.failSession(
          sessionId,
          `The change set "${changeSet.id}" does not belong to task "${request.taskId}". Approvals are task-scoped.`,
          changeSet.taskId,
        );
      }
      const conflicts = this.detectChangeSetConflicts(sessionId, changeSet.id);
      if (conflicts.length > 0) {
        const detail = conflicts
          .map((conflict) => `${conflict.taskId} ${conflict.changeSetId} ${conflict.path}: ${conflict.reason}`)
          .join('; ');
        return this.failTask(
          sessionId,
          changeSet.taskId,
          `Change set "${changeSet.id}" was blocked by a file conflict with an existing change set: ${detail}.`,
        );
      }
      if (changeSet.status === 'applied') {
        return this.failSession(
          sessionId,
          `The change set "${changeSet.id}" has already been applied. Duplicate apply requests are not permitted.`,
        );
      }
      // For partial ChangeSets, filter out change IDs that were already applied
      // so we only approve the eligible remaining operations.
      const previouslyAppliedIds = new Set(
        (changeSet.appliedChangeIds ?? []).map((id) => id.toLowerCase()),
      );
      const filteredApprovedIds = [...new Set(approvedIds)].filter(
        (id) => !previouslyAppliedIds.has(id.toLowerCase()),
      );
      if (filteredApprovedIds.length === 0 && approvedIds.length > 0) {
        // All approved changes were already applied; this is a duplicate request.
        return this.failSession(
          sessionId,
          `The change set "${changeSet.id}" has already been applied. No eligible remaining operations to approve.`,
        );
      }
      // Derive the exact set of eligible remaining change IDs from persisted history.
      const eligibleRemainingIds = new Set(
        changeSet.plan.changes
          .filter((change) => !previouslyAppliedIds.has(change.id.toLowerCase()))
          .map((change) => change.id),
      );
      // Verify the approved set exactly matches the eligible remaining set.
      // Reject if the approval contains already-applied IDs (should not happen due to filter,
      // but defend against races), altered operations, or missing/extra IDs.
      const approvedLower = filteredApprovedIds.map((id) => id.toLowerCase());
      const eligibleLower = eligibleRemainingIds;
      if (approvedLower.length !== eligibleLower.size) {
        return this.failSession(
          sessionId,
          `The approval does not match the exact remaining operation set for change set "${changeSet.id}". ` +
            `Approved ${approvedIds.length} change(s); eligible remaining ${eligibleRemainingIds.size} change(s). ` +
            `Approval must contain exactly the remaining change IDs; no more, no less.`,
        );
      }
      const validIds = new Set(changeSet.plan.changes.map((change) => change.id));
      // For partial ChangeSets, verify exact remaining operation set.
      // For pending ChangeSets, use original membership validation.
      let selected: string[];
      if (changeSet.status === 'partial') {
        // Verify the approved set exactly matches the eligible remaining set.
        const approvedLower = filteredApprovedIds.map((id) => id.toLowerCase());
        const eligibleLower = eligibleRemainingIds;
        if (approvedLower.length !== eligibleLower.size) {
          return this.failSession(
            sessionId,
            `The approval does not match the exact remaining operation set for change set "${changeSet.id}". ` +
              `Approved ${approvedIds.length} change(s); eligible remaining ${eligibleRemainingIds.size} change(s). ` +
              `Approval must contain exactly the remaining change IDs; no more, no less.`,
          );
        }
        let allMatching = true;
        for (const id of approvedLower) {
          if (!eligibleLower.has(id)) {
            allMatching = false;
            break;
          }
        }
        if (!allMatching) {
          return this.failSession(
            sessionId,
            `The approval does not match the exact remaining operation set for change set "${changeSet.id}". ` +
              `Approved ${approvedIds.length} change(s); eligible remaining ${eligibleRemainingIds.size} change(s). ` +
              `Approval must contain exactly the remaining change IDs; no more, no less.`,
          );
        }
        if (eligibleLower.size > 0) {
          const unapproved = [...eligibleLower].filter((id) => !approvedLower.includes(id));
          if (unapproved.length > 0) {
            return this.failSession(
              sessionId,
              `The approval does not match the exact remaining operation set for change set "${changeSet.id}". ` +
                `Approved ${approvedIds.length} change(s); eligible remaining ${eligibleRemainingIds.size} change(s). ` +
                `The following remaining change ID(s) were not approved: ${unapproved.join(', ')}. ` +
                `Approval must contain exactly the remaining change IDs; no more, no less.`,
            );
          }
        }
        selected = filteredApprovedIds;
      } else {
        // For pending ChangeSets, use original membership validation.
        selected = [...new Set(approvedIds)].filter((id) => validIds.has(id));
      }

      if (selected.length === 0 && approvedIds.length > 0) {
        throw new AgentSessionError(
          'The approved files do not belong to the current change set. Review the current change set before applying.',
        );
      }

      if (selected.length === 0) {
        current = this.withDecision(current, request, 'rejected', []);
        current = this.removeTaskApproval(sessionId, changeSet.taskId, current);
        current = this.withConsumedApproval(current);
        current = {
          ...current,
          changeSets: current.changeSets.map((cs) =>
            cs.id === changeSet.id ? { ...cs, status: 'rejected' } : cs,
          ),
        };
        current = this.setTasks(
          current,
          current.tasks.map((task) =>
            task.id === changeSet.taskId ? { ...task, status: 'skipped' as const } : task,
          ),
        );
        const hasNonTerminalTasks = current.tasks.some((task) => !isTerminalTaskStatus(task.status));
        if (hasNonTerminalTasks) {
          await this.record(current);
          return this.viewOf(sessionId);
        }
        return this.finishRejected(current, 'The change set was rejected by the user.');
      }

      current = this.withDecision(current, request, 'approved', selected);
      current = {
        ...current,
        changeSets: current.changeSets.map((cs) =>
          cs.id === changeSet.id ? { ...cs, status: 'approved' } : cs,
        ),
      };
      current = this.removeTaskApproval(sessionId, changeSet.taskId, current);
      current = this.withConsumedApproval(current);
      current = transitionSession(current, 'applying', {
        at: this.timestamp(),
        eventId: this.nextId('event'),
        message: `Applying ${selected.length} approved change(s).`,
      });
      await this.record(current);

      const historyTaskId = this.changeTaskId(sessionId, changeSet.taskId);
      const applyId = this.nextId('apply');
      if (this.applyingChangeSets.has(sessionId)) {
        return this.failTask(sessionId, changeSet.taskId, 'A change set is already being applied for this session.');
      }
      this.applyingChangeSets.add(sessionId);
      let outcome: ApplyOutcomeLike;
      try {
        const report = await this.deps.changes.apply(
          changeSet.plan,
          selected,
          historyTaskId,
          changeSet.summary,
          applyId,
        );
        outcome = report.outcome;
      } catch (error) {
        return this.failSession(sessionId, messageOf(error), changeSet.taskId);
      } finally {
        this.applyingChangeSets.delete(sessionId);
      }
      if (this.cancelled.has(sessionId)) {
        return this.viewOf(sessionId);
      }

      const appliedFiles = await this.appliedFilesOf(outcome);
      let next = this.require(sessionId);
      const previous = next.executions.find((execution) => execution.taskId === changeSet.taskId)?.appliedFiles ?? [];
      next = {
        ...next,
        executions: upsertExecution(next.executions, changeSet.taskId, {
          status: 'applied',
          appliedFiles: mergeAppliedFiles(previous, appliedFiles),
          historyTaskId,
        }),
      };
      const problems = outcome.conflicts.length + outcome.failed.length;
      next = this.withEvent(
        next,
        'apply',
        `Applied ${outcome.applied.length} of ${selected.length} change(s)` +
          (problems > 0 ? `; ${problems} problem(s) remain.` : '.'),
        changeSet.taskId,
      );
      await this.record(next);
      next = {
        ...next,
        changeSets: next.changeSets.map((cs) =>
          cs.id === changeSet.id
            ? {
                ...cs,
                status: outcome.applied.length > 0 ? ('applied' as const) : ('failed' as const),
              }
            : cs,
        ),
      };
      await this.record(next);
      await this.checkpoint(next, changeSet.taskId);

      if (outcome.applied.length === 0) {
        return this.failSession(
          sessionId,
          'No files were applied. The workspace may have changed since the plan was created.',
        );
      }
      if (outcome.applied.length !== selected.length || problems > 0) {
        return this.failSession(
          sessionId,
          `Only ${outcome.applied.length} of ${selected.length} change(s) were applied; ${problems} problem(s) remain.`,
        );
      }

      const task = findTask(this.require(sessionId).tasks, changeSet.taskId);
      if (task?.validationCommand !== undefined) {
        let validating = this.require(sessionId);
        validating = this.setTasks(
          validating,
          updateTask(validating.tasks, changeSet.taskId, { status: 'applied', error: undefined }),
        );
        validating = transitionSession(validating, 'validating', {
          at: this.timestamp(),
          eventId: this.nextId('event'),
          message: `Waiting for validation command "${task.validationCommand}".`,
        });
        return this.record(validating);
      }

      const completedAt = this.timestamp();
      let done = this.require(sessionId);
      done = this.setTasks(
        done,
        updateTask(done.tasks, changeSet.taskId, { status: 'completed', error: undefined }),
      );
      done = {
        ...done,
        executions: upsertExecution(done.executions, changeSet.taskId, {
          status: 'completed',
          finishedAt: completedAt,
        }),
      };
      done = this.withoutCommand(
        done,
        changeSet.taskId,
        'skipped',
        `Task "${task?.title ?? changeSet.taskId}" has no allowlisted validation command, so change set "${changeSet.id}" has no command evidence.`,
      );
      done = this.withEvent(
        done,
        'note',
        `Task "${task?.title ?? changeSet.taskId}" has no validation command; it is complete without command evidence.`,
        changeSet.taskId,
      );
      await this.record(done);
      // Re-evaluate the session state now that this task's change set is decided.
      // Keep the session approvable so other tasks awaiting approval are not
      // stranded behind a completed task. Never mark the session complete while
      // tasks remain pending or active.
      const otherActive = done.tasks.some(
        (t) => t.id !== changeSet.taskId && !isTerminalTaskStatus(t.status),
      );
      done = transitionSession(done, 'executing', {
        at: this.timestamp(),
        eventId: this.nextId('event'),
        message: `Change set "${changeSet.id}" applied.`,
      });
      if (otherActive) {
        done = transitionSession(done, 'awaiting-change-approval', {
          at: this.timestamp(),
          eventId: this.nextId('event'),
          message: `Other tasks still await change approval.`,
        });
      }
      await this.record(done);
      return this.scheduleNext(sessionId, token);
    });
  }

  async rejectChanges(sessionId: string, requestId: string): Promise<AgentSessionView> {
    this.requireIdle(sessionId, 'reject changes');
    const session = this.require(sessionId);
    if (session.state !== 'awaiting-change-approval') {
      throw new AgentSessionError('The session is not waiting for change approval.');
    }
    const request = this.requireRequest(session, 'change-set', requestId);
    const changeSet = session.changeSets.find((candidate) => candidate.id === request.subjectId);
    let current = this.withDecision(session, request, 'rejected', []);
    if (changeSet !== undefined) {
      // A rejected change set must never stay "pending": the guard in
      // approveChanges treats 'rejected' as already decided, and leaving it
      // pending would show the user an operation set that can be re-approved.
      current = {
        ...current,
        changeSets: current.changeSets.map((candidate) =>
          candidate.id === changeSet.id ? { ...candidate, status: 'rejected' as const } : candidate,
        ),
      };
    }
    if (changeSet?.taskId !== undefined) {
      current = this.removeTaskApproval(sessionId, changeSet.taskId, current);
    }
    current = this.withConsumedApproval(current);
    current = this.setTasks(
      current,
      current.tasks.map((task) =>
        task.id === changeSet?.taskId && !isTerminalTaskStatus(task.status)
          ? { ...task, status: 'skipped' as const }
          : task,
      ),
    );
    const hasNonTerminalTasks = current.tasks.some((task) => !isTerminalTaskStatus(task.status));
    if (hasNonTerminalTasks) {
      await this.record(current);
      return this.viewOf(sessionId);
    }
    return this.finishRejected(current, 'The change set was rejected by the user.');
  }

  /**
   * Nothing runs here. The candidate command is normalized against the current
   * allowlist and put in front of the user as an approval request naming the
   * exact command, working directory, task and change set it would verify.
   */
  async requestValidation(sessionId: string, command: string): Promise<AgentSessionView> {
    this.requireTrusted('run validation commands');
    this.requireIdle(sessionId, 'request validation');
    const session = this.require(sessionId);
    this.requireReviewed(session);
    if (session.state !== 'validating') {
      throw new AgentSessionError('The session is not waiting for validation.');
    }
    if (session.pendingApproval !== undefined) {
      throw new AgentSessionError('Another approval request is still pending.');
    }
    const task = session.tasks.find((candidate) => candidate.status === 'applied');
    if (task === undefined) {
      throw new AgentSessionError('No applied task is waiting for validation.');
    }

    return this.runBusy(sessionId, async () => {
      const settings = this.deps.commandSettings();
      const policy = evaluateCommand(command, settings.allowlist);
      if (!policy.allowed || policy.normalized === undefined) {
        let denied = this.require(sessionId);
        const diagnostic: Diagnostic = {
          id: `diag-runtime-${denied.diagnostics.length + 1}`,
          severity: 'error',
          source: 'runtime',
          message: `The validation command is not permitted: ${policy.reason}`,
          command: clampText(command, 200),
        };
        denied = { ...denied, diagnostics: [...denied.diagnostics, diagnostic].slice(-50) };
        denied = this.withoutCommand(
          denied,
          task.id,
          'unavailable',
          `The requested check could not run: ${policy.reason}`,
          clampText(command, 200),
        );
        denied = this.withEvent(denied, 'diagnostic', diagnostic.message, task.id);
        await this.record(denied);
        return this.failSession(sessionId, diagnostic.message);
      }

      const binding = this.bindingFor(this.require(sessionId), task.id);
      const cwd = this.currentWorkspaceRoot();
      const request: ApprovalRequest = {
        id: this.nextId('approval'),
        sessionId,
        kind: 'validation-command',
        title: `Run "${policy.normalized}" for "${task.title}"`,
        detail:
          `Command: ${policy.normalized}\nWorking directory: ${cwd}\nTask: ${task.id}` +
          (binding === undefined
            ? '\nThe applied change set is no longer retained, so this result would verify nothing.'
            : `\nChange set: ${binding.changeSetId} version ${binding.changeSetVersion.slice(0, 16)}.`),
        ids: [policy.normalized, cwd, task.id],
        subjectId: task.id,
        taskId: task.id,
        command: policy.normalized,
        cwd,
        createdAt: this.timestamp(),
      };
      let next = this.require(sessionId);
      next = { ...next, pendingApproval: request, taskApprovals: [...(next.taskApprovals ?? []), request] };
      next = this.withEvent(
        next,
        'approval',
        `Approval requested to run "${policy.normalized}".`,
        task.id,
      );
      return this.record(next);
    });
  }

  /** Records the refusal as a skipped run and leaves the session awaiting validation. */
  async rejectValidation(sessionId: string, requestId: string): Promise<AgentSessionView> {
    this.requireIdle(sessionId, 'reject the validation request');
    const session = this.require(sessionId);
    if (session.state !== 'validating') {
      throw new AgentSessionError('The session is not waiting for validation.');
    }
    const task = session.tasks.find((candidate) => candidate.status === 'applied');
    const request = this.requireRequest(session, 'validation-command', requestId, task?.id);
    let current = this.withDecision(session, request, 'rejected', []);
    if (task?.id !== undefined) {
      current = this.removeTaskApproval(sessionId, task.id, current);
    }
    current = this.withConsumedApproval(current);
    if (task !== undefined) {
      current = this.withoutCommand(
        current,
        task.id,
        'skipped',
        'The validation command was rejected by the user.',
        clampText(request.command ?? '', 200),
      );
    }
    return this.record(current);
  }

  /**
   * Executes only the command named by the approved request. The allowlist,
   * working directory, task and change-set binding are all re-checked against the
   * request, so approving one command can never authorize another.
   */
  async approveValidation(
    sessionId: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<AgentSessionView> {
    this.requireTrusted('run validation commands');
    this.requireIdle(sessionId, 'run the approved validation command');
    const session = this.require(sessionId);
    this.requireReviewed(session);
    if (session.state !== 'validating') {
      throw new AgentSessionError('The session is not waiting for validation.');
    }
    const task = session.tasks.find((candidate) => candidate.status === 'applied');
    if (task === undefined) {
      throw new AgentSessionError('No applied task is waiting for validation.');
    }
    const request = this.requireRequest(session, 'validation-command', requestId, task.id);
    if (request.subjectId !== task.id || request.command === undefined || request.cwd === undefined) {
      throw new AgentSessionError(
        'The approved request no longer names the applied task. Review the current request.',
      );
    }
    if (request.cwd !== this.currentWorkspaceRoot()) {
      throw new AgentSessionError(
        'The approved request belongs to a different workspace folder.',
      );
    }

    const approvedCommand = request.command;

    return this.runBusy(sessionId, async () => {
      const policy = evaluateCommand(approvedCommand, this.deps.commandSettings().allowlist);
      if (!policy.allowed || policy.normalized !== approvedCommand) {
        const reason = policy.reason ?? 'The command no longer matches the approved request.';
        let denied = this.require(sessionId);
        const diagnostic: Diagnostic = {
          id: `diag-runtime-${denied.diagnostics.length + 1}`,
          severity: 'error',
          source: 'runtime',
          message: `The approved validation command cannot run: ${reason}`,
          command: clampText(approvedCommand, 200),
        };
        denied = { ...denied, diagnostics: [...denied.diagnostics, diagnostic].slice(-50) };
        denied = this.withDecision(denied, request, 'approved', request.ids);
        denied = this.removeTaskApproval(sessionId, task.id, denied);
        denied = this.withConsumedApproval(denied);
        denied = this.withoutCommand(
          denied,
          task.id,
          'unavailable',
          `The approved check could not run: ${reason}`,
          clampText(approvedCommand, 200),
        );
        denied = this.withEvent(denied, 'diagnostic', diagnostic.message, task.id);
        return this.record(denied);
      }

      let current = this.withDecision(this.require(sessionId), request, 'approved', request.ids);
      current = this.removeTaskApproval(sessionId, task.id, current);
      current = this.withConsumedApproval(current);
      current = this.withEvent(
        current,
        'command',
        `Running approved command "${policy.normalized}".`,
        task.id,
      );
      await this.record(current);

      const startedAt = this.timestamp();
      const controller = new AbortController();
      this.aborters.set(sessionId, controller);
      const forwardAbort = (): void => {
        if (!controller.signal.aborted) {
          controller.abort();
        }
      };
      if (signal.aborted) {
        forwardAbort();
      } else {
        signal.addEventListener('abort', forwardAbort, { once: true });
      }

      let result: CommandResult;
      try {
        result = await this.deps.runCommand(policy.normalized, controller.signal, task.id);
      } catch (error) {
        return this.failSession(sessionId, messageOf(error));
      } finally {
        signal.removeEventListener('abort', forwardAbort);
        this.aborters.delete(sessionId);
      }
      const finishedAt = this.timestamp();

      if (this.cancelled.has(sessionId)) {
        return this.viewOf(sessionId);
      }
      if (result.cancelled) {
        return this.cancelSession(sessionId, 'The validation command was cancelled.');
      }

      const evidence = {
        command: result.command,
        exitCode: result.exitCode,
        passed:
          result.exitCode === 0 &&
          !result.timedOut &&
          !result.cancelled &&
          result.error === undefined,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        truncated: result.truncated,
        durationMs: result.durationMs,
        output: clampText(result.output, MAX_VALIDATION_OUTPUT_CHARS),
        error: result.error,
      };
      const testedSession = this.require(sessionId);
      const tested = testedSession.executions.find((execution) => execution.taskId === task.id);
      const binding = bindValidation(
        testedSession.changeSets,
        testedSession.repairProposals,
        tested?.changeSetId,
        tested?.repairProposalId,
      );
      const run: ValidationRun = {
        id: this.nextId('validation'),
        taskId: task.id,
        command: result.command,
        startedAt,
        finishedAt,
        outcome: evidence.passed ? 'passed' : 'failed',
        changeSetId: tested?.changeSetId,
        changeSetVersion: binding?.changeSetVersion,
        repairProposalId: tested?.repairProposalId,
        evidence,
      };

      let next = this.require(sessionId);
      next = { ...next, validationRuns: [...next.validationRuns, run] };
      next = {
        ...next,
        executions: upsertExecution(next.executions, task.id, { validationRunId: run.id }),
      };
      next = this.withEvent(
        next,
        'command',
        `"${run.command}" ${evidence.passed ? 'passed' : 'failed'} with exit code ${
          evidence.exitCode ?? 'null'
        } in ${evidence.durationMs} ms.`,
        task.id,
      );

      await this.record(next);
      await this.checkpoint(next, task.id);

      if (evidence.passed) {
        const drift = await this.verifyAppliedFiles(next, task.id);
        if (binding === undefined || drift.length > 0) {
          const staleWorkspace = drift.length > 0;
          const reason =
            binding === undefined
              ? `"${run.command}" passed, but no retained change set describes what it tested, ` +
                'so the result does not authorize the session to continue.'
              : `"${run.command}" passed, but ${drift[0]} The result no longer verifies the workspace.`;
          const unbound: Diagnostic = {
            id: `diag-runtime-${next.diagnostics.length + 1}`,
            severity: 'error',
            source: 'runtime',
            message: reason,
            command: run.command,
          };
          next = { ...next, diagnostics: [...next.diagnostics, unbound].slice(-50) };
          next = { ...next, needsReview: staleWorkspace };
          next = this.withEvent(next, 'diagnostic', reason, task.id);
          await this.record(next);
          return this.viewOf(sessionId);
        }
        next = this.setTasks(
          next,
          updateTask(next.tasks, task.id, { status: 'completed', error: undefined }),
        );
        next = {
          ...next,
          executions: upsertExecution(next.executions, task.id, {
            status: 'completed',
            finishedAt,
          }),
        };
        await this.record(next);

        let advanced = this.require(sessionId);
        if (advanced.state === 'validating') {
          const hasAwaitingTasks = advanced.tasks.some((t) => t.status === 'awaiting-approval');
          advanced = transitionSession(advanced, hasAwaitingTasks ? 'awaiting-change-approval' : 'executing', {
            at: this.timestamp(),
            eventId: this.nextId('event'),
            message: hasAwaitingTasks
              ? 'Validation passed; other tasks await change approval.'
              : 'Validation passed; scheduling the next task.',
          });
          await this.record(advanced);
        }
        return this.scheduleNext(sessionId, this.signalToken(signal));
      }

      const diagnostics = analyzeValidationFailure(run);
      next = { ...next, diagnostics: mergeDiagnostics(next.diagnostics, diagnostics) };
      next = this.setTasks(
        next,
        updateTask(next.tasks, task.id, {
          status: 'validation-failed',
          error: 'The validation command failed.',
        }),
      );
      next = {
        ...next,
        executions: upsertExecution(next.executions, task.id, {
          status: 'validation-failed',
          error: 'The validation command failed.',
        }),
      };
      next = transitionSession(next, 'diagnosing', {
        at: this.timestamp(),
        eventId: this.nextId('event'),
        message: 'Validation failed; diagnostics are available.',
      });
      return this.record(next);
    });
  }

  async generateRepair(
    sessionId: string,
    token: CancellationTokenLike,
  ): Promise<AgentSessionView> {
    this.requireTrusted('request a repair');
    this.requireIdle(sessionId, 'request a repair');
    const session = this.require(sessionId);
    this.requireReviewed(session);
    if (session.state !== 'diagnosing') {
      throw new AgentSessionError('The session is not diagnosing a failure.');
    }
    const task = session.tasks.find((candidate) => candidate.status === 'validation-failed');
    if (task === undefined) {
      throw new AgentSessionError('No failed task is waiting for a repair.');
    }

    return this.runBusy(sessionId, async () => {
      const settings = this.deps.agentSettings();
      let current = this.require(sessionId);
      const failedTask = findTask(current.tasks, task.id) ?? task;
      if (failedTask.repairAttempts >= settings.maxRepairIterations) {
        return this.failSession(
          sessionId,
          `The task reached the configured repair limit of ${settings.maxRepairIterations}.`,
        );
      }
      const run = [...current.validationRuns]
        .reverse()
        .find((candidate) => candidate.taskId === task.id && candidate.evidence !== undefined);
      if (run === undefined) {
        return this.failSession(sessionId, 'No validation evidence is available for the failed task.');
      }
      if (current.providerCalls >= settings.maxSteps) {
        return this.failSession(
          sessionId,
          `The session reached the configured maximum of ${settings.maxSteps} provider step(s).`,
        );
      }

      const attempt = failedTask.repairAttempts + 1;
      const request = this.buildRepairRequest(
        failedTask,
        run,
        current.diagnostics,
        attempt,
        settings.maxRepairIterations,
      );
      const query = [
        failedTask.title,
        ...failedTask.suggestedFiles,
        ...current.diagnostics
          .map((diagnostic) => diagnostic.file)
          .filter((file): file is string => file !== undefined),
      ].join(' ');
      const retrieval = await this.deps.retrieve(query, token);
      const stopped = await this.stopIfCancelled(
        sessionId,
        token,
        `The session was cancelled while preparing a repair for task "${task.title}".`,
      );
      if (stopped !== undefined) {
        return stopped;
      }

      current = this.require(sessionId);
      current = { ...current, providerCalls: current.providerCalls + 1 };
      await this.record(current);

      const result = await this.deps.complete(
        buildPlanMessages({
          request,
          summary: retrieval.summary,
          items: retrieval.items,
          reasons: retrieval.reasons,
        }),
        token,
      );
      const stoppedAfterPlan = await this.stopIfCancelled(
        sessionId,
        token,
        `The session was cancelled while proposing a repair for task "${task.title}".`,
      );
      if (stoppedAfterPlan !== undefined) {
        return stoppedAfterPlan;
      }

      current = this.require(sessionId);
      const parsed = parseChangePlan(result.text);
      if (parsed.plan === undefined) {
        return this.failSession(
          sessionId,
          parsed.errors.join(' ') || 'The repair proposal could not be parsed.',
        );
      }
      if (parsed.plan.changes.length === 0) {
        return this.failSession(sessionId, 'The repair proposal contained no file changes.');
      }

      const changeTaskId = this.changeTaskId(sessionId, task.id);
      const plan: ChangePlan = {
        id: `${changeTaskId}-repair-${attempt}`,
        ...parsed.plan,
      };
      let prepared: PreparedChangeSet;
      try {
        prepared = await this.deps.changes.prepare(plan, changeTaskId);
      } catch (error) {
        return this.failSession(sessionId, messageOf(error));
      }
      if (prepared.errors.length > 0) {
        return this.failSession(sessionId, prepared.errors.join(' '));
      }

      const diagnosis =
        current.diagnostics
          .filter((diagnostic) => diagnostic.severity === 'error')
          .map((diagnostic) => diagnostic.message)
          .slice(-10)
          .join(' ') || 'The validation command failed.';
      const proposal: RepairProposal = {
        id: `${sessionId}-repair-${current.repairProposals.length + 1}`,
        taskId: task.id,
        attempt,
        diagnosis,
        summary: prepared.plan.summary,
        plan: prepared.plan,
        diffs: this.diffsOf(prepared),
        createdAt: this.timestamp(),
      };
      let next = this.require(sessionId);
      next = { ...next, repairProposals: [...next.repairProposals, proposal] };
      next = this.setTasks(
        next,
        updateTask(next.tasks, task.id, { status: 'repairing', repairAttempts: attempt }),
      );
      next = {
        ...next,
        executions: upsertExecution(next.executions, task.id, { status: 'repairing' }),
      };
      const approval: ApprovalRequest = {
        id: this.nextId('approval'),
        sessionId,
        kind: 'repair',
        title: `Repair approval for "${task.title}" (attempt ${attempt})`,
        detail: prepared.plan.summary,
        ids: prepared.plan.changes.map((change) => change.id),
        subjectId: proposal.id,
        taskId: task.id,
        createdAt: this.timestamp(),
      };
      next = { ...next, pendingApproval: approval, taskApprovals: [...(next.taskApprovals ?? []), approval] };
      next = this.withEvent(
        next,
        'repair',
        `Repair attempt ${attempt} proposes ${prepared.plan.changes.length} change(s).`,
        task.id,
      );
      next = transitionSession(next, 'awaiting-repair-approval', {
        at: this.timestamp(),
        eventId: this.nextId('event'),
        message: 'The repair proposal is awaiting approval.',
      });
      return this.record(next);
    });
  }

  async approveRepair(
    sessionId: string,
    approvedIds: readonly string[],
    token: CancellationTokenLike,
    requestId: string,
  ): Promise<AgentSessionView> {
    this.requireTrusted('apply repair changes');
    this.requireIdle(sessionId, 'approve the repair');
    const session = this.require(sessionId);
    this.requireReviewed(session);
    if (session.state !== 'awaiting-repair-approval') {
      throw new AgentSessionError('The session is not waiting for repair approval.');
    }
    const request = this.requireRequest(session, 'repair', requestId);
    const taskId = request.taskId
      ?? session.tasks.find((candidate) => candidate.status === 'repairing')?.id
      ?? session.tasks.find((candidate) => candidate.status === 'validation-failed')?.id;
    const task = taskId === undefined ? undefined : session.tasks.find((candidate) => candidate.id === taskId);
    if (request.subjectId === undefined) {
      throw new AgentSessionError('There is no pending repair approval.');
    }

    return this.runBusy(sessionId, async () => {
      const cancelledEarly = await this.stopIfCancelled(
        sessionId,
        token,
        'The session was cancelled before the repair was applied.',
      );
      if (cancelledEarly !== undefined) {
        return cancelledEarly;
      }
      let current = this.require(sessionId);
      const proposal = current.repairProposals.find((candidate) => candidate.id === request.subjectId);
      if (proposal === undefined) {
        return this.failSession(sessionId, 'The pending repair proposal is missing from the session.');
      }
      const validIds = new Set(proposal.plan.changes.map((change) => change.id));
      const selected = [...new Set(approvedIds)].filter((id) => validIds.has(id));

      if (selected.length === 0 && approvedIds.length > 0) {
        throw new AgentSessionError(
          'The approved files do not belong to the current repair proposal. Review the current proposal before applying.',
        );
      }

      if (selected.length === 0) {
        let rejected = this.withDecision(current, request, 'rejected', []);
        rejected = task === undefined ? rejected : this.removeTaskApproval(sessionId, task.id, rejected);
        rejected = this.withConsumedApproval(rejected);
        await this.record(rejected);
        return this.failSession(sessionId, 'The repair proposal was rejected by the user.');
      }

      current = this.withDecision(current, request, 'approved', selected);
      current = task === undefined ? current : this.removeTaskApproval(sessionId, task.id, current);
      current = this.withConsumedApproval(current);
      current = transitionSession(current, 'repairing', {
        at: this.timestamp(),
        eventId: this.nextId('event'),
        message: `Applying ${selected.length} approved repair change(s).`,
      });
      await this.record(current);

      const historyTaskId = this.changeTaskId(sessionId, proposal.taskId);
      const applyId = this.nextId('apply');
      let outcome: ApplyOutcomeLike;
      try {
        const report = await this.deps.changes.apply(
          proposal.plan,
          selected,
          historyTaskId,
          proposal.summary,
          applyId,
        );
        outcome = report.outcome;
      } catch (error) {
        return this.failSession(sessionId, messageOf(error));
      }
      if (this.cancelled.has(sessionId)) {
        return this.viewOf(sessionId);
      }

      const appliedFiles = await this.appliedFilesOf(outcome);
      let next = this.require(sessionId);
      const previous = next.executions.find((execution) => execution.taskId === proposal.taskId)?.appliedFiles ?? [];
      next = {
        ...next,
        executions: upsertExecution(next.executions, proposal.taskId, {
          status: 'applied',
          appliedFiles: mergeAppliedFiles(previous, appliedFiles),
          historyTaskId,
          repairProposalId: proposal.id,
        }),
      };
      const problems = outcome.conflicts.length + outcome.failed.length;
      next = this.withEvent(
        next,
        'apply',
        `Applied ${outcome.applied.length} of ${selected.length} repair change(s)` +
          (problems > 0 ? `; ${problems} problem(s) remain.` : '.'),
        proposal.taskId,
      );
      await this.record(next);
      await this.checkpoint(next, proposal.taskId);

      if (outcome.applied.length === 0) {
        return this.failSession(
          sessionId,
          'No repair files were applied. The workspace may have changed since the proposal was created.',
        );
      }
      if (outcome.applied.length !== selected.length || problems > 0) {
        return this.failSession(
          sessionId,
          `Only ${outcome.applied.length} of ${selected.length} repair change(s) were applied; ${problems} problem(s) remain.`,
        );
      }

      let validating = this.require(sessionId);
      validating = this.setTasks(
        validating,
        updateTask(validating.tasks, proposal.taskId, { status: 'applied', error: undefined }),
      );
      validating = transitionSession(validating, 'validating', {
        at: this.timestamp(),
        eventId: this.nextId('event'),
        message: 'The repair was applied; validation must run again.',
      });
      return this.record(validating);
    });
  }

  async rejectRepair(sessionId: string, requestId: string): Promise<AgentSessionView> {
    this.requireIdle(sessionId, 'reject the repair');
    const session = this.require(sessionId);
    if (session.state !== 'awaiting-repair-approval') {
      throw new AgentSessionError('The session is not waiting for repair approval.');
    }
    const request = this.requireRequest(session, 'repair', requestId);
    const taskId = request.taskId
      ?? session.tasks.find((candidate) => candidate.status === 'repairing')?.id
      ?? session.tasks.find((candidate) => candidate.status === 'validation-failed')?.id;
    const task = taskId === undefined ? undefined : session.tasks.find((candidate) => candidate.id === taskId);
    let rejected = this.withDecision(session, request, 'rejected', []);
    if (task?.id !== undefined) {
      rejected = this.removeTaskApproval(sessionId, task.id, rejected);
    }
    rejected = this.withConsumedApproval(rejected);
    await this.record(rejected);
    return this.failSession(sessionId, 'The repair proposal was rejected by the user.');
  }

  async pause(sessionId: string): Promise<AgentSessionView> {
    this.requireIdle(sessionId, 'pause');
    const session = this.require(sessionId);
    if (isTerminalAgentState(session.state)) {
      throw new AgentSessionError(
        `The session has already finished (${STATE_LABELS[session.state].toLowerCase()}) and cannot be paused. Start a new session instead.`,
      );
    }
    if (session.state === 'paused') {
      throw new AgentSessionError('The session is already paused. Resume it to continue.');
    }
    if (!canPause(session.state)) {
      throw new AgentSessionError('The session cannot pause while work is in progress.');
    }
    const paused = transitionSession(session, 'paused', {
      at: this.timestamp(),
      eventId: this.nextId('event'),
      message: 'Paused by the user.',
      pausedFrom: session.state,
    });
    return this.record(paused);
  }

  async resume(
    sessionId: string,
    token: CancellationTokenLike,
  ): Promise<AgentSessionView> {
    this.requireTrusted('resume an agent session');
    this.requireIdle(sessionId, 'resume');
    const session = this.require(sessionId);
    if (session.state !== 'paused') {
      throw new AgentSessionError('Only a paused session can be resumed.');
    }
    if (session.needsReview) {
      throw new AgentSessionError('Restore and revalidate this session before resuming.');
    }
    if (session.plan === undefined) {
      throw new AgentSessionError('This session has no persisted plan; start a new session.');
    }
    const target = session.pausedFrom ?? 'ready';
    const resumed = transitionSession(session, target, {
      at: this.timestamp(),
      eventId: this.nextId('event'),
      message: `Resumed by the user to ${target}.`,
    });
    await this.record(resumed);

    if (target === 'ready') {
      return this.runBusy(sessionId, async () => this.scheduleNext(sessionId, token));
    }
    return this.viewOf(sessionId);
  }

  async cancel(sessionId: string): Promise<AgentSessionView> {
    return this.cancelSession(sessionId, 'The session was cancelled by the user.');
  }

  /**
   * Cancels a single active task without touching unrelated tasks. The
   * cancelled task's execution slot is released, its pending approvals are
   * invalidated, and it can never be dispatched again. Other active tasks
   * continue unaffected.
   */
  async cancelTask(sessionId: string, taskId: string): Promise<AgentSessionView> {
    this.requireIdle(sessionId, 'cancel a task');
    const session = this.require(sessionId);
    const task = findTask(session.tasks, taskId);
    if (task === undefined) {
      throw new AgentSessionError(`Task "${taskId}" is missing from the session.`);
    }
    if (!ACTIVE_TASK_STATUSES.has(task.status)) {
      throw new AgentSessionError(
        `Task "${taskId}" is not active and cannot be cancelled.`,
      );
    }

    return this.runBusy(sessionId, async () => {
      let current = this.require(sessionId);
      const taskToCancel = findTask(current.tasks, taskId);
      if (taskToCancel === undefined || !ACTIVE_TASK_STATUSES.has(taskToCancel.status)) {
        throw new AgentSessionError(
          `Task "${taskId}" is not active and cannot be cancelled.`,
        );
      }

      const cancelledAt = this.timestamp();
      let cancelled = this.cancelledTaskIds.get(sessionId) ?? new Set<string>();
      cancelled = new Set([...cancelled, taskId]);
      this.cancelledTaskIds.set(sessionId, cancelled);

      current = this.setTasks(
        current,
        current.tasks.map((t) =>
          t.id === taskId ? { ...t, status: 'cancelled' as const, error: 'The task was cancelled.' } : t,
        ),
      );
      current = {
        ...current,
        executions: current.executions.map((execution) =>
          execution.taskId === taskId && ACTIVE_TASK_STATUSES.has(execution.status)
            ? { ...execution, status: 'cancelled' as const, finishedAt: cancelledAt, error: 'The task was cancelled.' }
            : execution,
        ),
      };
      current = this.removeTaskApproval(sessionId, taskId, current);
      // A cancelled task's pending change sets can never be applied.
      current = {
        ...current,
        changeSets: current.changeSets.map((cs) =>
          cs.taskId === taskId && (cs.status === 'pending' || cs.status === 'approved')
            ? { ...cs, status: 'failed' as const }
            : cs,
        ),
      };
      current = this.withEvent(current, 'task', `Task "${taskToCancel.title}" was cancelled.`, taskId);
      await this.checkpoint(current, taskId);
      // Persist the cancellation first so the settle logic observes it.
      const recorded = await this.record(current);
      // A cancelled task must not strand the session in a working state with
      // nothing in flight (D7). Settle remaining work so pause stays honest.
      const settled = await this.settleAfterTaskCancellation(sessionId);
      return settled ?? recorded;
    });
  }

  /**
   * Settles a session whose tasks were just cancelled (D7). If tasks remain
   * in flight nothing happens; otherwise blocked or finished work is resolved
   * and the session is parked in `ready`, completed, or failed honestly. This
   * is what keeps pause() truthful: a resting session never reports phantom
   * work in progress.
   */
  private async settleAfterTaskCancellation(
    sessionId: string,
  ): Promise<AgentSessionView | undefined> {
    let current = this.require(sessionId);
    const refreshed = refreshBlockedTasks(current.tasks);
    const blockedChanged = refreshed.some(
      (task, index) => task.status !== current.tasks[index]?.status,
    );
    if (blockedChanged) {
      current = this.setTasks(current, refreshed);
      await this.record(current);
    }
    if (isTerminalAgentState(current.state) || current.state === 'paused') {
      return this.viewOf(sessionId);
    }
    if (this.inFlightTaskIds(current).length > 0) {
      return undefined;
    }
    const decision = schedule(current.tasks);
    if (decision.reason === 'done') {
      return this.completeSession(sessionId);
    }
    if (decision.reason === 'deadlock' || decision.reason === 'stopped') {
      return this.failSession(sessionId, decision.detail ?? 'No runnable task remains.');
    }
    if (current.state === 'executing' || current.state === 'validating') {
      const parked = transitionSession(current, 'ready', {
        at: this.timestamp(),
        eventId: this.nextId('event'),
        message: 'Task cancelled; remaining work waits for the user.',
      });
      return this.record(parked);
    }
    return undefined;
  }

  private async cancelSession(sessionId: string, message: string): Promise<AgentSessionView> {
    const session = this.require(sessionId);
    if (isTerminalAgentState(session.state)) {
      return this.toView(session);
    }
    this.cancelled.add(sessionId);
    this.aborters.get(sessionId)?.abort();

    let current = session;
    if (current.state !== 'cancelling') {
      current = transitionSession(current, 'cancelling', {
        at: this.timestamp(),
        eventId: this.nextId('event'),
        message: 'Cancellation requested.',
      });
    }
    const cancelledAt = this.timestamp();
    const cancelledTaskIds = new Set(
      current.tasks
        .filter((task) => !isTerminalTaskStatus(task.status))
        .map((task) => task.id),
    );
    const tasks = current.tasks.map((task) =>
      isTerminalTaskStatus(task.status) ? task : { ...task, status: 'cancelled' as const },
    );
    const executions = current.executions.map((execution) =>
      isTerminalTaskStatus(execution.status)
        ? execution
        : { ...execution, status: 'cancelled' as const, finishedAt: cancelledAt },
    );
    current = this.setTasks(
      { ...current, executions, pendingApproval: undefined },
      tasks,
    );
    for (const taskId of cancelledTaskIds) {
      current = this.removeTaskApproval(sessionId, taskId, current);
    }
    current = this.withEvent(current, 'note', message);
    current = transitionSession(current, 'cancelled', {
      at: cancelledAt,
      eventId: this.nextId('event'),
      message: 'The session was cancelled.',
    });
    await this.checkpoint(current);
    return this.finishWithReport(current);
  }

  private async completeSession(sessionId: string): Promise<AgentSessionView> {
    const session = this.require(sessionId);
    if (isTerminalAgentState(session.state)) {
      return this.toView(session);
    }
    const completed = transitionSession(session, 'completed', {
      at: this.timestamp(),
      eventId: this.nextId('event'),
      message: 'All scheduled tasks are complete.',
    });
    return this.finishWithReport(completed);
  }

  /**
   * Fails just one task without tearing down the session, so other tasks
   * keep their state, including any pending approvals, and can proceed.
   */
  private async failTask(
    sessionId: string,
    taskId: string,
    message: string,
  ): Promise<AgentSessionView> {
    let current = this.require(sessionId);
    const at = this.timestamp();
    current = this.setTasks(
      current,
      current.tasks.map((task) => {
        if (task.id === taskId && ACTIVE_TASK_STATUSES.has(task.status)) {
          return { ...task, status: 'failed' as const, error: message };
        }
        return task;
      }),
    );
    current = {
      ...current,
      executions: current.executions.map((execution) => {
        if (execution.taskId === taskId && ACTIVE_TASK_STATUSES.has(execution.status)) {
          return { ...execution, status: 'failed' as const, finishedAt: at, error: message };
        }
        return execution;
      }),
    };
    current = {
      ...current,
      changeSets: current.changeSets.map((changeSet) =>
        changeSet.taskId === taskId && (changeSet.status === 'pending' || changeSet.status === 'approved')
          ? { ...changeSet, status: 'failed' as const }
          : changeSet,
      ),
    };
    current = this.removeTaskApproval(sessionId, taskId, current);
    const diagnostic: Diagnostic = {
      id: `diag-runtime-${current.diagnostics.length + 1}`,
      severity: 'error',
      source: 'runtime',
      message: clampText(message, 2_000),
    };
    current = { ...current, diagnostics: [...current.diagnostics, diagnostic].slice(-50) };
    current = this.withEvent(current, 'diagnostic', message, taskId);
    await this.checkpoint(current, taskId);
    return this.record(current);
  }

  private async failSession(
    sessionId: string,
    message: string,
    taskId?: string,
  ): Promise<AgentSessionView> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new AgentSessionError('Unknown agent session.');
    }
    if (this.cancelled.has(sessionId) || isTerminalAgentState(session.state)) {
      return this.toView(session);
    }
    const at = this.timestamp();
    const failed = transitionSession(session, 'failed', {
      at,
      eventId: this.nextId('event'),
      message,
    });
    let current: AgentSession = {
      ...failed,
      pendingApproval: undefined,
      error: message,
    };
    current = this.setTasks(
      current,
      current.tasks.map((task) => {
        const taskFailed = taskId === undefined || task.id === taskId;
        if (taskFailed && ACTIVE_TASK_STATUSES.has(task.status)) {
          return { ...task, status: 'failed' as const, error: message };
        }
        if (taskId !== undefined && task.id !== taskId) {
          // An attributed task failure must not tear down unrelated in-flight tasks.
          return task;
        }
        return isTerminalTaskStatus(task.status)
          ? task
          : { ...task, status: 'skipped' as const };
      }),
    );
    current = taskId === undefined ? current : this.removeTaskApproval(sessionId, taskId, current);
    current = {
      ...current,
      executions: current.executions.map((execution) => {
        const executionFailed = taskId === undefined || execution.taskId === taskId;
        if (executionFailed && ACTIVE_TASK_STATUSES.has(execution.status)) {
          return { ...execution, status: 'failed' as const, finishedAt: at, error: message };
        }
        return execution;
      }),
    };
    const diagnostic: Diagnostic = {
      id: `diag-runtime-${current.diagnostics.length + 1}`,
      severity: 'error',
      source: 'runtime',
      message: clampText(message, 2_000),
    };
    current = {
      ...current,
      diagnostics: [...current.diagnostics, diagnostic].slice(-50),
    };
    current = this.withEvent(current, 'diagnostic', message);
    await this.checkpoint(current);
    return this.finishWithReport(current);
  }

  private async finishRejected(
    session: AgentSession,
    message: string,
  ): Promise<AgentSessionView> {
    let current = this.withEvent(session, 'note', message);
    current = transitionSession(current, 'rejected', {
      at: this.timestamp(),
      eventId: this.nextId('event'),
      message,
    });
    current = this.setTasks(
      current,
      current.tasks.map((task) =>
        isTerminalTaskStatus(task.status) ? task : { ...task, status: 'skipped' as const },
      ),
    );
    await this.checkpoint(current);
    return this.finishWithReport(current);
  }

  private async finishWithReport(session: AgentSession): Promise<AgentSessionView> {
    const at = this.timestamp();
    const report = buildCompletionReport(session, at);
    const event: SessionEvent = {
      id: this.nextId('event'),
      at,
      type: 'report',
      state: session.state,
      message: `Completion report generated with outcome "${report.outcome}".`,
    };
    const withReport: AgentSession = {
      ...session,
      updatedAt: at,
      report,
      events: [...session.events, event].slice(-MAX_SESSION_EVENTS),
    };
    return this.record(withReport);
  }

  private async appliedFilesOf(outcome: ApplyOutcomeLike): Promise<AppliedFile[]> {
    const files: AppliedFile[] = [];
    for (const file of outcome.applied) {
      const fallback = file.kind === 'delete' ? (file.before ?? '') : (file.after ?? file.before ?? '');
      let hash = hashContent(fallback);
      if (file.kind !== 'delete' && this.deps.hashFile !== undefined) {
        const actual = await this.deps.hashFile(file.path);
        if (actual !== undefined) {
          hash = actual;
        }
      }
      files.push({ path: file.path, hash, kind: file.kind });
    }
    return files;
  }

  private buildRepairRequest(
    task: AgentTask,
    run: ValidationRun,
    diagnostics: readonly Diagnostic[],
    attempt: number,
    maxAttempts: number,
  ): string {
    const errors = diagnostics
      .filter((diagnostic) => diagnostic.severity === 'error')
      .slice(-10)
      .map(
        (diagnostic) =>
          `- ${diagnostic.message}${
            diagnostic.file !== undefined
              ? ` (${diagnostic.file}${diagnostic.line !== undefined ? `:${diagnostic.line}` : ''})`
              : ''
          }`,
      );
    return [
      buildTaskRequest(task),
      '',
      'A previous change set was applied, but validation failed. Produce a complete replacement change plan that fixes the failure.',
      `Validation command: ${run.command}`,
      `Exit code: ${run.evidence?.exitCode ?? 'null'}`,
      run.evidence?.timedOut === true ? 'The command timed out.' : '',
      `Repair attempt ${attempt} of ${maxAttempts}.`,
      errors.length > 0 ? `Diagnostics:\n${errors.join('\n')}` : '',
      'Validation output (truncated, redacted):',
      run.evidence === undefined ? '' : run.evidence.output.slice(0, 8_000),
      '',
      'Reuse the existing file paths where appropriate. Return complete file contents.',
    ]
      .filter((line) => line.length > 0)
      .join('\n');
  }

  async loadStoredSessions(): Promise<readonly AgentSessionView[]> {
    if (this.deps.repository === undefined) {
      return this.list();
    }
    let stored: readonly AgentSession[];
    try {
      stored = await this.deps.repository.load();
    } catch (error) {
      this.deps.logger?.warn(`Could not load persisted agent sessions: ${messageOf(error)}`);
      return this.list();
    }
    for (const session of stored) {
      if (this.sessions.has(session.id)) {
        continue;
      }
      const loaded: AgentSession = isTerminalAgentState(session.state)
        ? session
        : {
            ...session,
            needsReview: true,
            tasks: session.tasks.map((task) =>
              task.status === 'running'
                ? { ...task, status: 'failed' as const, error: 'Interrupted by extension restart.' }
                : task,
            ),
          };
      this.sessions.set(session.id, loaded);
    }

    if (this.deps.isTrusted === undefined || this.deps.isTrusted()) {
      for (const session of [...this.sessions.values()]) {
        if (isTerminalAgentState(session.state)) {
          continue;
        }
        if (this.restoredExecutions.has(session.id)) {
          continue;
        }
        const interrupted = (await this.detectInterruptedExecutions()).includes(session.id);
        if (!interrupted) {
          continue;
        }
        this.restoredExecutions.add(session.id);
        try {
          await this.restoreFromCheckpoint(session.id);
        } catch (error) {
          this.deps.logger?.warn(
            `Checkpoint restoration failed for ${session.id}: ${messageOf(error)}`,
          );
        }
      }
    }
    return this.list();
  }

  async restore(sessionId: string): Promise<AgentSessionView | undefined> {
    if (this.busy.has(sessionId)) {
      throw new AgentSessionError('The session is busy; cannot restore it right now.');
    }
    let session = this.sessions.get(sessionId);
    if (session === undefined && this.deps.repository !== undefined) {
      session = await this.deps.repository.get(sessionId);
    }
    if (session === undefined) {
      return undefined;
    }
    if (session.workspaceRoot !== this.currentWorkspaceRoot()) {
      this.deps.logger?.warn(
        `Session ${sessionId} belongs to a different workspace and was not restored.`,
      );
      return undefined;
    }
    if (isTerminalAgentState(session.state)) {
      this.sessions.set(sessionId, session);
      return this.toView(session);
    }
    this.requireTrusted('restore an active agent session');

    const original = session.state;
    let current = this.withEvent(
      session,
      'note',
      `Restoring a persisted session last recorded in state "${original}".`,
    );
    if (
      original === 'executing' ||
      original === 'analyzing' ||
      original === 'inspecting' ||
      original === 'planning'
    ) {
      const tasks = current.tasks.map((task) =>
        task.status === 'running' || task.status === 'awaiting-approval'
          ? { ...task, status: 'failed' as const, error: 'Interrupted by extension restart.' }
          : task,
      );
      const executions = current.executions.map((execution) =>
        execution.status === 'running' || execution.status === 'awaiting-approval'
          ? { ...execution, status: 'failed' as const, finishedAt: execution.finishedAt ?? this.timestamp(), error: 'Interrupted by extension restart.' }
          : execution,
      );
      current = this.setTasks(
        { ...current, executions, pendingApproval: undefined },
        tasks,
      );
    }

    const problems = await this.verifyAppliedFiles(current);
    if (problems.length > 0) {
      const message = problems.join(' ');
      let failed: AgentSession = {
        ...current,
        state: 'failed',
        pausedFrom: undefined,
        needsReview: true,
        error: message,
        pendingApproval: undefined,
      };
      failed = this.withEvent(failed, 'diagnostic', message);
      this.sessions.set(sessionId, failed);
      return this.finishWithReport(failed);
    }

    if (INTERRUPTED_WRITE_STATES.has(original)) {
      const message =
        'The session was interrupted while approved changes were being written. Review the workspace before retrying.';
      let failed: AgentSession = {
        ...current,
        state: 'failed',
        pausedFrom: undefined,
        needsReview: true,
        error: message,
        pendingApproval: undefined,
      };
      failed = this.withEvent(failed, 'diagnostic', message);
      this.sessions.set(sessionId, failed);
      return this.finishWithReport(failed);
    }

    let state: AgentState;
    let pausedFrom: AgentState | undefined;
    switch (original) {
      case 'validating':
        state = 'validating';
        break;
      case 'diagnosing':
        state = 'diagnosing';
        break;
      case 'cancelling':
        state = 'cancelled';
        break;
      case 'awaiting-plan-approval':
      case 'awaiting-change-approval':
      case 'awaiting-repair-approval':
        state = original;
        break;
      default:
        state = 'paused';
        pausedFrom = 'ready';
        break;
    }

    if (state === 'cancelled') {
      const cancelled: AgentSession = {
        ...current,
        state,
        pausedFrom: undefined,
        needsReview: true,
        pendingApproval: undefined,
      };
      this.cancelled.add(sessionId);
      this.sessions.set(sessionId, cancelled);
      return this.finishWithReport(cancelled);
    }

    const unverified = this.deps.hashFile === undefined;
    let restored: AgentSession = {
      ...current,
      state,
      pausedFrom,
      needsReview: unverified,
    };
    const continuation = computeContinuationPlan(
      restored.tasks.map((task) => ({ id: task.id, status: task.status, dependencies: task.dependsOn })),
    );
    if (continuation.interrupted.length > 0 || continuation.failed.length > 0 || continuation.blocked.length > 0) {
      restored = this.withEvent(
        restored,
        'note',
        `Continuation plan: ${continuation.resumable.length} resumable, ${continuation.failed.length} failed, ${continuation.blocked.length} blocked task(s).`,
      );
    }
    return this.record(restored);
  }

  /**
   * Compares the files the session wrote with what is on disk now. Pass a task id
   * to check one task's writes, or none for the whole session.
   */
  private async verifyAppliedFiles(
    session: AgentSession,
    taskId?: string,
  ): Promise<string[]> {
    if (this.deps.hashFile === undefined) {
      return [];
    }
    const hashFile = this.deps.hashFile;
    const problems: string[] = [];
    for (const execution of session.executions) {
      if (taskId !== undefined && execution.taskId !== taskId) {
        continue;
      }
      for (const file of execution.appliedFiles) {
        const actual = await hashFile(file.path);
        if (file.kind === 'delete') {
          if (actual !== undefined) {
            problems.push(`${file.path} was recreated after the session deleted it.`);
          }
        } else if (actual === undefined) {
          problems.push(`${file.path} no longer exists.`);
        } else if (actual !== file.hash) {
          problems.push(`${file.path} changed after it was applied.`);
        }
      }
    }
    return problems;
  }

  async remove(sessionId: string): Promise<void> {
    if (this.busy.has(sessionId)) {
      throw new AgentSessionError('The session is busy; it cannot be removed right now.');
    }
    this.sessions.delete(sessionId);
    this.cancelled.delete(sessionId);
    this.aborters.delete(sessionId);
    if (this.deps.repository !== undefined) {
      try {
        await this.deps.repository.remove(sessionId);
      } catch (error) {
        this.deps.logger?.warn(`Could not remove agent session ${sessionId}: ${messageOf(error)}`);
      }
    }
  }
}
