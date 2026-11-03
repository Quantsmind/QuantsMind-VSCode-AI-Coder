import { validateChangeInputs, normalizeChangePath, type ChangePlan } from '../changes/model';
import { redactSecrets } from '../security/redact';
import {
  MAX_EVENT_MESSAGE_CHARS,
  MAX_SESSION_EVENTS,
  MAX_SESSION_SERIALIZED_CHARS,
  MAX_SESSIONS,
  MAX_VALIDATION_OUTPUT_CHARS,
  SESSION_SCHEMA_VERSION,
  clampText,
  isAgentState,
  isTaskStatus,
  isTerminalAgentState,
  type AcceptanceCriterion,
  type AgentSession,
  type AgentTask,
  type AppliedFile,
  type ApprovalDecision,
  type ApprovalRequest,
  type ChangeSet,
  type CompletionReport,
  type CompletionTaskSummary,
  type Diagnostic,
  type RepairProposal,
  type Requirement,
  type SessionEvent,
  type TaskExecution,
  type UnifiedDiff,
  type ValidationEvidence,
  type ValidationRun,
} from '../agent/models';
import { validateTaskGraph } from '../agent/scheduler';

export const SESSION_STORAGE_KEY = 'quantsmind.agent.sessions.v1';

export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface RepositoryLogger {
  warn(message: string): void;
  info?(message: string): void;
}

export interface ISessionRepository {
  load(): Promise<readonly AgentSession[]>;
  get(id: string): Promise<AgentSession | undefined>;
  save(session: AgentSession): Promise<void>;
  remove(id: string): Promise<void>;
}

interface StoredEnvelope {
  readonly schemaVersion: number;
  readonly sessions: readonly unknown[];
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown, max = 4_000): string | undefined {
  return typeof value === 'string' && value.length > 0 ? clampText(value, max) : undefined;
}

function iso(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 40) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : value;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function sanitizeRequirement(raw: unknown, fallbackId: string): Requirement | undefined {
  if (typeof raw === 'string') {
    const text = str(raw.trim());
    return text !== undefined
      ? { id: `${fallbackId}-requirement`, text, createdAt: new Date(0).toISOString() }
      : undefined;
  }
  const record = recordOf(raw);
  if (record === undefined) {
    return undefined;
  }
  const text = str(record.text);
  if (text === undefined) {
    return undefined;
  }
  return {
    id: str(record.id, 80) ?? `${fallbackId}-requirement`,
    text: clampText(text, 4_000),
    createdAt: iso(record.createdAt) ?? new Date(0).toISOString(),
  };
}

function sanitizeCriterion(raw: unknown, index: number): AcceptanceCriterion | undefined {
  const record = recordOf(raw);
  if (record === undefined) {
    return undefined;
  }
  const text = str(record.text, 500);
  if (text === undefined) {
    return undefined;
  }
  const verification =
    record.verification === 'command' ||
    record.verification === 'review' ||
    record.verification === 'manual'
      ? record.verification
      : 'manual';
  return { id: str(record.id, 80) ?? `criterion-${index + 1}`, text, verification };
}

function sanitizeTask(raw: unknown): AgentTask | undefined {
  const record = recordOf(raw);
  if (record === undefined) {
    return undefined;
  }
  const id = str(record.id, 64);
  if (id === undefined || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
    return undefined;
  }
  const title = str(record.title, 200);
  if (title === undefined || !isTaskStatus(record.status)) {
    return undefined;
  }
  const dependsOn = arrayOf(record.dependsOn)
    .filter((dependency): dependency is string => typeof dependency === 'string')
    .slice(0, 20);
  const acceptanceCriteria = arrayOf(record.acceptanceCriteria)
    .slice(0, 10)
    .map(sanitizeCriterion)
    .filter((criterion): criterion is AcceptanceCriterion => criterion !== undefined);
  const suggestedFiles = arrayOf(record.suggestedFiles)
    .filter((path): path is string => typeof path === 'string')
    .slice(0, 20)
    .map((path) => normalizeChangePath(path))
    .filter((path): path is string => path !== undefined);
  const validationCommand =
    typeof record.validationCommand === 'string' && record.validationCommand.length <= 200
      ? record.validationCommand
      : undefined;
  return {
    id,
    title,
    description: str(record.description, 4_000) ?? '',
    dependsOn,
    acceptanceCriteria,
    suggestedFiles,
    validationCommand,
    status: record.status,
    attempts: num(record.attempts),
    repairAttempts: num(record.repairAttempts),
    error: str(record.error, 2_000),
  };
}

