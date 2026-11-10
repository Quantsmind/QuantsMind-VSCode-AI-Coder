# v0.3.0 Data Model

This document defines the typed data that crosses module boundaries. The
canonical TypeScript definitions live in `src/agent/models.ts`; change and
command primitives are reused from v0.2.0 (`src/changes/model.ts`,
`src/commands/runner.ts`). Every field that is persisted is listed in section
11.

Conventions:

- Identifiers are opaque strings, max 80 characters.
- Timestamps are ISO-8601 UTC strings.
- Paths are workspace-relative, forward-slash, already normalized by
  `normalizeChangePath`.
- Collections are immutable (`readonly`) at the type level and copied before
  mutation.
- Model-derived values are untrusted until a parser has validated them.

## 1. Requirement and acceptance

```ts
export interface Requirement {
  readonly id: string;
  readonly text: string;          // trimmed, 1..4000 chars
  readonly createdAt: string;
}

export interface AcceptanceCriterion {
  readonly id: string;
  readonly text: string;          // <= 500 chars
  readonly verification: 'command' | 'review' | 'manual';
}
```

An explicit acceptance criterion is required for tasks that declare a validation
command: at least one criterion with `verification === 'command'`.

## 2. Development plan

```ts
export interface DevelopmentPlan {
  readonly id: string;
  readonly requirementId: string;
  readonly summary: string;       // <= 4000 chars
  readonly approach: string;      // <= 8000 chars
  readonly tasks: readonly AgentTask[];
  readonly risks: readonly string[];
  readonly warnings: readonly string[];
  readonly createdAt: string;
}

export interface AgentTask {
  readonly id: string;            // unique, <= 64 chars
  readonly title: string;         // <= 200 chars
  readonly description: string;   // <= 4000 chars
  readonly dependsOn: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly suggestedFiles: readonly string[];
  readonly validationCommand?: string;
  readonly status: TaskStatus;
  readonly attempts: number;
  readonly repairAttempts: number;
  readonly error?: string;
}
```

Limits: at most 20 tasks, 20 dependencies per task, 10 criteria per task, 20
suggested files per task. The parser rejects duplicate ids, unknown
dependencies, self-dependencies and cycles. A plan with zero tasks is valid and
means "no code change is required"; it completes with an evidence report stating
zero tasks.

## 3. Task status and execution

```ts
export type TaskStatus =
  | 'pending'
  | 'blocked'
  | 'running'
  | 'awaiting-approval'
  | 'applied'
  | 'validation-failed'
  | 'repairing'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface AppliedFile {
  readonly path: string;
  readonly hash: string;          // SHA-256 of the content written
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
  readonly historyTaskId?: string;  // id used by ChangeService history/backups
  readonly appliedFiles: readonly AppliedFile[];
  readonly error?: string;
}
```

`TaskExecution` is the audit record. `AgentTask.status` is the current scheduler
input. The orchestrator writes one execution record per task (replacing it on
later updates) so the report can list which files were really written.

## 4. Project context

```ts
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
  readonly summaryText: string;   // <= 6000 chars, safe for a prompt
}

export interface TechnologyLike {
  readonly name: string;
  readonly kind: 'language' | 'tooling' | 'framework';
  readonly evidence: string;
  readonly files: number;
}
```

`ProjectContext` is derived locally from indexed file names and a bounded set of
small config files (`package.json`, lockfiles, `tsconfig.json`, linter/test/CI
config). Dependency versions are not copied into prompts. Every non-obvious
fact carries a source path in `facts`.

## 5. Workspace retrieval

```ts
export interface WorkspaceFileReference {
  readonly path: string;
  readonly reason: string;
  readonly score: number;
  readonly hash?: string;         // SHA-256 of the content supplied to the model
  readonly truncated?: boolean;
}

export interface RetrievalResult {
  readonly context: ProjectContext;
  readonly items: readonly RedactedContextItem[]; // v0.2.0 shape
  readonly reasons: Readonly<Record<string, string>>;
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}
```

Only paths in `items` may appear in a provider request. A hash is attached when
the full file content is supplied; truncated content is marked.

## 6. Change sets and diffs

Reuses the v0.2.0 primitives:

```ts
export interface ChangeSet {
  readonly id: string;
  readonly taskId: string;
  readonly summary: string;
  readonly plan: ChangePlan;      // prepared plan, expected hashes attached
  readonly diffs: readonly UnifiedDiff[];
  readonly warnings: readonly string[];
  readonly createdAt: string;
}

export interface UnifiedDiff {
  readonly path: string;
  readonly text: string;
  readonly additions: number;
  readonly deletions: number;
  readonly truncated: boolean;
}
```

`ChangePlan`/`FileChange` are defined in `src/changes/model.ts` and keep their
v0.2.0 limits: 20 files, 1,000,000 characters per file, 4,000,000 characters per
plan. `plan` in a `ChangeSet` is always the output of
`ChangeService.prepare`, never raw model output.

## 7. Approvals

```ts
export type ApprovalKind = 'plan' | 'change-set' | 'repair' | 'validation-command';
export type ApprovalOutcome = 'approved' | 'rejected';

export interface ApprovalRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: ApprovalKind;
  readonly title: string;         // <= 200 chars
  readonly detail: string;        // <= 2000 chars, redacted
  readonly ids: readonly string[];
  readonly subjectId?: string;    // change-set, repair or validation target
  readonly createdAt: string;
}

export interface ApprovalDecision {
  readonly requestId: string;
  readonly kind: ApprovalKind;
  readonly approvedIds: readonly string[];
  readonly outcome: ApprovalOutcome;
  readonly decidedAt: string;
}
```

