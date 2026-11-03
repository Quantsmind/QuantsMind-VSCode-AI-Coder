import { hashContent, type ChangePlan } from '../changes/model';
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
  type ApprovalRequest,
  type ChangeSet,
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
  type ValidationRun,
} from './models';
import { buildDevelopmentPlanMessages, buildTaskRequest, parseDevelopmentPlan } from './planning';
import { buildCompletionReport } from './report';
import { findTask, refreshBlockedTasks, schedule, updateTask } from './scheduler';
import { canPause, deriveStages, transitionSession } from './stateMachine';
import type { ISessionRepository } from '../sessions/repository';

export interface OrchestratorLogger {
  info(message: string): void;
  warn(message: string): void;
  error?(message: string, error?: unknown): void;
}

export interface OrchestratorDependencies {
  readonly workspaceRoot: string;
  readonly complete: (
    messages: readonly ChatMessage[],
    token: CancellationTokenLike,
  ) => Promise<CompletionResult>;
  readonly inspect: (token: CancellationTokenLike) => Promise<ProjectContext>;
  readonly retrieve: (query: string, token: CancellationTokenLike) => Promise<RetrievalResult>;
  readonly changes: IFileChangeService;
  readonly runCommand: (command: string, signal: AbortSignal) => Promise<CommandResult>;
  readonly agentSettings: () => ResolvedAgentSettings;
  readonly commandSettings: () => ResolvedCommandSettings;
  readonly hashFile?: (path: string) => Promise<string | undefined>;
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
  view(sessionId: string): AgentSessionView | undefined;
  list(): readonly AgentSessionView[];
  pendingApproval(sessionId: string): ApprovalRequest | undefined;
  restore(sessionId: string): Promise<AgentSessionView | undefined>;
  loadStoredSessions(): Promise<readonly AgentSessionView[]>;
  remove(sessionId: string): Promise<void>;
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
  const next = [...executions];
  next[index] = { ...next[index], ...patch };
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
  private readonly aborters = new Map<string, AbortController>();
  private sequence = 0;

  constructor(private readonly deps: OrchestratorDependencies) {}

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