function sanitizeTasks(raw: unknown): AgentTask[] {
  return arrayOf(raw)
    .slice(0, 20)
    .map((entry) => sanitizeTask(entry))
    .filter((task): task is AgentTask => task !== undefined);
}

function sanitizePlan(raw: unknown, requirementId: string): {
  plan: AgentSession['plan'];
  tasks: AgentTask[];
} {
  const record = recordOf(raw);
  if (record === undefined) {
    return { plan: undefined, tasks: [] };
  }
  const tasks = sanitizeTasks(record.tasks);
  const graph = validateTaskGraph(tasks);
  const summary = str(record.summary, 4_000);
  if (!graph.ok || summary === undefined) {
    return { plan: undefined, tasks: [] };
  }
  const risks = arrayOf(record.risks)
    .filter((risk): risk is string => typeof risk === 'string')
    .slice(0, 20)
    .map((risk) => clampText(risk, 500));
  const warnings = arrayOf(record.warnings)
    .filter((warning): warning is string => typeof warning === 'string')
    .slice(0, 50)
    .map((warning) => clampText(warning, 500));
  return {
    plan: {
      id: str(record.id, 80) ?? 'plan',
      requirementId: str(record.requirementId, 80) ?? requirementId,
      summary,
      approach: str(record.approach, 8_000) ?? '',
      tasks,
      risks,
      warnings,
      createdAt: iso(record.createdAt) ?? new Date(0).toISOString(),
    },
    tasks,
  };
}

function sanitizeChangePlan(raw: unknown): ChangePlan | undefined {
  const record = recordOf(raw);
  if (record === undefined) {
    return undefined;
  }
  const inputs = arrayOf(record.changes).map((entry) => {
    const change = recordOf(entry);
    if (change === undefined) {
      return undefined;
    }
    return {
      kind: change.kind,
      path: change.path,
      fromPath: change.fromPath,
      content: change.content,
      summary: change.summary,
      expectedHash: change.expectedHash,
    };
  });
  if (inputs.some((input) => input === undefined)) {
    return undefined;
  }
  const validated = validateChangeInputs(
    inputs.filter((input): input is NonNullable<typeof input> => input !== undefined) as Parameters<
      typeof validateChangeInputs
    >[0],
  );
  if (validated.errors.length > 0) {
    return undefined;
  }
  const summary = str(record.summary, 4_000) ?? 'Stored change set';
  const notes = str(record.notes, 4_000);
  return {
    id: str(record.id, 80) ?? 'change-set',
    summary,
    notes,
    changes: validated.changes,
  };
}

function sanitizeDiffs(raw: unknown): UnifiedDiff[] {
  return arrayOf(raw)
    .slice(0, 40)
    .map((entry) => recordOf(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry) => ({
      path: str(entry.path, 500) ?? '',
      text: typeof entry.text === 'string' ? clampText(entry.text, 100_000) : '',
      additions: num(entry.additions),
      deletions: num(entry.deletions),
      truncated: bool(entry.truncated),
    }))
    .filter((diff) => diff.path.length > 0);
}

function sanitizeChangeSet(raw: unknown, taskIds: ReadonlySet<string>): ChangeSet | undefined {
  const record = recordOf(raw);
  if (record === undefined) {
    return undefined;
  }
  const taskId = str(record.taskId, 64);
  const id = str(record.id, 80);
  const plan = sanitizeChangePlan(record.plan);
  if (taskId === undefined || id === undefined || plan === undefined || !taskIds.has(taskId)) {
    return undefined;
  }
  const warnings = arrayOf(record.warnings)
    .filter((warning): warning is string => typeof warning === 'string')
    .slice(0, 50)
    .map((warning) => clampText(warning, 500));
  return {
    id,
    taskId,
    summary: str(record.summary, 4_000) ?? plan.summary,
    plan,
    diffs: sanitizeDiffs(record.diffs),
    warnings,
    createdAt: iso(record.createdAt) ?? new Date(0).toISOString(),
  };
}

function sanitizeAppliedFiles(raw: unknown): AppliedFile[] {
  return arrayOf(raw)
    .slice(0, 50)
    .map((entry) => recordOf(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry) => ({
      path: normalizeChangePath(entry.path),
      hash: entry.hash,
      kind:
        entry.kind === 'create' ||
        entry.kind === 'modify' ||
        entry.kind === 'delete' ||
        entry.kind === 'rename'
          ? entry.kind
          : 'modify',
    }))
    .filter(
      (file): file is AppliedFile =>
        typeof file.path === 'string' &&
        typeof file.hash === 'string' &&
        /^[a-f0-9]{64}$/.test(file.hash),
    );
}