Invariants:

- `pendingApproval` is at most one request per session.
- A decision references the exact request id that was pending.
- `approvedIds` is a subset of `request.ids` for change sets and repairs.
- Approving with zero ids is stored as `rejected`.
- A decision is single-use: the request is removed before the side effect.

## 8. Tools

```ts
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
```

v0.3.0 does not expose a model-to-tool channel. `ToolRequest` is produced only
by local code, and the router requires an explicitly registered handler for
each kind. `apply-change-set` and `run-command` handlers are not registered by
default; the orchestrator performs those actions only through approval flows.

## 9. Commands, diagnostics and repair

```ts
export type CommandRisk = 'validation' | 'read-only' | 'destructive' | 'unknown';

export interface CommandPolicy {
  readonly allowed: boolean;
  readonly risk: CommandRisk;
  readonly requiresApproval: boolean;
  readonly normalized?: string;
  readonly reason: string;
}

export type DiagnosticSource =
  | 'build' | 'test' | 'lint' | 'typecheck' | 'runtime' | 'review';

export interface Diagnostic {
  readonly id: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly source: DiagnosticSource;
  readonly message: string;       // redacted, <= 2000 chars
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
  readonly output: string;        // redacted, capped
  readonly error?: string;        // spawn/validation failure, when no exit code exists
}

export interface ValidationRun {
  readonly id: string;
  readonly taskId: string;
  readonly command: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly evidence: ValidationEvidence;
}
```

A `Diagnostic` is derived from actual command evidence. It is never produced by
asking the model to "list likely problems"; the model may add a repair
hypothesis, but the evidence fields come from the `ValidationRun`.

## 10. Session, events and completion report

```ts
export type AgentState =
  | 'idle'
  | 'analyzing'
  | 'inspecting'
  | 'planning'
  | 'awaiting-plan-approval'
  | 'ready'
  | 'executing'
  | 'awaiting-change-approval'
  | 'applying'
  | 'validating'
  | 'diagnosing'
  | 'awaiting-repair-approval'
  | 'repairing'
  | 'paused'
  | 'cancelling'
  | 'completed'
  | 'rejected'
  | 'failed'
  | 'cancelled';

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

export interface SessionEvent {
  readonly id: string;
  readonly at: string;
  readonly type: SessionEventType;
  readonly state?: AgentState;
  readonly taskId?: string;
  readonly message: string;      // redacted, <= 1000 chars
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
  readonly workspaceRoot: string;  // workspace folder name
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
```

An `AgentSessionView` is the session plus derived, read-only stage summaries for
the webview:

```ts
export interface SessionStageView {
  readonly name: string;
  readonly status: 'pending' | 'running' | 'complete' | 'failed' | 'skipped';
  readonly detail?: string;
}

export interface AgentSessionView extends AgentSession {
  readonly stages: readonly SessionStageView[];
}
```

Stage labels are stable:

| Stage | Complete when |
| --- | --- |
| Requirement | analysis finished |
| Inspect | project context exists |
| Plan | a development plan exists |
| Plan approval | a plan decision exists |
| Tasks | every task reached a terminal state |
| Change review | a change set applied or was rejected |
| Apply | at least one file applied |
| Validate | at least one validation run exists |
| Repair | repair proposals were generated |
| Report | a completion report exists |

## 11. Persistence

Store key: `quantsmind.agent.sessions.v1`.

Envelope:

```ts
interface StoredSessionEnvelope {
  readonly schemaVersion: number;   // 1
  readonly sessions: readonly unknown[];
}
```

Persistence whitelist (only these fields are written):

- `schemaVersion`, `id`, `workspaceRoot`, `requirement`, `state`, `pausedFrom`,
  `needsReview`, `createdAt`, `updatedAt`, `providerCalls`,
- `plan`, `tasks`, `executions`, `changeSets`, `approvals`, `pendingApproval`,
- `validationRuns` (evidence output capped at 20,000 characters),
- `diagnostics`, `repairProposals` (diffs capped),
- `events` (max 500 per session; oldest dropped first),
- `report`, `error`.

Never persisted: provider headers/bodies, credentials, SecretStorage values,
unapproved raw model output, files outside a change record, environment
variables, absolute home paths.

Caps: 50 sessions, 500 events per session, 20,000 characters of validation
output per run, 2,000 characters per event message, 200,000 characters of
serialized session data (sessions over the cap are not written and produce a
warning). Malformed sessions are dropped on load; a malformed envelope leaves
the store untouched and returns an empty list.

## 12. Migration

Current version is 1. The loader accepts:

- version 1: validated as-is;
- unversioned legacy records (`schemaVersion` missing) with at least `id`,
  `prompt`/`requirement`, `state`, `createdAt` and `updatedAt`: migrated to a
  `Requirement`, empty plan/tasks/events, `workspaceRoot` from `rootName` or
  empty, `needsReview = true`, state `paused` unless already terminal.

Unknown future versions are not loaded. They are retained on disk and reported
as unsupported, so a downgrade cannot silently destroy newer sessions.

## 13. Validation rules for stored data

- `schemaVersion` must equal 1 after migration.
- `state` must be a known `AgentState`.
- Every task id in `executions`, `changeSets`, `validationRuns` and
  `repairProposals` must exist in `tasks` (orphans are dropped).
- `pendingApproval.ids` must be strings, max 200 entries.
- Strings are truncated to their documented maxima; unknown fields are dropped.
- `report` is only kept when `state` is terminal and its `sessionId` matches.
- Events are ordered by append order and capped.
