import {
  isTerminalAgentState,
  isTerminalTaskStatus,
  type AgentSession,
  type AgentState,
  type SessionEvent,
  type SessionProgressView,
  type SessionStageName,
  type SessionStageView,
} from './models';
import { describeValidationCoverage, isValidationBound } from './validation';

export type AgentTransitionEvent =
  | 'start'
  | 'plan'
  | 'approvePlan'
  | 'rejectPlan'
  | 'schedule'
  | 'implement'
  | 'approveChanges'
  | 'rejectChanges'
  | 'apply'
  | 'validate'
  | 'repair'
  | 'approveRepair'
  | 'rejectRepair'
  | 'applyRepair'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'complete'
  | 'fail';

export interface AgentTransition {
  readonly from: AgentState;
  readonly to: AgentState;
  readonly event: AgentTransitionEvent;
}

const MAIN_TRANSITIONS: readonly AgentTransition[] = [
  { from: 'idle', to: 'analyzing', event: 'start' },
  { from: 'analyzing', to: 'inspecting', event: 'start' },
  { from: 'inspecting', to: 'planning', event: 'start' },
  { from: 'planning', to: 'awaiting-plan-approval', event: 'plan' },
  { from: 'awaiting-plan-approval', to: 'ready', event: 'approvePlan' },
  { from: 'awaiting-plan-approval', to: 'rejected', event: 'rejectPlan' },
  { from: 'ready', to: 'executing', event: 'schedule' },
  { from: 'ready', to: 'completed', event: 'complete' },
  { from: 'executing', to: 'awaiting-change-approval', event: 'implement' },
  { from: 'executing', to: 'ready', event: 'implement' },
  { from: 'executing', to: 'completed', event: 'complete' },
  { from: 'awaiting-change-approval', to: 'applying', event: 'approveChanges' },
  { from: 'awaiting-change-approval', to: 'rejected', event: 'rejectChanges' },
  { from: 'applying', to: 'validating', event: 'apply' },
  { from: 'applying', to: 'executing', event: 'apply' },
  { from: 'applying', to: 'completed', event: 'complete' },
  { from: 'validating', to: 'executing', event: 'validate' },
  { from: 'validating', to: 'completed', event: 'complete' },
  { from: 'validating', to: 'diagnosing', event: 'validate' },
  { from: 'diagnosing', to: 'awaiting-repair-approval', event: 'repair' },
  { from: 'awaiting-repair-approval', to: 'repairing', event: 'approveRepair' },
  { from: 'awaiting-repair-approval', to: 'failed', event: 'rejectRepair' },
  { from: 'repairing', to: 'validating', event: 'applyRepair' },
  { from: 'repairing', to: 'completed', event: 'complete' },
];

export const PAUSABLE_STATES: readonly AgentState[] = [
  'ready',
  'awaiting-plan-approval',
  'awaiting-change-approval',
  'awaiting-repair-approval',
  'diagnosing',
];

export const RESUMABLE_STATES: readonly AgentState[] = PAUSABLE_STATES;

export const AGENT_TRANSITIONS: readonly AgentTransition[] = MAIN_TRANSITIONS;

export function canPause(state: AgentState): boolean {
  return PAUSABLE_STATES.includes(state);
}

export function canTransition(from: AgentState, to: AgentState): boolean {
  if (isTerminalAgentState(from)) {
    return false;
  }
  if (to === 'failed') {
    return true;
  }
  if (to === 'cancelling') {
    return from !== 'cancelling';
  }
  if (from === 'cancelling') {
    return to === 'cancelled';
  }
  if (from === 'paused') {
    return to !== 'paused' && RESUMABLE_STATES.includes(to);
  }
  if (to === 'paused') {
    return canPause(from);
  }
  return MAIN_TRANSITIONS.some((transition) => transition.from === from && transition.to === to);
}