function sanitizeExecution(raw: unknown, taskIds: ReadonlySet<string>): TaskExecution | undefined {
  const record = recordOf(raw);
  if (record === undefined) {
    return undefined;
  }
  const taskId = str(record.taskId, 64);
  if (taskId === undefined || !taskIds.has(taskId) || !isTaskStatus(record.status)) {
    return undefined;
  }
  return {
    taskId,
    status: record.status,
    attempts: num(record.attempts),
    startedAt: iso(record.startedAt),
    finishedAt: iso(record.finishedAt),
    changeSetId: str(record.changeSetId, 80),
    validationRunId: str(record.validationRunId, 80),
    historyTaskId: str(record.historyTaskId, 80),
    appliedFiles: sanitizeAppliedFiles(record.appliedFiles),
    error: str(record.error, 2_000),
  };
}

function sanitizeRequest(raw: unknown): ApprovalRequest | undefined {
  const record = recordOf(raw);
  if (record === undefined) {
    return undefined;
  }
  const kind =
    record.kind === 'plan' ||
    record.kind === 'change-set' ||
    record.kind === 'repair' ||
    record.kind === 'validation-command'
      ? record.kind
      : undefined;
  const id = str(record.id, 80);
  const sessionId = str(record.sessionId, 80);
  if (kind === undefined || id === undefined || sessionId === undefined) {
    return undefined;
  }
  return {
    id,
    sessionId,
    kind,
    title: str(record.title, 200) ?? '',
    detail: str(record.detail, 2_000) ?? '',
    ids: arrayOf(record.ids)
      .filter((entry): entry is string => typeof entry === 'string')
      .slice(0, 200),
    subjectId: str(record.subjectId, 80),
    createdAt: iso(record.createdAt) ?? new Date(0).toISOString(),
  };
}

function sanitizeDecision(raw: unknown): ApprovalDecision | undefined {
  const record = recordOf(raw);
  if (record === undefined) {
    return undefined;
  }
  const kind =
    record.kind === 'plan' ||
    record.kind === 'change-set' ||
    record.kind === 'repair' ||
    record.kind === 'validation-command'
      ? record.kind
      : undefined;
  const outcome =
    record.outcome === 'approved' || record.outcome === 'rejected'
      ? record.outcome
      : undefined;
  const requestId = str(record.requestId, 80);
  if (kind === undefined || outcome === undefined || requestId === undefined) {
    return undefined;
  }
  return {
    requestId,
    kind,
    approvedIds: arrayOf(record.approvedIds)
      .filter((entry): entry is string => typeof entry === 'string')
      .slice(0, 200),
    outcome,
    decidedAt: iso(record.decidedAt) ?? new Date(0).toISOString(),
  };
}

function sanitizeEvidence(raw: unknown): ValidationEvidence | undefined {
  const record = recordOf(raw);
  if (record === undefined) {
    return undefined;
  }
  const command = str(record.command, 200);
  if (command === undefined) {
    return undefined;
  }
  const exitCode =
    typeof record.exitCode === 'number' && Number.isFinite(record.exitCode)
      ? Math.trunc(record.exitCode)
      : null;
  const timedOut = bool(record.timedOut);
  const cancelled = bool(record.cancelled);
  const error = str(record.error, 2_000);
  const output = clampText(redactSecrets(str(record.output, 1_000_000) ?? '', []).text, MAX_VALIDATION_OUTPUT_CHARS);
  return {
    command,
    exitCode,
    passed: exitCode === 0 && !timedOut && !cancelled && error === undefined,
    timedOut,
    cancelled,
    truncated: bool(record.truncated),
    durationMs: num(record.durationMs),
    output,
    error,
  };
}

function sanitizeValidationRun(raw: unknown, taskIds: ReadonlySet<string>): ValidationRun | undefined {
  const record = recordOf(raw);
  if (record === undefined) {
    return undefined;
  }
  const taskId = str(record.taskId, 64);
  const id = str(record.id, 80);
  const evidence = sanitizeEvidence(record.evidence);
  if (taskId === undefined || id === undefined || evidence === undefined || !taskIds.has(taskId)) {
    return undefined;
  }
  return {
    id,
    taskId,
    command: evidence.command,
    startedAt: iso(record.startedAt) ?? new Date(0).toISOString(),
    finishedAt: iso(record.finishedAt) ?? new Date(0).toISOString(),
    evidence,
  };
}

