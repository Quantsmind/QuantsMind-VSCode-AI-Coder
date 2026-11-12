import { expect } from 'chai';
import type { CommandResult } from '../../src/commands/runner';
import { hashContent, type ChangePlan } from '../../src/changes/model';
import {
  SESSION_SCHEMA_VERSION,
  type AgentSession,
  type AgentSessionView,
  type AgentTask,
  type AppliedFileOutcome,
  type ApplyOutcomeLike,
  type ApplyReportLike,
  type DevelopmentPlan,
  type ExecutionCheckpoint,
  type PreparedChangeSet,
  type ProjectContext,
  type RetrievalResult,
} from '../../src/agent/models';
import { AgentOrchestrator } from '../../src/agent/orchestrator';
import type { CancellationTokenLike, ChatMessage, CompletionResult } from '../../src/providers/types';
import {
  CheckpointRepository,
  type CheckpointKeyValueStore,
} from '../../src/sessions/checkpointRepository';
import type { ISessionRepository } from '../../src/sessions/repository';
import type { WorkspaceSummary } from '../../src/workspace/analyze';
import { waitFor } from './helpers';

/**
 * Permanent regression coverage for the agent orchestrator (D5).
 *
 * Every collaborator is injected, so the suite exercises the real state
 * machine, approval guards, scheduler bounds, retry rules and recovery paths
 * without a provider, a filesystem or a VS Code window.
 */

const ROOT = '/virtual/root';

const TOKEN: CancellationTokenLike = {
  isCancellationRequested: false,
  onCancellationRequested() {
    return { dispose() {} };
  },
};

const CONTEXT: ProjectContext = {
  rootName: 'demo',
  languages: [],
  packageManager: 'npm',
  scripts: { test: 'mocha' },
  configFiles: ['package.json'],
  modules: [],
  entryPoints: [],
  testFiles: 1,
  facts: [],
  summaryText: 'Workspace demo uses npm and exposes a test script.',
};

const SUMMARY: WorkspaceSummary = {
  rootName: 'demo',
  fileCount: 3,
  technologies: [],
  topLevel: [],
  entryPoints: [],
  testFiles: 1,
  text: 'Workspace demo: 3 indexed files.',
};

interface HarnessOptions {
  readonly trusted?: boolean;
  readonly maxConcurrentTasks?: number;
  readonly repository?: ISessionRepository;
  readonly checkpointStore?: CheckpointKeyValueStore;
  readonly onRecord?: (view: AgentSessionView) => void;
}

interface Harness {
  readonly controller: AgentOrchestrator;
  readonly counters: {
    inspect: number;
    retrieve: number;
    complete: number;
    prepare: number;
    apply: number;
    runCommand: number;
  };
  readonly applied: { readonly taskId: string; readonly ids: readonly string[] }[];
  readonly commands: readonly string[];
  readonly warnings: readonly string[];
  planText: string;
  changeTexts: string[];
  repairText: string;
  commandExitCode: number;
  commandOutput: string;
  root: string;
  trusted: boolean;
  blockComplete: Promise<void> | undefined;
}

function developmentPlan(tasks: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    summary: 'Implement the requested change in one focused pass.',
    approach: 'Inspect the workspace, implement the change, and verify it.',
    tasks,
  });
}

function plannedTask(
  id: string,
  title: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title,
    description: `${title} with a single focused change.`,
    dependsOn: [],
    suggestedFiles: ['src/greeting.ts'],
    criteria: [{ text: `${title} is covered by review`, verification: 'review' }],
    ...extra,
  };
}

function changePlan(changes: readonly Record<string, unknown>[], summary: string): string {
  return JSON.stringify({ summary, changes });
}

const ONE_TASK_PLAN = developmentPlan([plannedTask('task-1', 'Add greeting helper')]);
const TWO_TASK_PLAN = developmentPlan([
  plannedTask('task-1', 'Add greeting helper'),
  plannedTask('task-2', 'Document the helper', { suggestedFiles: ['docs/greeting.md'] }),
]);
const VALIDATING_PLAN = developmentPlan([
  plannedTask('task-1', 'Add greeting helper', {
    validationCommand: 'npm test',
    criteria: [{ text: 'npm test passes', verification: 'command' }],
  }),
]);

const GREETING_CHANGE = changePlan(
  [
    {
      kind: 'create',
      path: 'src/greeting.ts',
      summary: 'Create the greeting helper.',
      content: 'export const greeting = "hello";\n',
    },
  ],
  'Add the greeting helper module.',
);
const DOC_CHANGE = changePlan(
  [
    {
      kind: 'create',
      path: 'docs/greeting.md',
      summary: 'Document the greeting helper.',
      content: '# Greeting\n',
    },
  ],
  'Document the greeting helper.',
);
const NO_CHANGE = changePlan([], 'No file change is required.');
const REPAIR_CHANGE = changePlan(
  [
    {
      kind: 'modify',
      path: 'src/greeting.ts',
      summary: 'Fix the failing expectation.',
      content: 'export const greeting = "hello, world";\n',
    },
  ],
  'Make the greeting match the failing expectation.',
);

