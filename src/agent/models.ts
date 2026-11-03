import type { ChangePlan } from '../changes/model';
import type { CommandResult } from '../commands/runner';
import type { RedactedContextItem } from '../context/filters';
import type { CancellationTokenLike } from '../providers/types';
import type { WorkspaceSummary } from '../workspace/analyze';

export const SESSION_SCHEMA_VERSION = 1;

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
  readonly createdAt: string;
}

export interface ApprovalRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: ApprovalKind;
  readonly title: string;
  readonly detail: string;
  readonly ids: readonly string[];
  readonly subjectId?: string;
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

export interface ValidationRun {
  readonly id: string;
  readonly taskId: string;
  readonly command: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly evidence: ValidationEvidence;
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
  readonly plan?: DevelopmentPlan;
  readonly tasks: readonly AgentTask[];
  readonly executions: readonly TaskExecution[];
  readonly changeSets: readonly ChangeSet[];
  readonly approvals: readonly ApprovalDecision[];
  readonly pendingApproval?: ApprovalRequest;
  readonly validationRuns: readonly ValidationRun[];
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
}

export interface IApprovalService {
  approvePlan(sessionId: string, token: CancellationTokenLike): Promise<AgentSessionView>;
  rejectPlan(sessionId: string): Promise<AgentSessionView>;
  approveChanges(
    sessionId: string,
    approvedIds: readonly string[],
    token: CancellationTokenLike,
  ): Promise<AgentSessionView>;
  rejectChanges(sessionId: string): Promise<AgentSessionView>;
  approveRepair(
    sessionId: string,
    approvedIds: readonly string[],
    token: CancellationTokenLike,
  ): Promise<AgentSessionView>;
  rejectRepair(sessionId: string): Promise<AgentSessionView>;
}

export interface IValidationService {
  validate(
    sessionId: string,
    command: string,
    signal: AbortSignal,
  ): Promise<AgentSessionView>;
}

export interface IRepairService {
  generateRepair(sessionId: string, token: CancellationTokenLike): Promise<AgentSessionView>;
}

export interface ICommandExecutionService {
  evaluate(command: string, allowlist: readonly string[]): CommandPolicy;
  run(command: string, signal: AbortSignal): Promise<CommandResult>;
}

export function isAgentState(value: unknown): value is AgentState {
  return typeof value === 'string' && (AGENT_STATES as readonly string[]).includes(value);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
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