function sanitizeDiagnostic(raw: unknown, index: number): Diagnostic | undefined {
  const record = recordOf(raw);
  if (record === undefined) {
    return undefined;
  }
  const message = str(record.message, 2_000);
  if (message === undefined) {
    return undefined;
  }
  const severity =
    record.severity === 'error' || record.severity === 'warning' || record.severity === 'info'
      ? record.severity
      : 'error';
  const source =
    record.source === 'build' ||
    record.source === 'test' ||
    record.source === 'lint' ||
    record.source === 'typecheck' ||
    record.source === 'runtime' ||
    record.source === 'review'
      ? record.source
      : 'runtime';
  return {
    id: str(record.id, 80) ?? `diag-${index + 1}`,
    severity,
    source,
    message,
    file: str(record.file, 500),
    line:
      typeof record.line === 'number' && Number.isFinite(record.line) && record.line > 0
        ? Math.floor(record.line)
        : undefined,
    command: str(record.command, 200),
  };
}

function sanitizeRepair(raw: unknown, taskIds: ReadonlySet<string>): RepairProposal | undefined {
  const record = recordOf(raw);
  if (record === undefined) {
    return undefined;
  }
  const taskId = str(record.taskId, 64);
  const id = str(record.id, 80);
  const plan = sanitizeChangePlan(record.plan);
  if (taskId === undefined || id === undefined || plan === undefined || !taskIds.has(taskId)) {
    return undefined;
  }
  return {
    id,
    taskId,
    attempt: Math.max(1, num(record.attempt, 1)),
    diagnosis: str(record.diagnosis, 2_000) ?? '',
    summary: str(record.summary, 4_000) ?? plan.summary,
    plan,
    diffs: sanitizeDiffs(record.diffs),
    createdAt: iso(record.createdAt) ?? new Date(0).toISOString(),
  };
}

function sanitizeEvent(raw: unknown, index: number): SessionEvent | undefined {
  const record = recordOf(raw);
  if (record === undefined) {
    return undefined;
  }
  const type =
    record.type === 'state' ||
    record.type === 'task' ||
    record.type === 'approval' ||
    record.type === 'apply' ||
    record.type === 'command' ||
    record.type === 'diagnostic' ||
    record.type === 'repair' ||
    record.type === 'report' ||
    record.type === 'note'
      ? record.type
      : 'note';
  return {
    id: str(record.id, 80) ?? `event-${index + 1}`,
    at: iso(record.at) ?? new Date(0).toISOString(),
    type,
    state: isAgentState(record.state) ? record.state : undefined,
    taskId: str(record.taskId, 64),
    message: clampText(str(record.message, MAX_EVENT_MESSAGE_CHARS) ?? '', MAX_EVENT_MESSAGE_CHARS),
  };
}