export function assertTransition(from: AgentState, to: AgentState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid agent transition: ${from} -> ${to}.`);
  }
}

export function transitionEvent(from: AgentState, to: AgentState): AgentTransitionEvent {
  if (to === 'paused') {
    return 'pause';
  }
  if (from === 'paused') {
    return 'resume';
  }
  if (to === 'cancelling' || to === 'cancelled') {
    return 'cancel';
  }
  if (to === 'failed') {
    return 'fail';
  }
  if (to === 'completed') {
    return 'complete';
  }
  const match = MAIN_TRANSITIONS.find(
    (transition) => transition.from === from && transition.to === to,
  );
  return match?.event ?? 'complete';
}

export interface TransitionOptions {
  readonly at: string;
  readonly eventId: string;
  readonly message: string;
  readonly pausedFrom?: AgentState;
}

/**
 * Produces a new session in the target state and appends a state event.
 * Approval, task and evidence mutations are applied by the caller before this
 * helper, so the persisted snapshot always matches the emitted view.
 */
export function transitionSession(
  session: AgentSession,
  to: AgentState,
  options: TransitionOptions,
): AgentSession {
  assertTransition(session.state, to);
  let pausedFrom = session.pausedFrom;
  if (to === 'paused') {
    pausedFrom = options.pausedFrom ?? session.state;
  } else if (session.state === 'paused') {
    pausedFrom = undefined;
  }
  const event: SessionEvent = {
    id: options.eventId,
    at: options.at,
    type: 'state',
    state: to,
    message: options.message.slice(0, 1_000),
  };
  return {
    ...session,
    state: to,
    pausedFrom,
    updatedAt: options.at,
    events: [...session.events, event],
  };
}

export const STATE_LABELS: Readonly<Record<AgentState, string>> = {
  idle: 'Idle',
  analyzing: 'Analyzing the requirement',
  inspecting: 'Inspecting the workspace',
  planning: 'Planning',
  'awaiting-plan-approval': 'Waiting for plan approval',
  ready: 'Ready to execute',
  executing: 'Implementing a task',
  'awaiting-change-approval': 'Waiting for change approval',
  applying: 'Applying approved changes',
  validating: 'Running validation',
  diagnosing: 'Diagnosing validation failure',
  'awaiting-repair-approval': 'Waiting for repair approval',
  repairing: 'Applying a repair',
  paused: 'Paused',
  cancelling: 'Cancelling',
  completed: 'Completed',
  rejected: 'Rejected',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const STAGE_LABELS: Readonly<Record<SessionStageName, string>> = {
  requirement: 'Requirement',
  inspect: 'Inspect the project',
  plan: 'Development plan',
  'plan-approval': 'Plan approval',
  tasks: 'Task execution',
  review: 'Change review',
  apply: 'Apply approved changes',
  validate: 'Build and test evidence',
  repair: 'Diagnose and repair',
  report: 'Completion report',
};

function stage(
  name: SessionStageName,
  status: SessionStageView['status'],
  detail?: string,
): SessionStageView {
  return { name, status, detail };
}

/**
 * Derives the control-center stage list from recorded session state. It never
 * advances a stage based on a provider message; only real state and recorded
 * artifacts count.
 */
export function deriveStages(session: AgentSession): SessionStageView[] {
  const { state } = session;
  const hasPlan = session.plan !== undefined;
  const planDecision = session.approvals.find((decision) => decision.kind === 'plan');
  const allTasksDone =
    session.tasks.length > 0 && session.tasks.every((task) => isTerminalTaskStatus(task.status));
  const inTaskWork =
    state === 'executing' ||
    state === 'awaiting-change-approval' ||
    state === 'applying' ||
    state === 'validating' ||
    state === 'diagnosing' ||
    state === 'awaiting-repair-approval' ||
    state === 'repairing';
  const anyApplied = session.executions.some((execution) => execution.appliedFiles.length > 0);
  const anyChangeSet = session.changeSets.length > 0;
  const passedRun = session.validationRuns.find(
    (run) =>
      run.outcome === 'passed' &&
      isValidationBound(run, session.changeSets, session.repairProposals),
  );
  const lastRun = session.validationRuns[session.validationRuns.length - 1];
  const terminalFailure = state === 'failed' || state === 'rejected' || state === 'cancelled';

  const requirement = stage(
    'requirement',
    state === 'idle' ? 'pending' : state === 'analyzing' ? 'running' : 'complete',
  );
  const inspect = stage(
    'inspect',
    state === 'idle' || state === 'analyzing'
      ? 'pending'
      : state === 'inspecting'
        ? 'running'
        : terminalFailure && !hasPlan
          ? 'failed'
          : 'complete',
  );
  const plan = stage(
    'plan',
    hasPlan ? 'complete' : state === 'planning' ? 'running' : terminalFailure ? 'failed' : 'pending',
    hasPlan ? `${session.plan?.tasks.length ?? 0} task(s)` : undefined,
  );
  const planApproval = stage(
    'plan-approval',
    planDecision !== undefined
      ? planDecision.outcome === 'approved'
        ? 'complete'
        : 'skipped'
      : state === 'awaiting-plan-approval'
        ? 'running'
        : 'pending',
    planDecision?.outcome,
  );
  const tasks = stage(
    'tasks',
    session.tasks.length === 0
      ? hasPlan && state !== 'planning'
        ? 'complete'
        : 'pending'
      : allTasksDone
        ? terminalFailure
          ? 'failed'
          : 'complete'
        : inTaskWork || state === 'ready'
          ? 'running'
          : 'pending',
    session.tasks.length > 0
      ? `${session.tasks.filter((task) => task.status === 'completed').length} of ${session.tasks.length} complete`
      : undefined,
  );
  const review = stage(
    'review',
    anyChangeSet ? 'complete' : state === 'awaiting-change-approval' ? 'running' : 'pending',
    anyChangeSet ? `${session.changeSets.length} change set(s)` : undefined,
  );
  const apply = stage(
    'apply',
    anyApplied
      ? 'complete'
      : state === 'applying' || state === 'repairing'
        ? 'running'
        : terminalFailure && anyChangeSet
          ? 'failed'
          : 'pending',
  );
  const validate = stage(
    'validate',
    passedRun !== undefined
      ? 'complete'
      : state === 'validating'
        ? 'running'
        : lastRun?.outcome === 'failed'
          ? 'failed'
          : session.validationRuns.length > 0
            ? 'skipped'
            : 'pending',
    session.validationRuns.length > 0
      ? describeValidationCoverage(
          session.validationRuns,
          session.changeSets,
          session.repairProposals,
        )
      : undefined,
  );
  const repair = stage(
    'repair',
    session.repairProposals.length > 0
      ? 'complete'
      : state === 'diagnosing' || state === 'awaiting-repair-approval' || state === 'repairing'
        ? 'running'
        : 'pending',
    session.repairProposals.length > 0
      ? `${session.repairProposals.length} proposal(s)`
      : undefined,
  );
  const report = stage(
    'report',
    session.report !== undefined ? 'complete' : terminalFailure ? 'running' : 'pending',
  );

  return [
    requirement,
    inspect,
    plan,
    planApproval,
    tasks,
    review,
    apply,
    validate,
    repair,
    report,
  ];
}

const IN_FLIGHT_TASK_STATUSES: readonly string[] = [
  'running',
  'awaiting-approval',
  'applied',
  'validation-failed',
  'repairing',
];

/**
 * Progress and the pending approval identity, derived only from recorded
 * state. The webview echoes `pendingRequestId` back so a stale card cannot act
 * on a newer request.
 */
export function deriveProgress(session: AgentSession): SessionProgressView {
  const activeTask = session.tasks.find((task) =>
    IN_FLIGHT_TASK_STATUSES.includes(task.status),
  );
  const label = STATE_LABELS[session.state] ?? session.state;
  return {
    totalTasks: session.tasks.length,
    completedTasks: session.tasks.filter((task) => task.status === 'completed').length,
    activeTaskId: activeTask?.id,
    activeTaskTitle: activeTask?.title,
    pendingRequestId: session.pendingApproval?.id,
    pendingRequestKind: session.pendingApproval?.kind,
    pendingSubjectId: session.pendingApproval?.subjectId,
    validation: describeValidationCoverage(
      session.validationRuns,
      session.changeSets,
      session.repairProposals,
    ),
    activity:
      activeTask !== undefined && activeTask.title.length > 0
        ? `${label} — ${activeTask.title}`
        : label,
  };
}
