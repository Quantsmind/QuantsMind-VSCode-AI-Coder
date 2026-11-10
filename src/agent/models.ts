import type { ChangePlan } from '../changes/model';
import type { RedactedContextItem } from '../context/filters';
import type { CancellationTokenLike } from '../providers/types';
import type { ChangeImpact } from '../repository/impact';
import type { WorkspaceSummary } from '../workspace/analyze';

export const SESSION_SCHEMA_VERSION = 1;
export const CHECKPOINT_SCHEMA_VERSION = 1;

export const MAX_SESSION_TASKS = 20;
export const MAX_TASK_DEPENDENCIES = 20;
export const MAX_TASK_CRITERIA = 10;
export const MAX_TASK_FILES = 20;
export const MAX_SESSIONS = 50;
export const MAX_SESSION_EVENTS = 500;
export const MAX_EVENT_MESSAGE_CHARS = 1_000;
export const MAX_SESSION_SERIALIZED_CHARS = 200_000;
export const MAX_VALIDATION_OUTPUT_CHARS = 20_000;
export const MAX_REQUIREMENT_CHARS = 4_000;

export const AGENT_STATES = [
  'idle',
  'analyzing',
  'inspecting',
  'planning',
  'awaiting-plan-approval',
  'ready',
  'executing',
  'awaiting-change-approval',
  'applying',
  'validating',
  'diagnosing',
  'awaiting-repair-approval',
  'repairing',
  'paused',
  'cancelling',
  'completed',
  'rejected',
  'failed',
  'cancelled',
] as const;

export type AgentState = (typeof AGENT_STATES)[number];