function sanitizeReport(raw: unknown, sessionId: string, taskIds: ReadonlySet<string>): CompletionReport | undefined {
  const record = recordOf(raw);
  if (record === undefined || record.sessionId !== sessionId) {
    return undefined;
  }
  const outcome =
    record.outcome === 'completed' ||
    record.outcome === 'failed' ||
    record.outcome === 'cancelled' ||
    record.outcome === 'rejected'
      ? record.outcome
      : undefined;
  const requirement = str(record.requirement);
  if (outcome === undefined || requirement === undefined) {
    return undefined;
  }
  const tasks = arrayOf(record.tasks)
    .slice(0, 20)
    .map((entry) => recordOf(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map<CompletionTaskSummary | undefined>((entry) => {
      const taskId = str(entry.taskId, 64);
      if (taskId === undefined || !taskIds.has(taskId) || !isTaskStatus(entry.status)) {
        return undefined;
      }
      return {
        taskId,
        title: str(entry.title, 200) ?? taskId,
        status: entry.status,
        files: arrayOf(entry.files)
          .filter((file): file is string => typeof file === 'string')
          .slice(0, 50),
      };
    })
    .filter((task): task is CompletionTaskSummary => task !== undefined);
  return {
    sessionId,
    requirement,
    outcome,
    planSummary: str(record.planSummary, 4_000),
    tasks,
    validationRuns: arrayOf(record.validationRuns)
      .map((run) => sanitizeValidationRun(run, taskIds))
      .filter((run): run is ValidationRun => run !== undefined),
    diagnostics: arrayOf(record.diagnostics)
      .slice(0, 50)
      .map(sanitizeDiagnostic)
      .filter((diagnostic): diagnostic is Diagnostic => diagnostic !== undefined),
    repairs: num(record.repairs),
    unresolved: arrayOf(record.unresolved)
      .filter((line): line is string => typeof line === 'string')
      .slice(0, 20)
      .map((line) => clampText(line, 1_000)),
    evidence: arrayOf(record.evidence)
      .filter((line): line is string => typeof line === 'string')
      .slice(0, 100)
      .map((line) => clampText(line, 1_000)),
    generatedAt: iso(record.generatedAt) ?? new Date(0).toISOString(),
  };
}

function compact(session: AgentSession): AgentSession {
  return {
    ...session,
    events: session.events.slice(-100),
    validationRuns: session.validationRuns.map((run) => ({
      ...run,
      evidence: {
        ...run.evidence,
        output: clampText(run.evidence.output, 4_000),
      },
    })),
    changeSets: session.changeSets.slice(-10),
    repairProposals: session.repairProposals.slice(-5),
  };
}

function withinSize(session: AgentSession): boolean {
  return JSON.stringify(session).length <= MAX_SESSION_SERIALIZED_CHARS;
}

/**
 * Validates a stored session and returns only whitelisted fields. Corrupted
 * sessions are dropped rather than partially trusted.
 */
export function sanitizeSession(raw: unknown): AgentSession | undefined {
  const record = recordOf(raw);
  if (record === undefined || record.schemaVersion !== SESSION_SCHEMA_VERSION) {
    return undefined;
  }
  const id = str(record.id, 80);
  const state = record.state;
  const createdAt = iso(record.createdAt);
  const updatedAt = iso(record.updatedAt);
  const requirement = sanitizeRequirement(record.requirement, id ?? 'session');
  if (id === undefined || !isAgentState(state) || createdAt === undefined || updatedAt === undefined || requirement === undefined) {
    return undefined;
  }

  const planResult = sanitizePlan(record.plan, requirement.id);
  let tasks = sanitizeTasks(record.tasks);
  if (tasks.length === 0 && planResult.tasks.length > 0) {
    tasks = planResult.tasks;
  }
  const taskIds = new Set(tasks.map((task) => task.id));
  const graph = validateTaskGraph(tasks);
  const tasksMatchPlan =
    planResult.plan === undefined || planResult.plan.tasks.length === tasks.length;
  const corrupt = !graph.ok || !tasksMatchPlan;

  const executions = arrayOf(record.executions)
    .map((execution) => sanitizeExecution(execution, taskIds))
    .filter((execution): execution is TaskExecution => execution !== undefined);
  const changeSets = arrayOf(record.changeSets)
    .map((changeSet) => sanitizeChangeSet(changeSet, taskIds))
    .filter((changeSet): changeSet is ChangeSet => changeSet !== undefined);
  const validationRuns = arrayOf(record.validationRuns)
    .map((run) => sanitizeValidationRun(run, taskIds))
    .filter((run): run is ValidationRun => run !== undefined);
  const repairProposals = arrayOf(record.repairProposals)
    .map((proposal) => sanitizeRepair(proposal, taskIds))
    .filter((proposal): proposal is RepairProposal => proposal !== undefined);

  let effectiveState = state;
  let pausedFrom = isAgentState(record.pausedFrom) ? record.pausedFrom : undefined;
  if (corrupt && !isTerminalAgentState(state)) {
    effectiveState = 'paused';
    pausedFrom = 'ready';
  }

  const session: AgentSession = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id,
    workspaceRoot: str(record.workspaceRoot, 500) ?? '',
    requirement,
    state: effectiveState,
    pausedFrom,
    needsReview: bool(record.needsReview) || corrupt,
    createdAt,
    updatedAt,
    providerCalls: num(record.providerCalls),
    plan: planResult.plan,
    tasks,
    executions,
    changeSets,
    approvals: arrayOf(record.approvals)
      .map(sanitizeDecision)
      .filter((decision): decision is ApprovalDecision => decision !== undefined),
    pendingApproval: sanitizeRequest(record.pendingApproval),
    validationRuns,
    diagnostics: arrayOf(record.diagnostics)
      .slice(0, 50)
      .map(sanitizeDiagnostic)
      .filter((diagnostic): diagnostic is Diagnostic => diagnostic !== undefined),
    repairProposals,
    events: arrayOf(record.events)
      .slice(-MAX_SESSION_EVENTS)
      .map(sanitizeEvent)
      .filter((event): event is SessionEvent => event !== undefined),
    report: sanitizeReport(record.report, id, taskIds),
    error: str(record.error, 2_000),
  };

  if (withinSize(session)) {
    return session;
  }
  const smaller = compact(session);
  return withinSize(smaller) ? smaller : undefined;
}

function migrateLegacy(raw: Record<string, unknown>): AgentSession | undefined {
  const id = str(raw.id, 80);
  if (id === undefined) {
    return undefined;
  }
  const createdAt = iso(raw.createdAt);
  if (createdAt === undefined) {
    return undefined;
  }
  const requirement =
    sanitizeRequirement(raw.requirement, id) ?? sanitizeRequirement(raw.prompt, id);
  if (requirement === undefined) {
    return undefined;
  }
  const state = isAgentState(raw.state) ? raw.state : 'paused';
  const terminal = isTerminalAgentState(state);
  const at = iso(raw.updatedAt) ?? createdAt;
  const legacyRequirement: Requirement = {
    ...requirement,
    createdAt: requirement.createdAt === new Date(0).toISOString() ? createdAt : requirement.createdAt,
  };
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id,
    workspaceRoot: str(raw.workspaceRoot, 500) ?? str(raw.rootName, 500) ?? '',
    requirement: legacyRequirement,
    state: terminal ? state : 'paused',
    pausedFrom: terminal ? undefined : 'ready',
    needsReview: true,
    createdAt,
    updatedAt: at,
    providerCalls: num(raw.providerCalls),
    tasks: [],
    executions: [],
    changeSets: [],
    approvals: [],
    validationRuns: [],
    diagnostics: [],
    repairProposals: [],
    events: [
      {
        id: `${id}-migrated`,
        at,
        type: 'note',
        state: terminal ? state : 'paused',
        message: 'Migrated a session from an older stored schema.',
      },
    ],
  };
}