  private requireReviewed(session: AgentSession): void {
    if (session.needsReview) {
      throw new AgentSessionError('Restore and revalidate this session before continuing.');
    }
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
    };
  }

  private viewOf(sessionId: string): AgentSessionView {
    return this.toView(this.require(sessionId));
  }

  private async record(input: AgentSession): Promise<AgentSessionView> {
    const session: AgentSession = {
      ...input,
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
      workspaceRoot: this.deps.workspaceRoot,
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
        detail: [parsed.plan.approach, ...parsed.plan.warnings].filter((line) => line.length > 0).join(' '),
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

  async approvePlan(sessionId: string, token: CancellationTokenLike): Promise<AgentSessionView> {
    this.requireTrusted('approve an agent plan');
    this.requireIdle(sessionId, 'approve the plan');
    const session = this.require(sessionId);
    this.requireReviewed(session);
    if (session.state !== 'awaiting-plan-approval') {
      throw new AgentSessionError('The session is not waiting for plan approval.');
    }
    const request = session.pendingApproval;
    if (request === undefined || request.kind !== 'plan') {
      throw new AgentSessionError('There is no pending plan approval.');
    }

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

      if (current.plan === undefined || current.plan.tasks.length === 0) {
        return this.completeSession(sessionId);
      }
      return this.scheduleNext(sessionId, token);
    });
  }

  async rejectPlan(sessionId: string): Promise<AgentSessionView> {
    this.requireIdle(sessionId, 'reject the plan');
    const session = this.require(sessionId);
    if (session.state !== 'awaiting-plan-approval') {
      throw new AgentSessionError('The session is not waiting for plan approval.');
    }
    const request = session.pendingApproval;
    if (request === undefined || request.kind !== 'plan') {
      throw new AgentSessionError('There is no pending plan approval.');
    }
    let current = this.withDecision(session, request, 'rejected', []);
    current = { ...current, pendingApproval: undefined };
    return this.finishRejected(current, 'The plan was rejected by the user.');
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
    }

    const decision = schedule(current.tasks);
    switch (decision.reason) {
      case 'done':
        return this.completeSession(sessionId);
      case 'runnable':
        if (decision.runnable === undefined) {
          return this.failSession(sessionId, 'The scheduler did not return a runnable task.');
        }
        return this.executeTask(sessionId, decision.runnable.id, token);
      case 'waiting':
        return this.viewOf(sessionId);
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

    const retrieval = await this.deps.retrieve(buildTaskRequest(task), token);
    const stopped = await this.stopIfCancelled(
      sessionId,
      token,
      `The session was cancelled while retrieving context for task "${task.title}".`,
    );
    if (stopped !== undefined) {
      return stopped;
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

    current = this.require(sessionId);
    const parsed = parseChangePlan(result.text);
    if (parsed.plan === undefined) {
      return this.failSession(
        sessionId,
        parsed.errors.join(' ') || `Task "${task.title}" did not return a change plan.`,
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
      next = this.withEvent(
        next,
        'task',
        `Task "${task.title}" required no file changes.`,
        taskId,
      );
      await this.record(next);
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

    const changeSet: ChangeSet = {
      id: `${sessionId}-changeset-${current.changeSets.length + 1}`,
      taskId,
      summary: prepared.plan.summary,
      plan: prepared.plan,
      diffs: this.diffsOf(prepared),
      warnings: [...prepared.warnings],
      createdAt: this.timestamp(),
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
      detail: prepared.plan.summary,
      ids: prepared.plan.changes.map((change) => change.id),
      subjectId: changeSet.id,
      createdAt: this.timestamp(),
    };
    next = { ...next, pendingApproval: request };
    next = transitionSession(next, 'awaiting-change-approval', {
      at: this.timestamp(),
      eventId: this.nextId('event'),
      message: `The change set for task "${task.title}" is awaiting approval.`,
    });
    return this.record(next);
  }

  async approveChanges(
    sessionId: string,
    approvedIds: readonly string[],
    token: CancellationTokenLike,
  ): Promise<AgentSessionView> {
    this.requireTrusted('apply file changes');
    this.requireIdle(sessionId, 'approve changes');
    const session = this.require(sessionId);
    this.requireReviewed(session);
    if (session.state !== 'awaiting-change-approval') {
      throw new AgentSessionError('The session is not waiting for change approval.');
    }
    const request = session.pendingApproval;
    if (request === undefined || request.kind !== 'change-set' || request.subjectId === undefined) {
      throw new AgentSessionError('There is no pending change set approval.');
    }

    return this.runBusy(sessionId, async () => {
      let current = this.require(sessionId);
      const changeSet = current.changeSets.find((candidate) => candidate.id === request.subjectId);
      if (changeSet === undefined) {
        return this.failSession(sessionId, 'The pending change set is missing from the session.');
      }
      const validIds = new Set(changeSet.plan.changes.map((change) => change.id));
      const selected = [...new Set(approvedIds)].filter((id) => validIds.has(id));

      if (selected.length === 0) {
        current = this.withDecision(current, request, 'rejected', []);
        current = { ...current, pendingApproval: undefined };
        current = this.setTasks(
          current,
          current.tasks.map((task) =>
            task.id === changeSet.taskId ? { ...task, status: 'skipped' as const } : task,
          ),
        );
        return this.finishRejected(current, 'The change set was rejected by the user.');
      }

      current = this.withDecision(current, request, 'approved', selected);
      current = { ...current, pendingApproval: undefined };
      current = transitionSession(current, 'applying', {
        at: this.timestamp(),
        eventId: this.nextId('event'),
        message: `Applying ${selected.length} approved change(s).`,
      });
      await this.record(current);

      const historyTaskId = this.changeTaskId(sessionId, changeSet.taskId);
      const applyId = this.nextId('apply');
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
        return this.failSession(sessionId, messageOf(error));
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
      done = this.withEvent(
        done,
        'note',
        `Task "${task?.title ?? changeSet.taskId}" has no validation command; it is complete without command evidence.`,
        changeSet.taskId,
      );
      await this.record(done);
      return this.scheduleNext(sessionId, token);
    });
  }

  async rejectChanges(sessionId: string): Promise<AgentSessionView> {
    this.requireIdle(sessionId, 'reject changes');
    const session = this.require(sessionId);
    if (session.state !== 'awaiting-change-approval') {
      throw new AgentSessionError('The session is not waiting for change approval.');
    }
    const request = session.pendingApproval;
    if (request === undefined || request.kind !== 'change-set') {
      throw new AgentSessionError('There is no pending change set approval.');
    }
    const changeSet = session.changeSets.find((candidate) => candidate.id === request.subjectId);
    let current = this.withDecision(session, request, 'rejected', []);
    current = { ...current, pendingApproval: undefined };
    current = this.setTasks(
      current,
      current.tasks.map((task) =>
        task.id === changeSet?.taskId || task.status === 'awaiting-approval'
          ? { ...task, status: 'skipped' as const }
          : task,
      ),
    );
    return this.finishRejected(current, 'The change set was rejected by the user.');
  }

  async validate(
    sessionId: string,
    command: string,
    signal: AbortSignal,
  ): Promise<AgentSessionView> {
    this.requireTrusted('run validation commands');
    this.requireIdle(sessionId, 'run validation');
    const session = this.require(sessionId);
    this.requireReviewed(session);
    if (session.state !== 'validating') {
      throw new AgentSessionError('The session is not waiting for validation.');
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
        denied = this.withEvent(denied, 'diagnostic', diagnostic.message, task.id);
        await this.record(denied);
        return this.failSession(sessionId, diagnostic.message);
      }

      let current = this.require(sessionId);
      current = this.withEvent(current, 'command', `Running "${policy.normalized}".`, task.id);
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
        result = await this.deps.runCommand(policy.normalized, controller.signal);
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
      const run: ValidationRun = {
        id: this.nextId('validation'),
        taskId: task.id,
        command: result.command,
        startedAt,
        finishedAt,
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

      if (evidence.passed) {
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
          advanced = transitionSession(advanced, 'executing', {
            at: this.timestamp(),
            eventId: this.nextId('event'),
            message: 'Validation passed; scheduling the next task.',
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
        .find((candidate) => candidate.taskId === task.id);
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
        createdAt: this.timestamp(),
      };
      next = { ...next, pendingApproval: approval };
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
  ): Promise<AgentSessionView> {
    this.requireTrusted('apply repair changes');
    this.requireIdle(sessionId, 'approve the repair');
    const session = this.require(sessionId);
    this.requireReviewed(session);
    if (session.state !== 'awaiting-repair-approval') {
      throw new AgentSessionError('The session is not waiting for repair approval.');
    }
    const request = session.pendingApproval;
    if (request === undefined || request.kind !== 'repair' || request.subjectId === undefined) {
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

      if (selected.length === 0) {
        await this.record({
          ...this.withDecision(current, request, 'rejected', []),
          pendingApproval: undefined,
        });
        return this.failSession(sessionId, 'The repair proposal was rejected by the user.');
      }

      current = this.withDecision(current, request, 'approved', selected);
      current = { ...current, pendingApproval: undefined };
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

  async rejectRepair(sessionId: string): Promise<AgentSessionView> {
    this.requireIdle(sessionId, 'reject the repair');
    const session = this.require(sessionId);
    if (session.state !== 'awaiting-repair-approval') {
      throw new AgentSessionError('The session is not waiting for repair approval.');
    }
    const request = session.pendingApproval;
    if (request === undefined || request.kind !== 'repair') {
      throw new AgentSessionError('There is no pending repair approval.');
    }
    await this.record({
      ...this.withDecision(session, request, 'rejected', []),
      pendingApproval: undefined,
    });
    return this.failSession(sessionId, 'The repair proposal was rejected by the user.');
  }

  async pause(sessionId: string): Promise<AgentSessionView> {
    this.requireIdle(sessionId, 'pause');
    const session = this.require(sessionId);
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
    current = this.withEvent(current, 'note', message);
    current = transitionSession(current, 'cancelled', {
      at: cancelledAt,
      eventId: this.nextId('event'),
      message: 'The session was cancelled.',
    });
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

  private async failSession(sessionId: string, message: string): Promise<AgentSessionView> {
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
        if (ACTIVE_TASK_STATUSES.has(task.status)) {
          return { ...task, status: 'failed' as const, error: message };
        }
        return isTerminalTaskStatus(task.status)
          ? task
          : { ...task, status: 'skipped' as const };
      }),
    );
    current = {
      ...current,
      executions: current.executions.map((execution) =>
        ACTIVE_TASK_STATUSES.has(execution.status)
          ? { ...execution, status: 'failed' as const, finishedAt: at, error: message }
          : execution,
      ),
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
      `Exit code: ${run.evidence.exitCode ?? 'null'}`,
      run.evidence.timedOut ? 'The command timed out.' : '',
      `Repair attempt ${attempt} of ${maxAttempts}.`,
      errors.length > 0 ? `Diagnostics:\n${errors.join('\n')}` : '',
      'Validation output (truncated, redacted):',
      run.evidence.output.slice(0, 8_000),
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
        : { ...session, needsReview: true };
      this.sessions.set(session.id, loaded);
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
    if (session.workspaceRoot !== this.deps.workspaceRoot) {
      this.deps.logger?.warn(
        `Session ${sessionId} belongs to a different workspace and was not restored.`,
      );
      return undefined;
    }
    if (isTerminalAgentState(session.state)) {
      this.sessions.set(sessionId, session);
      return this.toView(session);
    }

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
          ? { ...task, status: 'pending' as const, error: undefined }
          : task,
      );
      const executions = current.executions.map((execution) =>
        execution.status === 'running' || execution.status === 'awaiting-approval'
          ? { ...execution, status: 'pending' as const, finishedAt: undefined }
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
    const restored: AgentSession = {
      ...current,
      state,
      pausedFrom,
      needsReview: unverified,
    };
    return this.record(restored);
  }

  private async verifyAppliedFiles(session: AgentSession): Promise<string[]> {
    if (this.deps.hashFile === undefined) {
      return [];
    }
    const hashFile = this.deps.hashFile;
    const problems: string[] = [];
    for (const execution of session.executions) {
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