function createGate(): { readonly promise: Promise<void>; resolve(): void } {
  let settle = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: () => settle() };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const counters = { inspect: 0, retrieve: 0, complete: 0, prepare: 0, apply: 0, runCommand: 0 };
  const applied: { taskId: string; ids: string[] }[] = [];
  const commands: string[] = [];
  const warnings: string[] = [];
  const harness = {
    counters,
    applied,
    commands,
    warnings,
    planText: ONE_TASK_PLAN,
    changeTexts: [GREETING_CHANGE] as string[],
    repairText: REPAIR_CHANGE,
    commandExitCode: 0,
    commandOutput: 'ok',
    root: ROOT,
    trusted: options.trusted ?? true,
    blockComplete: undefined as Promise<void> | undefined,
    controller: undefined as unknown as AgentOrchestrator,
  };

  const controller = new AgentOrchestrator({
    workspaceRoot: () => harness.root,
    isTrusted: () => harness.trusted,
    maxConcurrentTasks: options.maxConcurrentTasks,
    repository: options.repository,
    checkpointRepository:
      options.checkpointStore === undefined
        ? undefined
        : new CheckpointRepository(options.checkpointStore),
    onChange: options.onRecord,
    logger: {
      info: () => undefined,
      warn: (message: string) => {
        warnings.push(message);
      },
    },
    agentSettings: () => ({ maxSteps: 20, maxRepairIterations: 2, timeoutMs: 60_000 }),
    commandSettings: () => ({
      allowlist: ['npm test', 'npm run compile'],
      timeoutMs: 10_000,
      maxOutputChars: 4_000,
    }),
    inspect: async () => {
      counters.inspect += 1;
      return CONTEXT;
    },
    retrieve: async () => {
      counters.retrieve += 1;
      return { summary: SUMMARY, items: [], reasons: {}, skipped: [] } satisfies RetrievalResult;
    },
    complete: async (messages: readonly ChatMessage[]): Promise<CompletionResult> => {
      counters.complete += 1;
      const prompt = messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content)
        .join('\n');
      if (harness.blockComplete !== undefined) {
        await harness.blockComplete;
      }
      if (prompt.includes('Return the JSON development plan now.')) {
        return { text: harness.planText };
      }
      if (prompt.includes('complete replacement change plan')) {
        return { text: harness.repairText };
      }
      return { text: harness.changeTexts.shift() ?? GREETING_CHANGE };
    },
    changes: {
      async prepare(plan: ChangePlan, _taskId: string): Promise<PreparedChangeSet> {
        counters.prepare += 1;
        return { plan, review: [], errors: [], warnings: [] };
      },
      async apply(
        plan: ChangePlan,
        approvedIds: readonly string[],
        taskId: string,
        _summary: string,
        _applyId?: string,
      ): Promise<ApplyReportLike> {
        counters.apply += 1;
        applied.push({ taskId, ids: [...approvedIds] });
        const outcome: ApplyOutcomeLike = {
          applied: plan.changes
            .filter((change) => approvedIds.includes(change.id))
            .map(
              (change): AppliedFileOutcome => ({
                changeId: change.id,
                kind: change.kind,
                path: change.path,
                ...(change.kind === 'delete'
                  ? { before: 'previous content' }
                  : { after: change.content ?? '' }),
                backupName: `backup-${change.id}`,
              }),
            ),
          conflicts: [],
          failed: [],
        };
        return { outcome };
      },
      async undo(_taskId: string): Promise<{ restored: number; conflicts: number }> {
        return { restored: 0, conflicts: 0 };
      },
    },
    runCommand: async (command: string, _signal: AbortSignal): Promise<CommandResult> => {
      counters.runCommand += 1;
      commands.push(command);
      return {
        command,
        cwd: harness.root,
        exitCode: harness.commandExitCode,
        output: harness.commandOutput,
        timedOut: false,
        cancelled: false,
        truncated: false,
        durationMs: 5,
      };
    },
  });

  harness.controller = controller;
  return harness;
}

class MemorySessionRepository implements ISessionRepository {
  constructor(private readonly stored: readonly AgentSession[]) {}

  async load(): Promise<readonly AgentSession[]> {
    return this.stored;
  }

  async get(id: string): Promise<AgentSession | undefined> {
    return this.stored.find((session) => session.id === id);
  }

  async save(_session: AgentSession): Promise<void> {
    return undefined;
  }

  async remove(_id: string): Promise<void> {
    return undefined;
  }
}

class FailingSessionRepository extends MemorySessionRepository {
  override async load(): Promise<readonly AgentSession[]> {
    throw new Error('storage offline');
  }
}

class MemoryCheckpointStore implements CheckpointKeyValueStore {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

async function expectFailure(
  action: () => Promise<unknown>,
  expected: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error, 'the refusal must be an Error').to.be.instanceOf(Error);
    expect((error as Error).message).to.contain(expected);
    return;
  }
  throw new Error(`Expected a refusal containing "${expected}".`);
}

function planRequest(view: AgentSessionView): string {
  const request = view.pendingApproval;
  if (request === undefined || request.kind !== 'plan') {
    throw new Error('The session is not waiting for a plan approval.');
  }
  return request.id;
}

function changeRequest(view: AgentSessionView): string {
  const request = view.pendingApproval;
  if (request === undefined || request.kind !== 'change-set') {
    throw new Error('The session is not waiting for a change approval.');
  }
  return request.id;
}

function taskOf(view: AgentSessionView, taskId: string): AgentTask {
  const task = view.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) {
    throw new Error(`Task "${taskId}" is missing from the session.`);
  }
  return task;
}

function planOf(view: AgentSessionView): DevelopmentPlan {
  if (view.plan === undefined) {
    throw new Error('The session has no development plan.');
  }
  return view.plan;
}

/** Drives the happy path up to the first change-set approval. */
async function startAndApprovePlan(harness: Harness): Promise<AgentSessionView> {
  const started = await harness.controller.start('Add a greeting helper', TOKEN);
  return harness.controller.approvePlan(started.id, TOKEN, planRequest(started));
}

function storedTask(patch: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task-1',
    title: 'Add greeting helper',
    description: 'Add a greeting helper with a single focused change.',
    dependsOn: [],
    acceptanceCriteria: [],
    suggestedFiles: [],
    status: 'failed',
    attempts: 1,
    repairAttempts: 0,
    error: 'The previous attempt failed.',
    ...patch,
  };
}