export function migrateStoredSession(raw: unknown): AgentSession | undefined {
  const record = recordOf(raw);
  if (record === undefined) {
    return undefined;
  }
  if (record.schemaVersion === SESSION_SCHEMA_VERSION) {
    return sanitizeSession(record);
  }
  if (record.schemaVersion === undefined || record.schemaVersion === 0) {
    return migrateLegacy(record);
  }
  return undefined;
}

export class SessionRepository implements ISessionRepository {
  constructor(
    private readonly store: KeyValueStore,
    private readonly logger: RepositoryLogger = { warn: () => undefined },
  ) {}

  async load(): Promise<readonly AgentSession[]> {
    const raw = this.store.get<unknown>(SESSION_STORAGE_KEY);
    if (raw === undefined) {
      return [];
    }
    const envelope = recordOf(raw);
    if (envelope === undefined || !Array.isArray(envelope.sessions)) {
      this.logger.warn('Ignoring a malformed agent session store.');
      return [];
    }
    const version = envelope.schemaVersion;
    if (typeof version === 'number' && version > SESSION_SCHEMA_VERSION) {
      this.logger.warn(
        `Ignoring session store schema ${version}; this extension supports ${SESSION_SCHEMA_VERSION}.`,
      );
      return [];
    }
    const sessions: AgentSession[] = [];
    const seen = new Set<string>();
    for (const entry of envelope.sessions) {
      const session = migrateStoredSession(entry);
      if (session === undefined || seen.has(session.id)) {
        continue;
      }
      seen.add(session.id);
      sessions.push(session);
    }
    return sessions
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_SESSIONS);
  }

  async get(id: string): Promise<AgentSession | undefined> {
    return (await this.load()).find((session) => session.id === id);
  }

  async save(session: AgentSession): Promise<void> {
    const sanitized = sanitizeSession(session);
    if (sanitized === undefined) {
      this.logger.warn(`Refusing to persist an invalid agent session ${session.id}.`);
      return;
    }
    const compacted = withinSize(sanitized) ? sanitized : compact(sanitized);
    if (!withinSize(compacted)) {
      this.logger.warn(`Agent session ${session.id} exceeds the storage budget and was not saved.`);
      return;
    }
    const existing = await this.load();
    const sessions = [compacted, ...existing.filter((entry) => entry.id !== compacted.id)]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_SESSIONS);
    const envelope: StoredEnvelope = { schemaVersion: SESSION_SCHEMA_VERSION, sessions };
    await this.store.update(SESSION_STORAGE_KEY, envelope);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.load();
    const sessions = existing.filter((session) => session.id !== id);
    await this.store.update(SESSION_STORAGE_KEY, {
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessions,
    } satisfies StoredEnvelope);
  }
}