export const TASK_STATUSES = [
  'pending',
  'blocked',
  'running',
  'awaiting-approval',
  'applied',
  'validation-failed',
  'repairing',
  'completed',
  'failed',
  'skipped',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type ApprovalKind = 'plan' | 'change-set' | 'repair' | 'validation-command';
export type ApprovalOutcome = 'approved' | 'rejected';

export type SessionEventType =
  | 'state'
  | 'task'
  | 'approval'
  | 'apply'
  | 'command'
  | 'diagnostic'
  | 'repair'
  | 'report'
  | 'note';

export interface Requirement {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
}

export interface AcceptanceCriterion {
  readonly id: string;
  readonly text: string;
  readonly verification: 'command' | 'review' | 'manual';
}

export interface AgentTask {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly dependsOn: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly suggestedFiles: readonly string[];
  readonly validationCommand?: string;
  readonly status: TaskStatus;
  readonly attempts: number;
  readonly repairAttempts: number;
  readonly error?: string;
}

export interface DevelopmentPlan {
  readonly id: string;
  readonly requirementId: string;
  readonly summary: string;
  readonly approach: string;
  readonly tasks: readonly AgentTask[];
  readonly risks: readonly string[];
  readonly warnings: readonly string[];
  readonly createdAt: string;
}

export interface AppliedFile {
  readonly path: string;
  readonly hash: string;
  readonly kind: 'create' | 'modify' | 'delete' | 'rename';
}

export interface TaskExecution {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly attempts: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly changeSetId?: string;
  readonly validationRunId?: string;
  readonly historyTaskId?: string;
  /** Set when the applied state came from a repair proposal rather than the change set alone. */
  readonly repairProposalId?: string;
  readonly appliedFiles: readonly AppliedFile[];
  readonly error?: string;
}

export interface TechnologyLike {
  readonly name: string;
  readonly kind: 'language' | 'tooling' | 'framework';
  readonly evidence: string;
  readonly files: number;
}

export interface ContextFact {
  readonly fact: string;
  readonly path?: string;
}

export interface ModuleSummary {
  readonly name: string;
  readonly files: number;
}

export interface ProjectContext {
  readonly rootName: string;
  readonly languages: readonly TechnologyLike[];
  readonly packageManager?: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly configFiles: readonly string[];
  readonly modules: readonly ModuleSummary[];
  readonly entryPoints: readonly string[];
  readonly testFiles: number;
  readonly facts: readonly ContextFact[];
  readonly summaryText: string;
}

export interface WorkspaceFileReference {
  readonly path: string;
  readonly reason: string;
  readonly score: number;
  readonly hash?: string;
  readonly truncated?: boolean;
}

export interface RetrievalResult {
  readonly summary: WorkspaceSummary;
  readonly items: readonly RedactedContextItem[];
  readonly reasons: Readonly<Record<string, string>>;
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

export interface UnifiedDiff {
  readonly path: string;
  readonly text: string;
  readonly additions: number;
  readonly deletions: number;
  readonly truncated: boolean;
}

export interface ReviewChangeLike {
  readonly id: string;
  readonly kind: 'create' | 'modify' | 'delete' | 'rename';
  readonly path: string;
  readonly fromPath?: string;
  readonly summary: string;
  readonly diff: string;
  readonly additions: number;
  readonly deletions: number;
  readonly diffTruncated: boolean;
  readonly warning?: string;
}

export interface PreparedChangeSet {
  readonly plan: ChangePlan;
  readonly review: readonly ReviewChangeLike[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface AppliedFileOutcome {
  readonly changeId: string;
  readonly kind: 'create' | 'modify' | 'delete' | 'rename';
  readonly path: string;
  readonly fromPath?: string;
  readonly before?: string;
  readonly after?: string;
  readonly backupName: string;
}

export interface ApplyOutcomeLike {
  readonly applied: readonly AppliedFileOutcome[];
  readonly conflicts: readonly { readonly changeId: string; readonly path: string }[];
  readonly failed: readonly { readonly changeId: string; readonly path: string }[];
}

export interface ApplyReportLike {
  readonly outcome: ApplyOutcomeLike;
}

export interface UndoOutcomeLike {
  readonly restored: number;
  readonly conflicts: number;
}

export interface IFileChangeService {
  prepare(plan: ChangePlan, taskId: string): Promise<PreparedChangeSet>;
  apply(
    plan: ChangePlan,
    approvedIds: readonly string[],
    taskId: string,
    summary: string,
    applyId?: string,
  ): Promise<ApplyReportLike>;
  undo(taskId: string): Promise<UndoOutcomeLike | undefined>;
}

export interface ChangeSet {
  readonly id: string;
  readonly taskId: string;
  readonly summary: string;
  readonly plan: ChangePlan;
  readonly diffs: readonly UnifiedDiff[];
  readonly warnings: readonly string[];
  /** Digest of the exact plan content; binds approval and validation to this version. */
  readonly version: string;
  readonly createdAt: string;
  /** Change IDs that were applied in the last apply attempt. Used to avoid re-applying them. */
  readonly appliedChangeIds?: readonly string[];
  /** Bounded, informational impact evidence. Never part of the version hash. */
  readonly impact?: ChangeImpact;
  readonly status: 'pending' | 'approved' | 'applied' | 'partial' | 'rejected' | 'failed';
}

export const CHECKPOINT_STATUSES = [
  'created',
  'valid',
  'restoring',
  'restored',
  'invalid',
] as const;

export type CheckpointStatus = (typeof CHECKPOINT_STATUSES)[number];

export interface CheckpointTaskResult {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly attempts?: number;
  readonly summary?: string;
  readonly error?: string;
  readonly completedAt?: string;
}

export interface ExecutionTaskResult {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly attempts: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly changeSetId?: string;
  readonly validationRunId?: string;
  readonly historyTaskId?: string;
  readonly repairProposalId?: string;
  readonly appliedFiles: readonly AppliedFile[];
  readonly error?: string;
}

export interface ExecutionCheckpoint {
  readonly id: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly sequence: number;
  readonly planId: string;
  readonly planVersion: string;
  readonly currentTaskId?: string;
  readonly completedTaskIds: readonly string[];
  readonly pendingTaskIds: readonly string[];
  readonly failedTaskIds: readonly string[];
  readonly blockedTaskIds: readonly string[];
  readonly taskResults: readonly CheckpointTaskResult[];
  readonly executionResults?: readonly ExecutionTaskResult[];
  readonly pendingApprovalIds: readonly string[];
  readonly changeSetIds: readonly string[];
  readonly appliedChangeIds: readonly string[];
  readonly validationRunIds: readonly string[];
  readonly repositoryStateRef?: string;
  readonly createdAt: string;
  readonly status: CheckpointStatus;
  readonly schemaVersion: number;
  readonly integrity?: string;
  /** Monotonic session recovery version the checkpoint represents. */
  readonly recoveryVersion?: number;
}

export interface ApprovalRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: ApprovalKind;
  readonly title: string;
  readonly detail: string;
  readonly ids: readonly string[];
  readonly subjectId?: string;
  /** For `validation-command`: the normalized command the user approved. */
  readonly command?: string;
  /** For `validation-command`: the directory the command was approved for. */
  readonly cwd?: string;
  /** For `change-set`: the exact ChangeSet version this approval is bound to. */
  readonly changeSetVersion?: string;
  /** Owning task for task-scoped approvals; absent for session-scoped plan approvals. */
  readonly taskId?: string;
  readonly createdAt: string;
}

export interface ApprovalDecision {
  readonly requestId: string;
  readonly kind: ApprovalKind;
  readonly approvedIds: readonly string[];
  readonly outcome: ApprovalOutcome;
  readonly decidedAt: string;
}

export type ToolKind =
  | 'read-file'
  | 'list-files'
  | 'apply-change-set'
  | 'run-command'
  | 'collect-diagnostics';

export interface ToolRequest {
  readonly id: string;
  readonly kind: ToolKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly requestedAt: string;
}

export interface ToolExecutionResult {
  readonly requestId: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly output?: string;
  readonly durationMs: number;
}

export interface IToolRouter {
  route(request: ToolRequest): Promise<ToolExecutionResult>;
}

export type CommandRisk = 'validation' | 'read-only' | 'destructive' | 'unknown';

export interface CommandPolicy {
  readonly allowed: boolean;
  readonly risk: CommandRisk;
  readonly requiresApproval: boolean;
  readonly normalized?: string;
  readonly reason: string;
}

export type DiagnosticSource =
  | 'build'
  | 'test'
  | 'lint'
  | 'typecheck'
  | 'runtime'
  | 'review';

export interface Diagnostic {
  readonly id: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly source: DiagnosticSource;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly command?: string;
}

export interface RepairProposal {
  readonly id: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly diagnosis: string;
  readonly summary: string;
  readonly plan: ChangePlan;
  readonly diffs: readonly UnifiedDiff[];
  readonly createdAt: string;
}

export interface ValidationEvidence {
  readonly command: string;
  readonly exitCode: number | null;
  readonly passed: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly output: string;
  readonly error?: string;
}

export type ValidationOutcome = 'passed' | 'failed' | 'skipped' | 'unavailable';

export const VALIDATION_OUTCOMES: readonly ValidationOutcome[] = [
  'passed',
  'failed',
  'skipped',
  'unavailable',
];

export interface ValidationRun {
  readonly id: string;
  readonly taskId: string;
  readonly command: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: ValidationOutcome;
  /** The change set whose applied files this run actually tested. */
  readonly changeSetId?: string;
  /** Digest of the exact content that change set (plus any repair) writes. */
  readonly changeSetVersion?: string;
  /** Set when a repair proposal rewrote the applied state before this run. */
  readonly repairProposalId?: string;
  /** Why no command was run, for `skipped` and `unavailable` outcomes. */
  readonly detail?: string;
  readonly evidence?: ValidationEvidence;
}

export interface SessionEvent {
  readonly id: string;
  readonly at: string;
  readonly type: SessionEventType;
  readonly state?: AgentState;
  readonly taskId?: string;
  readonly message: string;
}

export interface CompletionTaskSummary {
  readonly taskId: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly files: readonly string[];
}

export interface CompletionReport {
  readonly sessionId: string;
  readonly requirement: string;
  readonly outcome: 'completed' | 'failed' | 'cancelled' | 'rejected';
  readonly planSummary?: string;
  readonly tasks: readonly CompletionTaskSummary[];
  readonly validationRuns: readonly ValidationRun[];
  readonly diagnostics: readonly Diagnostic[];
  readonly repairs: number;
  readonly unresolved: readonly string[];
  readonly evidence: readonly string[];
  readonly generatedAt: string;
}

export interface AgentSession {
  readonly schemaVersion: number;
  readonly id: string;
  readonly workspaceRoot: string;
  readonly requirement: Requirement;
  readonly state: AgentState;
  readonly pausedFrom?: AgentState;
  readonly needsReview: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly providerCalls: number;
  /** Monotonically increases whenever authoritative session state changes. */
  readonly recoveryVersion?: number;
  readonly plan?: DevelopmentPlan;
  readonly tasks: readonly AgentTask[];
  readonly executions: readonly TaskExecution[];
  readonly changeSets: readonly ChangeSet[];
  readonly approvals: readonly ApprovalDecision[];
  readonly pendingApproval?: ApprovalRequest;
  /**
   * Task-scoped pending approvals (for example concurrent change-set approvals
   * owned by different tasks). Legacy sessions keep a single `pendingApproval`;
   * task-scoped lists take precedence while they hold entries.
   */
  readonly taskApprovals?: readonly ApprovalRequest[];
  readonly validationRuns: readonly ValidationRun[];
  /** Allowlisted commands derived from the project's own scripts at planning time. */
  readonly validationSuggestions?: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
  readonly repairProposals: readonly RepairProposal[];
  readonly events: readonly SessionEvent[];
  readonly report?: CompletionReport;
  readonly error?: string;
}

export type SessionStageName =
  | 'requirement'
  | 'inspect'
  | 'plan'
  | 'plan-approval'
  | 'tasks'
  | 'review'
  | 'apply'
  | 'validate'
  | 'repair'
  | 'report';

export interface SessionStageView {
  readonly name: SessionStageName;
  readonly status: 'pending' | 'running' | 'complete' | 'failed' | 'skipped';
  readonly detail?: string;
}

export interface AgentSessionView extends AgentSession {
  readonly stages: readonly SessionStageView[];
  readonly progress: SessionProgressView;
}

export interface SessionProgressView {
  readonly totalTasks: number;
  readonly completedTasks: number;
  readonly activeTaskId?: string;
  readonly activeTaskTitle?: string;
  /** Identifies the exact request the UI must answer; a stale id is refused. */
  readonly pendingRequestId?: string;
  readonly pendingRequestKind?: ApprovalKind;
  readonly pendingSubjectId?: string;
  readonly validation: string;
  readonly activity: string;
}

export interface IApprovalService {
  approvePlan(
    sessionId: string,
    token: CancellationTokenLike,
    requestId: string,
  ): Promise<AgentSessionView>;
  rejectPlan(sessionId: string, requestId: string): Promise<AgentSessionView>;
  approveChanges(
    sessionId: string,
    approvedIds: readonly string[],
    token: CancellationTokenLike,
    requestId: string,
  ): Promise<AgentSessionView>;
  rejectChanges(sessionId: string, requestId: string): Promise<AgentSessionView>;
  approveRepair(
    sessionId: string,
    approvedIds: readonly string[],
    token: CancellationTokenLike,
    requestId: string,
  ): Promise<AgentSessionView>;
  rejectRepair(sessionId: string, requestId: string): Promise<AgentSessionView>;
}

export interface IValidationService {
  /** Asks the user to approve one exact command before anything runs. */
  requestValidation(sessionId: string, command: string): Promise<AgentSessionView>;
  /** Runs the command named by the approved request, and nothing else. */
  approveValidation(
    sessionId: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<AgentSessionView>;
  /** Records a skipped run and leaves the session waiting for another choice. */
  rejectValidation(sessionId: string, requestId: string): Promise<AgentSessionView>;
}

export interface IRepairService {
  generateRepair(sessionId: string, token: CancellationTokenLike): Promise<AgentSessionView>;
}

export function isAgentState(value: unknown): value is AgentState {
  return typeof value === 'string' && (AGENT_STATES as readonly string[]).includes(value);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isValidationOutcome(value: unknown): value is ValidationOutcome {
  return typeof value === 'string' && (VALIDATION_OUTCOMES as readonly string[]).includes(value);
}

export function isTerminalAgentState(state: AgentState): boolean {
  return state === 'completed' || state === 'failed' || state === 'rejected' || state === 'cancelled';
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'skipped' ||
    status === 'cancelled'
  );
}

export function isFailureTaskStatus(status: TaskStatus): boolean {
  return status === 'failed' || status === 'skipped' || status === 'cancelled';
}

export function isPausedFromState(value: unknown): value is AgentState {
  return (
    isAgentState(value) &&
    (value === 'ready' ||
      value === 'awaiting-plan-approval' ||
      value === 'awaiting-change-approval' ||
      value === 'awaiting-repair-approval' ||
      value === 'diagnosing')
  );
}

export function clampText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

export function createRequirement(id: string, text: string, at: string): Requirement {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error('The requirement must not be empty.');
  }
  if (trimmed.length > MAX_REQUIREMENT_CHARS) {
    throw new Error(`The requirement must be at most ${MAX_REQUIREMENT_CHARS} characters.`);
  }
  return { id, text: trimmed, createdAt: at };
}