function storedSession(patch: Partial<AgentSession> = {}): AgentSession {
  const at = '2026-01-01T00:00:00.000Z';
  const tasks = patch.tasks ?? [storedTask()];
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: 'session-stored',
    workspaceRoot: ROOT,
    requirement: { id: 'req-stored', text: 'Stored requirement', createdAt: at },
    state: 'ready',
    needsReview: false,
    createdAt: at,
    updatedAt: at,
    providerCalls: 1,
    plan: {
      id: 'session-stored-plan',
      requirementId: 'req-stored',
      summary: 'Stored plan.',
      approach: 'Continue the stored work.',
      tasks,
      risks: [],
      warnings: [],
      createdAt: at,
    },
    tasks,
    executions: [],
    changeSets: [],
    approvals: [],
    validationRuns: [],
    validationSuggestions: [],
    diagnostics: [],
    repairProposals: [],
    events: [],
    ...patch,
  };
}

suite('agent orchestrator lifecycle, approvals and recovery (D5)', () => {
  suite('session start', () => {
    test('refuses an empty requirement before inspecting anything', async () => {
      const harness = createHarness();
      await expectFailure(
        () => harness.controller.start('   ', TOKEN),
        'The requirement must not be empty.',
      );
      expect(harness.counters.inspect).to.equal(0);
      expect(harness.controller.list()).to.have.length(0);
    });

    test('refuses to start while the workspace is untrusted', async () => {
      const harness = createHarness({ trusted: false });
      await expectFailure(
        () => harness.controller.start('Add a greeting helper', TOKEN),
        'Workspace trust is required to start an agent session.',
      );
      expect(harness.controller.list()).to.have.length(0);
    });

    test('inspects, plans and waits for an exact plan approval', async () => {
      const harness = createHarness();
      const view = await harness.controller.start('Add a greeting helper', TOKEN);

      expect(view.state).to.equal('awaiting-plan-approval');
      expect(view.workspaceRoot).to.equal(ROOT);
      expect(view.providerCalls).to.equal(1);
      expect(view.plan?.tasks.map((task) => task.id)).to.deep.equal(['task-1']);
      expect(harness.counters.inspect).to.equal(1);
      expect(harness.counters.retrieve).to.equal(1);
      expect(harness.counters.complete).to.equal(1);

      const request = harness.controller.pendingApproval(view.id);
      expect(request?.kind).to.equal('plan');
      expect(view.pendingApproval?.id).to.equal(request?.id);
      expect(harness.controller.view(view.id)?.state).to.equal('awaiting-plan-approval');
    });

    test('fails the session when the provider returns no parseable plan', async () => {
      const harness = createHarness();
      harness.planText = 'I cannot help with that.';
      const view = await harness.controller.start('Add a greeting helper', TOKEN);

      expect(view.state).to.equal('failed');
      expect(view.error).to.contain('did not contain a JSON development plan');
      expect(view.report?.outcome).to.equal('failed');
    });
  });

  suite('plan approval', () => {
    test('refuses plan decisions that do not name the pending request', async () => {
      const harness = createHarness();
      const started = await harness.controller.start('Add a greeting helper', TOKEN);
      const requestId = planRequest(started);

      await expectFailure(
        () => harness.controller.approvePlan(started.id, TOKEN, ''),
        'The plan decision must name the pending request.',
      );
      await expectFailure(
        () => harness.controller.approvePlan(started.id, TOKEN, 'approval-stale'),
        'superseded request',
      );
      await expectFailure(
        () => harness.controller.rejectPlan(started.id, 'approval-stale'),
        'superseded request',
      );

      const view = harness.controller.view(started.id);
      expect(view?.state).to.equal('awaiting-plan-approval');
      expect(view?.approvals).to.have.length(0);

      const approved = await harness.controller.approvePlan(started.id, TOKEN, requestId);
      expect(approved.state).to.equal('awaiting-change-approval');
      expect(approved.approvals.map((decision) => decision.outcome)).to.deep.equal(['approved']);
    });

    test('rejecting the plan finishes the session as rejected', async () => {
      const harness = createHarness();
      const started = await harness.controller.start('Add a greeting helper', TOKEN);
      const requestId = planRequest(started);
      const rejected = await harness.controller.rejectPlan(started.id, requestId);

      expect(rejected.state).to.equal('rejected');
      expect(rejected.report?.outcome).to.equal('rejected');
      expect(rejected.pendingApproval).to.equal(undefined);
      expect(rejected.tasks.every((task) => task.status === 'skipped')).to.equal(true);
      await expectFailure(
        () => harness.controller.approvePlan(started.id, TOKEN, requestId),
        'not waiting for plan approval',
      );
    });
  });

  suite('change approval and apply', () => {
    test('stops at change approval without touching the workspace', async () => {
      const harness = createHarness();
      const view = await startAndApprovePlan(harness);

      expect(view.state).to.equal('awaiting-change-approval');
      expect(taskOf(view, 'task-1').status).to.equal('awaiting-approval');
      expect(view.changeSets).to.have.length(1);
      expect(view.changeSets[0].status).to.equal('pending');
      expect(harness.counters.apply).to.equal(0);
      expect(harness.counters.prepare).to.equal(1);

      const request = harness.controller.pendingApproval(view.id);
      expect(request?.kind).to.equal('change-set');
      expect(request?.ids).to.deep.equal(['change-1']);
      expect(request?.changeSetVersion).to.equal(view.changeSets[0].version);
    });

    test('applies exactly the approved operations and completes the session', async () => {
      const harness = createHarness();
      const planned = await startAndApprovePlan(harness);
      const requestId = changeRequest(planned);

      const applied = await harness.controller.approveChanges(
        planned.id,
        ['change-1'],
        TOKEN,
        requestId,
      );

      expect(applied.state).to.equal('completed');
      expect(harness.counters.apply).to.equal(1);
      expect(harness.applied[0]?.ids).to.deep.equal(['change-1']);
      expect(applied.changeSets[0].status).to.equal('applied');
      expect(taskOf(applied, 'task-1').status).to.equal('completed');
      expect(applied.executions[0]?.appliedFiles).to.have.length(1);
      expect(applied.report?.outcome).to.equal('completed');

      await expectFailure(
        () => harness.controller.approveChanges(planned.id, ['change-1'], TOKEN, requestId),
        'not waiting for change approval',
      );
      expect(harness.counters.apply).to.equal(1);
    });

    test('refuses an approval that does not match the remaining operation set', async () => {
      const harness = createHarness();
      const planned = await startAndApprovePlan(harness);
      const requestId = changeRequest(planned);

      const failed = await harness.controller.approveChanges(
        planned.id,
        ['change-1', 'change-2'],
        TOKEN,
        requestId,
      );

      expect(failed.state).to.equal('failed');
      expect(failed.error).to.contain('does not match the exact remaining operation set');
      expect(harness.counters.apply).to.equal(0);
    });

    test('refuses approved ids that do not belong to the change set', async () => {
      const harness = createHarness();
      const planned = await startAndApprovePlan(harness);
      const requestId = changeRequest(planned);

      await expectFailure(
        () => harness.controller.approveChanges(planned.id, ['change-9'], TOKEN, requestId),
        'do not belong to the current change set',
      );
      expect(harness.counters.apply).to.equal(0);
    });

    test('rejecting the change set skips the task and finishes the session', async () => {
      const harness = createHarness();
      const planned = await startAndApprovePlan(harness);
      const rejected = await harness.controller.rejectChanges(planned.id, changeRequest(planned));

      expect(rejected.state).to.equal('rejected');
      expect(rejected.changeSets[0].status).to.equal('rejected');
      expect(taskOf(rejected, 'task-1').status).to.equal('skipped');
      expect(rejected.report?.outcome).to.equal('rejected');
      expect(harness.counters.apply).to.equal(0);
    });

    test('an explicitly empty change plan completes without applying anything', async () => {
      const harness = createHarness();
      harness.changeTexts = [NO_CHANGE];
      const planned = await startAndApprovePlan(harness);

      expect(planned.state).to.equal('completed');
      expect(planned.changeSets).to.have.length(0);
      expect(harness.counters.apply).to.equal(0);
      expect(taskOf(planned, 'task-1').status).to.equal('completed');
      expect(planned.validationRuns.some((run) => run.outcome === 'skipped')).to.equal(true);
    });
  });

  suite('validation and repair', () => {
    test('runs only an approved allowlisted command and completes the task', async () => {
      const harness = createHarness();
      harness.planText = VALIDATING_PLAN;
      const planned = await startAndApprovePlan(harness);
      const applied = await harness.controller.approveChanges(
        planned.id,
        ['change-1'],
        TOKEN,
        changeRequest(planned),
      );

      expect(applied.state).to.equal('validating');
      expect(taskOf(applied, 'task-1').status).to.equal('applied');

      const requested = await harness.controller.requestValidation(applied.id, 'npm test');
      const request = requested.pendingApproval;
      expect(request?.kind).to.equal('validation-command');
      expect(request?.command).to.equal('npm test');

      const validated = await harness.controller.approveValidation(
        applied.id,
        request?.id ?? '',
        new AbortController().signal,
      );

      expect(harness.commands).to.deep.equal(['npm test']);
      expect(validated.state).to.equal('completed');
      expect(taskOf(validated, 'task-1').status).to.equal('completed');
      expect(validated.validationRuns[0]?.outcome).to.equal('passed');
      expect(validated.validationRuns[0]?.changeSetId).to.equal(validated.changeSets[0]?.id);
      expect(validated.report?.outcome).to.equal('completed');
    });

    test('refuses a validation command that is not on the allowlist', async () => {
      const harness = createHarness();
      harness.planText = VALIDATING_PLAN;
      const planned = await startAndApprovePlan(harness);
      const applied = await harness.controller.approveChanges(
        planned.id,
        ['change-1'],
        TOKEN,
        changeRequest(planned),
      );

      const denied = await harness.controller.requestValidation(applied.id, 'rm -rf /');

      expect(denied.state).to.equal('failed');
      expect(denied.diagnostics.some((entry) => entry.message.includes('not permitted'))).to.equal(
        true,
      );
      expect(harness.counters.runCommand).to.equal(0);
    });

    test('a refused validation request records a skipped run', async () => {
      const harness = createHarness();
      harness.planText = VALIDATING_PLAN;
      const planned = await startAndApprovePlan(harness);
      const applied = await harness.controller.approveChanges(
        planned.id,
        ['change-1'],
        TOKEN,
        changeRequest(planned),
      );
      const requested = await harness.controller.requestValidation(applied.id, 'npm test');
      const requestId = requested.pendingApproval?.id ?? '';

      const rejected = await harness.controller.rejectValidation(applied.id, requestId);

      expect(rejected.state).to.equal('validating');
      expect(rejected.pendingApproval).to.equal(undefined);
      expect(rejected.validationRuns[rejected.validationRuns.length - 1]?.outcome).to.equal(
        'skipped',
      );
      expect(harness.counters.runCommand).to.equal(0);
    });

    test('refuses an approved command bound to another workspace folder', async () => {
      const harness = createHarness();
      harness.planText = VALIDATING_PLAN;
      const planned = await startAndApprovePlan(harness);
      const applied = await harness.controller.approveChanges(
        planned.id,
        ['change-1'],
        TOKEN,
        changeRequest(planned),
      );
      const requested = await harness.controller.requestValidation(applied.id, 'npm test');
      const requestId = requested.pendingApproval?.id ?? '';
      harness.root = '/virtual/other';

      await expectFailure(
        () =>
          harness.controller.approveValidation(applied.id, requestId, new AbortController().signal),
        'belongs to a different workspace folder',
      );
      expect(harness.counters.runCommand).to.equal(0);
    });

    test('a failing validation run opens the diagnosing state', async () => {
      const harness = createHarness();
      harness.planText = VALIDATING_PLAN;
      harness.commandExitCode = 1;
      harness.commandOutput = 'AssertionError: expected 1 to equal 2';
      const planned = await startAndApprovePlan(harness);
      const applied = await harness.controller.approveChanges(
        planned.id,
        ['change-1'],
        TOKEN,
        changeRequest(planned),
      );
      const requested = await harness.controller.requestValidation(applied.id, 'npm test');

      const diagnosed = await harness.controller.approveValidation(
        applied.id,
        requested.pendingApproval?.id ?? '',
        new AbortController().signal,
      );

      expect(diagnosed.state).to.equal('diagnosing');
      expect(taskOf(diagnosed, 'task-1').status).to.equal('validation-failed');
      expect(diagnosed.diagnostics.length).to.be.greaterThan(0);
      expect(diagnosed.validationRuns[0]?.outcome).to.equal('failed');
    });

    test('generates, approves and applies a repair before validating again', async () => {
      const harness = createHarness();
      harness.planText = VALIDATING_PLAN;
      harness.commandExitCode = 1;
      const planned = await startAndApprovePlan(harness);
      const applied = await harness.controller.approveChanges(
        planned.id,
        ['change-1'],
        TOKEN,
        changeRequest(planned),
      );
      await harness.controller.requestValidation(applied.id, 'npm test');
      await harness.controller.approveValidation(
        applied.id,
        harness.controller.pendingApproval(applied.id)?.id ?? '',
        new AbortController().signal,
      );

      const proposed = await harness.controller.generateRepair(applied.id, TOKEN);
      expect(proposed.state).to.equal('awaiting-repair-approval');
      expect(proposed.repairProposals).to.have.length(1);
      expect(taskOf(proposed, 'task-1').repairAttempts).to.equal(1);

      const requestId = harness.controller.pendingApproval(applied.id)?.id ?? '';
      const repaired = await harness.controller.approveRepair(
        applied.id,
        ['change-1'],
        TOKEN,
        requestId,
      );

      expect(repaired.state).to.equal('validating');
      expect(taskOf(repaired, 'task-1').status).to.equal('applied');
      expect(harness.counters.apply).to.equal(2);
      expect(harness.counters.complete).to.equal(3);
    });

    test('rejecting a repair proposal fails the session', async () => {
      const harness = createHarness();
      harness.planText = VALIDATING_PLAN;
      harness.commandExitCode = 1;
      const planned = await startAndApprovePlan(harness);
      const applied = await harness.controller.approveChanges(
        planned.id,
        ['change-1'],
        TOKEN,
        changeRequest(planned),
      );
      await harness.controller.requestValidation(applied.id, 'npm test');
      await harness.controller.approveValidation(
        applied.id,
        harness.controller.pendingApproval(applied.id)?.id ?? '',
        new AbortController().signal,
      );
      await harness.controller.generateRepair(applied.id, TOKEN);
      const requestId = harness.controller.pendingApproval(applied.id)?.id ?? '';

      const failed = await harness.controller.rejectRepair(applied.id, requestId);

      expect(failed.state).to.equal('failed');
      expect(failed.error).to.contain('rejected by the user');
      expect(failed.report?.outcome).to.equal('failed');
    });
  });

  suite('cancellation, pause and resume', () => {
    test('cancelling a session clears its pending approval and report', async () => {
      const harness = createHarness();
      const started = await harness.controller.start('Add a greeting helper', TOKEN);
      const requestId = planRequest(started);

      const cancelled = await harness.controller.cancel(started.id);

      expect(cancelled.state).to.equal('cancelled');
      expect(cancelled.pendingApproval).to.equal(undefined);
      expect(cancelled.report?.outcome).to.equal('cancelled');
      expect(cancelled.tasks.every((task) => task.status === 'cancelled')).to.equal(true);
      await expectFailure(
        () => harness.controller.approvePlan(started.id, TOKEN, requestId),
        'not waiting for plan approval',
      );
    });

    test('cancelling one task leaves the other task untouched', async () => {
      const harness = createHarness({ maxConcurrentTasks: 1 });
      harness.planText = TWO_TASK_PLAN;
      const planned = await startAndApprovePlan(harness);

      expect(taskOf(planned, 'task-1').status).to.equal('awaiting-approval');
      expect(taskOf(planned, 'task-2').status).to.equal('pending');

      const after = await harness.controller.cancelTask(planned.id, 'task-1');

      expect(taskOf(after, 'task-1').status).to.equal('cancelled');
      expect(taskOf(after, 'task-2').status).to.equal('pending');
      expect(after.changeSets[0].status).to.equal('failed');
      expect(after.taskApprovals ?? []).to.have.length(0);
      await expectFailure(
        () => harness.controller.cancelTask(planned.id, 'task-2'),
        'is not active and cannot be cancelled',
      );
      expect(harness.counters.apply).to.equal(0);
    });

    test('pauses and resumes at plan approval', async () => {
      const harness = createHarness();
      const started = await harness.controller.start('Add a greeting helper', TOKEN);

      const paused = await harness.controller.pause(started.id);
      expect(paused.state).to.equal('paused');
      expect(paused.pausedFrom).to.equal('awaiting-plan-approval');
      await expectFailure(() => harness.controller.pause(started.id), 'already paused');

      const resumed = await harness.controller.resume(started.id, TOKEN);
      expect(resumed.state).to.equal('awaiting-plan-approval');
      await expectFailure(
        () => harness.controller.resume(started.id, TOKEN),
        'Only a paused session can be resumed.',
      );
    });

    test('refuses to pause a finished session', async () => {
      const harness = createHarness();
      harness.changeTexts = [NO_CHANGE];
      const view = await startAndApprovePlan(harness);

      await expectFailure(() => harness.controller.pause(view.id), 'already finished');
    });
  });

  suite('task retry', () => {
    async function loadFailedSession(patch: Partial<AgentSession> = {}): Promise<Harness> {
      const harness = createHarness({
        repository: new MemorySessionRepository([storedSession(patch)]),
      });
      const loaded = await harness.controller.loadStoredSessions();
      expect(loaded).to.have.length(1);
      return harness;
    }

    test('retries a failed task and re-enters execution', async () => {
      const harness = await loadFailedSession();
      const sessionId = 'session-stored';

      const retried = await harness.controller.retryTask(sessionId, 'task-1', TOKEN);

      expect(taskOf(retried, 'task-1').status).to.equal('awaiting-approval');
      expect(taskOf(retried, 'task-1').attempts).to.equal(2);
      expect(retried.state).to.equal('awaiting-change-approval');
      expect(harness.counters.complete).to.equal(1);
      expect(retried.events.some((event) => event.message.includes('Retrying task'))).to.equal(true);
    });

    test('refuses a retry for a task that is not failed', async () => {
      const harness = await loadFailedSession({
        tasks: [storedTask({ status: 'completed', error: undefined })],
      });
      await expectFailure(
        () => harness.controller.retryTask('session-stored', 'task-1', TOKEN),
        'is not eligible for retry',
      );
    });

    test('refuses a retry once the attempt limit is reached', async () => {
      const harness = await loadFailedSession({ tasks: [storedTask({ attempts: 3 })] });
      await expectFailure(
        () => harness.controller.retryTask('session-stored', 'task-1', TOKEN),
        'has reached the retry limit',
      );
    });

    test('refuses a retry while dependencies are unresolved', async () => {
      const harness = await loadFailedSession({
        tasks: [storedTask({ dependsOn: ['task-0'] })],
      });
      await expectFailure(
        () => harness.controller.retryTask('session-stored', 'task-1', TOKEN),
        'has unresolved dependencies',
      );
    });

    test('refuses a retry for a task that does not exist', async () => {
      const harness = await loadFailedSession();
      await expectFailure(
        () => harness.controller.retryTask('session-stored', 'task-missing', TOKEN),
        'is missing from the session',
      );
    });
  });

  suite('duplicate operation guards', () => {
    test('refuses operations while another operation is in flight', async () => {
      const harness = createHarness();
      const gate = createGate();
      harness.blockComplete = gate.promise;

      const starting = harness.controller.start('Add a greeting helper', TOKEN);
      await waitFor(() => harness.counters.complete === 1);
      const sessionId = harness.controller.list()[0].id;

      await expectFailure(
        () => harness.controller.pause(sessionId),
        'The session is busy; cannot pause right now.',
      );
      await expectFailure(
        () => harness.controller.restore(sessionId),
        'The session is busy; cannot restore it right now.',
      );
      await expectFailure(
        () => harness.controller.cancelTask(sessionId, 'task-1'),
        'The session is busy; cannot cancel a task right now.',
      );

      gate.resolve();
      const view = await starting;
      expect(view.state).to.equal('awaiting-plan-approval');
      expect(harness.counters.complete).to.equal(1);
    });

    test('refuses a second decision for an already consumed plan request', async () => {
      const harness = createHarness();
      const started = await harness.controller.start('Add a greeting helper', TOKEN);
      const requestId = planRequest(started);
      const approved = await harness.controller.approvePlan(started.id, TOKEN, requestId);

      expect(approved.approvals).to.have.length(1);
      await expectFailure(
        () => harness.controller.approvePlan(started.id, TOKEN, requestId),
        'not waiting for plan approval',
      );
      await expectFailure(
        () => harness.controller.rejectPlan(started.id, requestId),
        'not waiting for plan approval',
      );
    });
  });

  suite('workspace trust', () => {
    test('refuses approvals, resume and restore once trust is withdrawn', async () => {
      const harness = createHarness();
      const started = await harness.controller.start('Add a greeting helper', TOKEN);
      const requestId = planRequest(started);
      harness.trusted = false;

      await expectFailure(
        () => harness.controller.approvePlan(started.id, TOKEN, requestId),
        'Workspace trust is required to approve an agent plan.',
      );

      const paused = await harness.controller.pause(started.id);
      expect(paused.state).to.equal('paused');
      await expectFailure(
        () => harness.controller.resume(started.id, TOKEN),
        'Workspace trust is required to resume an agent session.',
      );
      await expectFailure(
        () => harness.controller.restore(started.id),
        'Workspace trust is required to restore an active agent session.',
      );
      await expectFailure(
        () => harness.controller.retryTask(started.id, 'task-1', TOKEN),
        'Workspace trust is required to retry a task.',
      );
    });
  });

  suite('checkpoint recovery', () => {
    function checkpointFor(
      view: AgentSessionView,
      variants: { readonly staleRecovery?: boolean; readonly unknownTask?: boolean } = {},
    ): ExecutionCheckpoint {
      const plan = planOf(view);
      const taskResults =
        variants.unknownTask === true
          ? [{ taskId: 'task-ghost', status: 'completed' as const, attempts: 1 }]
          : view.tasks.map((task) => ({
              taskId: task.id,
              status: task.status,
              attempts: task.attempts,
              summary: task.title,
              error: task.error,
            }));
      return {
        id: `${view.id}-checkpoint-manual`,
        sessionId: view.id,
        executionId: view.id,
        sequence: 1,
        planId: plan.id,
        planVersion: hashContent(JSON.stringify(plan)),
        completedTaskIds: [],
        pendingTaskIds: view.tasks.map((task) => task.id),
        failedTaskIds: [],
        blockedTaskIds: [],
        taskResults,
        pendingApprovalIds: view.pendingApproval === undefined ? [] : [view.pendingApproval.id],
        changeSetIds: [],
        appliedChangeIds: [],
        validationRunIds: [],
        repositoryStateRef: view.workspaceRoot,
        recoveryVersion: variants.staleRecovery === true ? 0 : (view.recoveryVersion ?? 0),
        createdAt: view.updatedAt,
        status: 'valid',
        schemaVersion: SESSION_SCHEMA_VERSION,
      };
    }

    test('restores an interrupted execution from a matching checkpoint', async () => {
      const store = new MemoryCheckpointStore();
      const harness = createHarness({ checkpointStore: store });
      const started = await harness.controller.start('Add a greeting helper', TOKEN);
      await new CheckpointRepository(store).save(checkpointFor(started));

      const result = await harness.controller.restoreFromCheckpoint(started.id);

      expect(result.outcome).to.equal('restored');
      const restored = harness.controller.view(started.id);
      expect(restored?.state).to.equal('paused');
      expect(restored?.pausedFrom).to.equal('awaiting-plan-approval');
      expect(
        restored?.events.some((event) => event.message.includes('Restored checkpoint')),
      ).to.equal(true);
      expect(await harness.controller.detectInterruptedExecutions()).to.deep.equal([started.id]);
    });

    test('a second restore does not duplicate or corrupt task state', async () => {
      const store = new MemoryCheckpointStore();
      const harness = createHarness({ checkpointStore: store });
      const started = await harness.controller.start('Add a greeting helper', TOKEN);
      await new CheckpointRepository(store).save(checkpointFor(started));

      const first = await harness.controller.restoreFromCheckpoint(started.id);
      expect(first.outcome).to.equal('restored');
      const afterFirst = harness.controller.view(started.id);
      expect(afterFirst?.state).to.equal('paused');
      const firstSnapshot = JSON.stringify({
        tasks: afterFirst?.tasks,
        executions: afterFirst?.executions,
        changeSets: afterFirst?.changeSets,
        approvals: afterFirst?.approvals,
      });

      const second = await harness.controller.restoreFromCheckpoint(started.id);
      // The session advanced its recovery version during the first restore, so a
      // replay against the same checkpoint lineage refuses as stale rather than
      // silently re-applying or duplicating state.
      expect(second.outcome).to.equal('checkpoint-rejected');
      const afterSecond = harness.controller.view(started.id);
      expect(afterSecond?.state).to.equal('paused');
      expect(
        JSON.stringify({
          tasks: afterSecond?.tasks,
          executions: afterSecond?.executions,
          changeSets: afterSecond?.changeSets,
          approvals: afterSecond?.approvals,
        }),
      ).to.equal(firstSnapshot);
      expect(afterSecond?.tasks).to.have.length(afterFirst?.tasks.length ?? -1);
      expect(afterSecond?.executions).to.have.length(afterFirst?.executions.length ?? -1);
      expect(await harness.controller.detectInterruptedExecutions()).to.deep.equal([started.id]);
    });

    test('rejects a checkpoint that is older than the session', async () => {
      const store = new MemoryCheckpointStore();
      const harness = createHarness({ checkpointStore: store });
      const started = await harness.controller.start('Add a greeting helper', TOKEN);
      await new CheckpointRepository(store).save(
        checkpointFor(started, { staleRecovery: true }),
      );

      const result = await harness.controller.restoreFromCheckpoint(started.id);

      expect(result.outcome).to.equal('checkpoint-rejected');
      expect(result.message).to.contain('older than the current session state');
    });

    test('rejects a checkpoint that names an unknown task', async () => {
      const store = new MemoryCheckpointStore();
      const harness = createHarness({ checkpointStore: store });
      const started = await harness.controller.start('Add a greeting helper', TOKEN);
      await new CheckpointRepository(store).save(
        checkpointFor(started, { unknownTask: true }),
      );

      const result = await harness.controller.restoreFromCheckpoint(started.id);

      expect(result.outcome).to.equal('checkpoint-rejected');
      expect(result.message).to.contain('unknown task IDs');
    });

    test('reports a missing repository, unknown session and terminal session', async () => {
      const noRepository = createHarness();
      const started = await noRepository.controller.start('Add a greeting helper', TOKEN);
      expect(
        (await noRepository.controller.restoreFromCheckpoint(started.id)).outcome,
      ).to.equal('no-valid-checkpoint');
      expect(
        (await noRepository.controller.restoreFromCheckpoint('session-ghost')).outcome,
      ).to.equal('restoration-failed');

      const harness = createHarness({ checkpointStore: new MemoryCheckpointStore() });
      const view = await harness.controller.start('Add a greeting helper', TOKEN);
      await harness.controller.rejectPlan(view.id, planRequest(view));
      expect((await harness.controller.restoreFromCheckpoint(view.id)).outcome).to.equal(
        'no-interrupted-execution',
      );
      expect(await harness.controller.detectInterruptedExecutions()).to.deep.equal([]);
    });

    test('refuses checkpoint restoration while the workspace is untrusted', async () => {
      const harness = createHarness({ trusted: false, checkpointStore: new MemoryCheckpointStore() });
      const result = await harness.controller.restoreFromCheckpoint('session-stored');

      expect(result.outcome).to.equal('restoration-failed');
      expect(result.message).to.contain('Workspace trust is required');
    });
  });

  suite('session persistence', () => {
    test('loads stored sessions and skips ones already in memory', async () => {
      const repository = new MemorySessionRepository([storedSession()]);
      const harness = createHarness({ repository });
      const first = await harness.controller.loadStoredSessions();
      const second = await harness.controller.loadStoredSessions();

      expect(first).to.have.length(1);
      expect(second).to.have.length(1);
      expect(first[0].id).to.equal('session-stored');
      expect(second[0].id).to.equal('session-stored');
    });

    test('keeps working when persisted sessions cannot be read', async () => {
      const harness = createHarness({ repository: new FailingSessionRepository([]) });
      const loaded = await harness.controller.loadStoredSessions();

      expect(loaded).to.have.length(0);
      expect(harness.warnings.some((line) => line.includes('Could not load persisted'))).to.equal(
        true,
      );
    });

    test('refuses to restore a session that belongs to another workspace', async () => {
      const harness = createHarness({
        repository: new MemorySessionRepository([storedSession()]),
      });
      await harness.controller.loadStoredSessions();
      harness.root = '/virtual/other';

      expect(await harness.controller.restore('session-stored')).to.equal(undefined);
      expect(await harness.controller.restore('session-ghost')).to.equal(undefined);
    });

    test('restores a stored session for the current workspace root', async () => {
      const harness = createHarness({
        repository: new MemorySessionRepository([storedSession()]),
      });
      await harness.controller.loadStoredSessions();

      const restored = await harness.controller.restore('session-stored');

      expect(restored?.id).to.equal('session-stored');
      expect(restored?.state).to.equal('paused');
      expect(restored?.pausedFrom).to.equal('ready');
      expect(restored?.needsReview).to.equal(true);
    });
  });

  suite('terminal task states and pause (D7)', () => {
    test('a validated session resting at user control can be paused and resumed', async () => {
      const harness = createHarness();
      harness.planText = VALIDATING_PLAN;
      const planned = await startAndApprovePlan(harness);
      const applied = await harness.controller.approveChanges(
        planned.id,
        ['change-1'],
        TOKEN,
        changeRequest(planned),
      );

      expect(applied.state).to.equal('validating');
      expect(taskOf(applied, 'task-1').status).to.equal('applied');

      const paused = await harness.controller.pause(applied.id);

      expect(paused.state).to.equal('paused');
      expect(paused.pausedFrom).to.equal('validating');

      const resumed = await harness.controller.resume(applied.id, TOKEN);

      expect(resumed.state).to.equal('validating');
    });

    test('cancelling the validating task does not report work in progress', async () => {
      const harness = createHarness();
      harness.planText = VALIDATING_PLAN;
      const planned = await startAndApprovePlan(harness);
      const applied = await harness.controller.approveChanges(
        planned.id,
        ['change-1'],
        TOKEN,
        changeRequest(planned),
      );

      const cancelled = await harness.controller.cancelTask(applied.id, 'task-1');

      expect(taskOf(cancelled, 'task-1').status).to.equal('cancelled');
      expect(cancelled.state).to.equal('failed');
      expect(cancelled.report?.outcome).to.equal('failed');

      let message = '';
      try {
        await harness.controller.pause(applied.id);
        expect.fail('pausing a finished session should have been refused.');
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).to.not.contain('work is in progress');
      expect(message).to.contain('already finished');
    });

    test('cancelling the last active task settles the session so pause fails honestly', async () => {
      const harness = createHarness({ maxConcurrentTasks: 2 });
      harness.planText = TWO_TASK_PLAN;
      harness.changeTexts = [GREETING_CHANGE, DOC_CHANGE];
      const planned = await startAndApprovePlan(harness);

      expect(taskOf(planned, 'task-1').status).to.equal('awaiting-approval');
      expect(taskOf(planned, 'task-2').status).to.equal('awaiting-approval');

      const afterFirst = await harness.controller.cancelTask(planned.id, 'task-1');
      expect(taskOf(afterFirst, 'task-1').status).to.equal('cancelled');
      expect(afterFirst.state).to.equal('awaiting-change-approval');

      const afterSecond = await harness.controller.cancelTask(planned.id, 'task-2');
      expect(taskOf(afterSecond, 'task-2').status).to.equal('cancelled');
      expect(afterSecond.state).to.equal('failed');

      let message = '';
      try {
        await harness.controller.pause(planned.id);
        expect.fail('pausing a finished session should have been refused.');
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).to.not.contain('work is in progress');
      expect(message).to.contain('already finished');
    });

    test('a finished session reports its terminal state to pause, never work in progress', async () => {
      const harness = createHarness();
      harness.changeTexts = [NO_CHANGE];
      const view = await startAndApprovePlan(harness);

      let message = '';
      try {
        await harness.controller.pause(view.id);
        expect.fail('pausing a finished session should have been refused.');
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).to.not.contain('work is in progress');
      expect(message).to.contain('already finished');
    });
  });

  suite('task concurrency', () => {
    test('runs one task at a time by default', async () => {
      const harness = createHarness();
      harness.planText = TWO_TASK_PLAN;
      harness.changeTexts = [GREETING_CHANGE, DOC_CHANGE];

      const view = await startAndApprovePlan(harness);

      expect(taskOf(view, 'task-1').status).to.equal('awaiting-approval');
      expect(taskOf(view, 'task-2').status).to.equal('pending');
      expect(view.changeSets).to.have.length(1);
      expect(harness.counters.complete).to.equal(2);
      expect(harness.counters.retrieve).to.equal(2);
    });

    test('starts a second independent task when concurrency is raised', async () => {
      const harness = createHarness({ maxConcurrentTasks: 2 });
      harness.planText = TWO_TASK_PLAN;
      harness.changeTexts = [GREETING_CHANGE, DOC_CHANGE];

      const view = await startAndApprovePlan(harness);

      expect(taskOf(view, 'task-1').status).to.equal('awaiting-approval');
      expect(taskOf(view, 'task-2').status).to.equal('awaiting-approval');
      expect(view.changeSets).to.have.length(2);
      expect(harness.counters.complete).to.equal(3);
      expect(harness.counters.retrieve).to.equal(3);
      expect(harness.counters.apply).to.equal(0);
    });
  });
});
