import { expect } from 'chai';
import {
  SESSION_SCHEMA_VERSION,
  type AgentSession,
  type AgentTask,
  type ApprovalRequest,
  type ChangeSet,
  type DevelopmentPlan,
  type SessionEvent,
} from '../../src/agent/models';
import { changeSetVersion } from '../../src/agent/validation';
import { validateChangeInputs, type ChangePlan } from '../../src/changes/model';
import type { ChangeImpact } from '../../src/repository/impact';
import {
  SESSION_STORAGE_KEY,
  SessionRepository,
  migrateStoredSession,
  sanitizeSession,
  type KeyValueStore,
} from '../../src/sessions/repository';

const AT = '2026-01-01T00:00:00.000Z';

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task-1',
    title: 'Task 1',
    description: '',
    dependsOn: [],
    acceptanceCriteria: [],
    suggestedFiles: [],
    status: 'pending',
    attempts: 0,
    repairAttempts: 0,
    ...overrides,
  };
}

function plan(tasks: readonly AgentTask[]): DevelopmentPlan {
  return {
    id: 'plan-1',
    requirementId: 'req-1',
    summary: 'Plan',
    approach: '',
    tasks,
    risks: [],
    warnings: [],
    createdAt: AT,
  };
}

function changePlan(): ChangePlan {
  const validated = validateChangeInputs([
    { kind: 'create', path: 'src/a.ts', content: 'export const a = 1;\n', summary: 'Create a.' },
    { kind: 'create', path: 'src/b.ts', content: 'export const b = 2;\n', summary: 'Create b.' },
  ]);
  return { id: 'change-plan-1', summary: 'Change', changes: validated.changes };
}

function changeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
  const draft: ChangeSet = {
    id: 'session-1-changeset-1',
    taskId: 'task-1',
    summary: 'Change',
    plan: changePlan(),
    diffs: [],
    warnings: [],
    version: '',
    createdAt: AT,
    status: 'pending',
    ...overrides,
  };
  return { ...draft, version: overrides.version ?? changeSetVersion(draft) };
}

/** Builds a session whose change set may contain values the types forbid. */
function withRawChangeSet(raw: unknown, overrides: Partial<AgentSession> = {}): AgentSession {
  return session({ ...overrides, changeSets: [raw as ChangeSet] });
}

function changeSetRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'approval-1',
    sessionId: 'session-1',
    kind: 'change-set',
    title: 'Change approval',
    detail: '',
    ids: ['change-1', 'change-2'],
    subjectId: 'session-1-changeset-1',
    createdAt: AT,
    ...overrides,
  };
}

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  const tasks = overrides.tasks ?? [task()];
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: 'session-1',
    workspaceRoot: '/workspace/demo',
    requirement: { id: 'req-1', text: 'Do the work', createdAt: AT },
    state: 'awaiting-change-approval',
    needsReview: false,
    createdAt: AT,
    updatedAt: AT,
    providerCalls: 2,
    plan: plan(tasks),
    tasks,
    executions: [],
    changeSets: [],
    approvals: [],
    validationRuns: [],
    diagnostics: [],
    repairProposals: [],
    events: [],
    ...overrides,
  };
}

function memoryStore(): { store: KeyValueStore; raw(): unknown } {
  let stored: unknown;
  return {
    store: {
      get<T>(_key: string): T | undefined {
        return stored as T | undefined;
      },
      update(_key: string, value: unknown): PromiseLike<void> {
        stored = value;
        return Promise.resolve();
      },
    },
    raw: () => stored,
  };
}

suite('agent session repository', () => {
  test('round-trips a valid session through the key-value store', async () => {
    const { store } = memoryStore();
    const repository = new SessionRepository(store, { warn: () => undefined });
    await repository.save(session());

    const loaded = await repository.get('session-1');
    expect(loaded?.state).to.equal('awaiting-change-approval');
    expect(loaded?.plan?.tasks).to.have.length(1);
    expect(loaded?.providerCalls).to.equal(2);
  });

  test('recomputes validation evidence instead of trusting the stored flag', () => {
    const sanitized = sanitizeSession(
      session({
        validationRuns: [
          {
            id: 'run-1',
            taskId: 'task-1',
            command: 'npm test',
            outcome: 'passed',
            startedAt: AT,
            finishedAt: AT,
            evidence: {
              command: 'npm test',
              exitCode: 1,
              passed: true,
              timedOut: false,
              cancelled: false,
              truncated: false,
              durationMs: 5,
              output: 'failure',
            },
          },
        ],
      }),
    );
    expect(sanitized?.validationRuns[0]?.evidence?.passed).to.equal(false);
    expect(sanitized?.validationRuns[0]?.outcome).to.equal('failed');
  });

  test('keeps the change-set binding and the approved command across a restart', () => {
    const version = 'a'.repeat(64);
    const sanitized = sanitizeSession(
      session({
        state: 'validating',
        pendingApproval: {
          id: 'approval-1',
          sessionId: 'session-1',
          kind: 'validation-command',
          title: 'Run "npm test" for "Task 1"',
          detail: 'Command: npm test\nWorking directory: /workspace/demo\nTask: task-1',
          ids: ['npm test', '/workspace/demo', 'task-1'],
          subjectId: 'task-1',
          command: 'npm test',
          cwd: '/workspace/demo',
          createdAt: AT,
        },
        validationRuns: [
          {
            id: 'run-1',
            taskId: 'task-1',
            command: 'npm test',
            outcome: 'passed',
            changeSetId: 'changeset-1',
            changeSetVersion: version,
            startedAt: AT,
            finishedAt: AT,
            evidence: {
              command: 'npm test',
              exitCode: 0,
              passed: true,
              timedOut: false,
              cancelled: false,
              truncated: false,
              durationMs: 5,
              output: 'ok',
            },
          },
        ],
      }),
    );

    expect(sanitized?.pendingApproval?.kind).to.equal('validation-command');
    expect(sanitized?.pendingApproval?.command).to.equal('npm test');
    expect(sanitized?.pendingApproval?.cwd).to.equal('/workspace/demo');
    expect(sanitized?.pendingApproval?.subjectId).to.equal('task-1');
    expect(sanitized?.validationRuns[0]?.changeSetId).to.equal('changeset-1');
    expect(sanitized?.validationRuns[0]?.changeSetVersion).to.equal(version);

    const roundTripped = sanitizeSession(JSON.parse(JSON.stringify(sanitized)));
    expect(roundTripped?.validationRuns[0]?.changeSetVersion).to.equal(version);
  });

  test('drops a malformed binding instead of trusting a clipped one', () => {
    const sanitized = sanitizeSession(
      session({
        state: 'validating',
        pendingApproval: {
          id: 'approval-1',
          sessionId: 'session-1',
          kind: 'validation-command',
          title: 'Run',
          detail: '',
          ids: [],
          subjectId: 'task-1',
          command: 'c'.repeat(201),
          cwd: 'd'.repeat(501),
          createdAt: AT,
        },
        validationRuns: [
          {
            id: 'run-1',
            taskId: 'task-1',
            command: 'npm test',
            outcome: 'passed',
            changeSetId: 'changeset-1',
            changeSetVersion: `${'a'.repeat(64)}-trailing-junk`,
            startedAt: AT,
            finishedAt: AT,
            evidence: {
              command: 'npm test',
              exitCode: 0,
              passed: true,
              timedOut: false,
              cancelled: false,
              truncated: false,
              durationMs: 5,
              output: 'ok',
            },
          },
        ],
      }),
    );

    expect(sanitized?.pendingApproval?.command).to.have.lengthOf(200);
    expect(sanitized?.pendingApproval?.cwd).to.have.lengthOf(500);
    // The result survives, but with no binding it can authorize nothing.
    expect(sanitized?.validationRuns[0]?.outcome).to.equal('passed');
    expect(sanitized?.validationRuns[0]?.changeSetVersion).to.equal(undefined);
  });

  test('demotes a corrupt task graph to paused with review required', () => {
    const sanitized = sanitizeSession(
      session({
        state: 'executing',
        plan: plan([task({ dependsOn: ['missing'] })]),
        tasks: [task({ dependsOn: ['missing'] })],
      }),
    );
    expect(sanitized?.state).to.equal('paused');
    expect(sanitized?.pausedFrom).to.equal('ready');
    expect(sanitized?.needsReview).to.equal(true);
    expect(sanitized?.plan).to.equal(undefined);
  });

  test('ignores unknown future schemas', () => {
    expect(sanitizeSession({ ...session(), schemaVersion: 99 })).to.equal(undefined);
    expect(migrateStoredSession({ schemaVersion: 99, id: 'x' })).to.equal(undefined);
  });

  test('migrates a legacy unversioned session into a paused, reviewable session', () => {
    const migrated = migrateStoredSession({
      id: 'legacy-1',
      prompt: 'Legacy requirement',
      createdAt: AT,
      updatedAt: AT,
      state: 'awaiting-plan-approval',
      rootName: 'demo',
    });
    expect(migrated?.schemaVersion).to.equal(SESSION_SCHEMA_VERSION);
    expect(migrated?.state).to.equal('paused');
    expect(migrated?.pausedFrom).to.equal('ready');
    expect(migrated?.needsReview).to.equal(true);
    expect(migrated?.requirement.text).to.equal('Legacy requirement');
    expect(migrated?.workspaceRoot).to.equal('demo');
  });

  test('caps stored events and rejects an oversized store envelope', async () => {
    const events: SessionEvent[] = Array.from({ length: 650 }, (_, index) => ({
      id: `event-${index}`,
      at: AT,
      type: 'note',
      message: `event ${index}`,
    }));
    const sanitized = sanitizeSession(session({ events }));
    expect(sanitized?.events).to.have.length(500);

    const { store, raw } = memoryStore();
    const repository = new SessionRepository(store, { warn: () => undefined });
    await repository.save(session());
    const envelope = raw() as { schemaVersion: number; sessions: unknown[] };
    expect(envelope.schemaVersion).to.equal(SESSION_SCHEMA_VERSION);
    expect(envelope.sessions).to.have.length(1);
    expect(store.get(SESSION_STORAGE_KEY)).to.deep.equal(envelope);
  });

  test('preserves every valid change-set status', () => {
    const statuses = ['pending', 'approved', 'applied', 'partial', 'rejected', 'failed'] as const;
    for (const status of statuses) {
      const sanitized = sanitizeSession(session({ changeSets: [changeSet({ status })] }));
      expect(sanitized?.changeSets[0]?.status, status).to.equal(status);
    }
  });

  test('round-trips a partial change set and its applied ids through storage', async () => {
    const original = changeSet({ status: 'partial', appliedChangeIds: ['change-1'] });
    const { store } = memoryStore();
    const repository = new SessionRepository(store, { warn: () => undefined });
    await repository.save(session({ changeSets: [original] }));

    const loaded = await repository.get('session-1');
    expect(loaded?.changeSets).to.have.length(1);
    expect(loaded?.changeSets[0]?.status).to.equal('partial');
    expect(loaded?.changeSets[0]?.appliedChangeIds).to.deep.equal(['change-1']);
    expect(loaded?.changeSets[0]?.version).to.equal(original.version);
  });

  test('deduplicates and canonicalizes applied change ids', () => {
    const sanitized = sanitizeSession(
      session({
        changeSets: [
          changeSet({
            status: 'partial',
            appliedChangeIds: ['change-1', 'change-1', 'CHANGE-1', 'change-2'],
          }),
        ],
      }),
    );
    expect(sanitized?.changeSets[0]?.appliedChangeIds).to.deep.equal(['change-1', 'change-2']);
  });

  test('drops unknown and malformed applied change ids without failing the session', () => {
    const sanitized = sanitizeSession(
      withRawChangeSet({
        ...changeSet({ status: 'partial' }),
        appliedChangeIds: ['change-1', 'change-99', 'missing', 42, null, 'change-2'],
      }),
    );

    expect(sanitized).to.not.equal(undefined);
    expect(sanitized?.changeSets[0]?.status).to.equal('partial');
    expect(sanitized?.changeSets[0]?.appliedChangeIds).to.deep.equal([
      'change-1',
      'change-2',
    ]);
  });

  test('loads older records without applied ids or status', () => {
    const legacy: Record<string, unknown> = { ...changeSet() };
    delete legacy.appliedChangeIds;
    delete legacy.status;

    const sanitized = sanitizeSession(withRawChangeSet(legacy));
    expect(sanitized?.changeSets[0]?.status).to.equal('pending');
    expect(sanitized?.changeSets[0]?.appliedChangeIds).to.equal(undefined);
  });

  test('does not demote a partial change set that lacks applied ids', () => {
    const persisted: Record<string, unknown> = { ...changeSet({ status: 'partial' }) };
    delete persisted.appliedChangeIds;

    const sanitized = sanitizeSession(withRawChangeSet(persisted));
    expect(sanitized?.changeSets[0]?.status).to.equal('partial');
  });

  test('preserves a valid change-set approval binding', () => {
    const stored = changeSet({ status: 'partial', appliedChangeIds: ['change-1'] });
    const sanitized = sanitizeSession(
      session({
        changeSets: [stored],
        pendingApproval: changeSetRequest({ changeSetVersion: stored.version }),
      }),
    );

    expect(sanitized?.pendingApproval?.changeSetVersion).to.equal(stored.version);
    expect(sanitized?.changeSets[0]?.status).to.equal('partial');
  });

  test('drops a change-set approval that carries a malformed binding', () => {
    const sanitized = sanitizeSession(
      session({
        changeSets: [changeSet()],
        pendingApproval: changeSetRequest({ changeSetVersion: 'stale-version' }),
      }),
    );

    expect(sanitized?.pendingApproval).to.equal(undefined);
  });

  test('rejects a change set whose stored status is unrecognized', () => {
    const sanitized = sanitizeSession(
      withRawChangeSet({ ...changeSet(), status: 'half-applied' }),
    );
    expect(sanitized).to.not.equal(undefined);
    expect(sanitized?.changeSets).to.have.length(0);
  });

  test('drops malformed impact evidence instead of trusting it', () => {
    const sanitized = sanitizeSession(
      withRawChangeSet({
        ...changeSet(),
        impact: {
          confidence: 'certain',
          directFiles: [
            { path: 'src/a.ts', relationship: 'changed', distance: 0, confidence: 'confirmed', reason: 'ok' },
          ],
          indirectFiles: 'not-an-array',
        },
      }),
    );

    expect(sanitized).to.not.equal(undefined);
    expect(sanitized?.changeSets[0]?.impact).to.equal(undefined);
  });

  test('sanitizes and preserves valid impact evidence', () => {
    const impact = {
      directFiles: [
        {
          path: 'src/a.ts',
          relationship: 'changed',
          distance: 0,
          confidence: 'confirmed',
          reason: 'direct change',
        },
      ],
      indirectFiles: [
        {
          path: 'src/b.ts',
          relationship: 'dependent',
          distance: 1,
          confidence: 'heuristic',
          reason: 'imports src/a.ts',
        },
      ],
      relatedSymbols: [
        { path: 'src/a.ts', name: 'a', kind: 'function', relationship: 'changed', confidence: 'confirmed' },
      ],
      relatedModules: ['src'],
      regressionAreas: [
        {
          path: 'src/a.ts',
          risk: 'medium',
          reason: 'dependency relationship',
          evidence: ['1 direct dependent(s)'],
        },
      ],
      recommendedTests: [
        { path: 'src/a.test.ts', reason: 'name matches', confidence: 'heuristic' },
      ],
      validationCommands: [
        { command: 'npm test', source: 'npm manifest', confidence: 'confirmed' },
      ],
      confidence: 'medium',
      evidence: ['Directly changed: 1 file(s).'],
      generatedAt: AT,
      limits: { maxDepth: 2, maxFiles: 80, truncated: false },
    };
    const sanitized = sanitizeSession(session({ changeSets: [changeSet({ impact: impact as ChangeImpact })] }));

    expect(sanitized?.changeSets[0]?.impact).to.not.equal(undefined);
    expect(sanitized?.changeSets[0]?.impact?.confidence).to.equal('medium');
    expect(sanitized?.changeSets[0]?.impact?.indirectFiles).to.have.length(1);
    expect(sanitized?.changeSets[0]?.impact?.recommendedTests[0]?.path).to.equal('src/a.test.ts');
  });

  test('impact evidence does not change the change-set version', () => {
    const impact = {
      directFiles: [],
      indirectFiles: [],
      relatedSymbols: [],
      relatedModules: [],
      regressionAreas: [],
      recommendedTests: [],
      validationCommands: [],
      confidence: 'low',
      evidence: [],
      generatedAt: AT,
      limits: { maxDepth: 2, maxFiles: 80, truncated: false },
    };
    const withImpact = sanitizeSession(session({ changeSets: [changeSet({ impact: impact as ChangeImpact })] }));
    const without = sanitizeSession(session({ changeSets: [changeSet()] }));
    expect(withImpact?.changeSets[0]?.version).to.equal(without?.changeSets[0]?.version);
  });

  test('round-trips two independent task executions', async () => {
    const { store } = memoryStore();
    const repository = new SessionRepository(store, { warn: () => undefined });

    const first = {
      tasks: [task({ id: 'task-1' }), task({ id: 'task-2' })],
      executions: [
        {
          taskId: 'task-1',
          status: 'completed' as const,
          attempts: 2,
          startedAt: AT,
          finishedAt: AT,
          changeSetId: 'changeset-1',
          validationRunId: 'validation-1',
          historyTaskId: 'history-1',
          repairProposalId: 'repair-1',
          appliedFiles: [{ path: 'src/a.ts', hash: 'a'.repeat(64), kind: 'modify' as const }],
          error: undefined,
        },
        {
          taskId: 'task-2',
          status: 'failed' as const,
          attempts: 3,
          startedAt: AT,
          finishedAt: AT,
          changeSetId: 'changeset-2',
          validationRunId: 'validation-2',
          historyTaskId: 'history-2',
          repairProposalId: 'repair-2',
          appliedFiles: [{ path: 'src/b.ts', hash: 'b'.repeat(64), kind: 'create' as const }],
          error: 'boom',
        },
      ],
    };

    await repository.save(session(first));

    const loaded = await repository.get('session-1');
    expect(loaded?.executions.map((entry) => entry.taskId).sort()).to.deep.equal(['task-1', 'task-2']);
    const task1 = loaded?.executions.find((entry) => entry.taskId === 'task-1');
    const task2 = loaded?.executions.find((entry) => entry.taskId === 'task-2');
    expect(task1?.status).to.equal('completed');
    expect(task1?.attempts).to.equal(2);
    expect(task1?.startedAt).to.equal(AT);
    expect(task1?.finishedAt).to.equal(AT);
    expect(task1?.changeSetId).to.equal('changeset-1');
    expect(task1?.validationRunId).to.equal('validation-1');
    expect(task1?.historyTaskId).to.equal('history-1');
    expect(task1?.repairProposalId).to.equal('repair-1');
    expect(task1?.appliedFiles).to.deep.equal([{ path: 'src/a.ts', hash: 'a'.repeat(64), kind: 'modify' }]);
    expect(task1?.error).to.equal(undefined);
    expect(task2?.status).to.equal('failed');
    expect(task2?.attempts).to.equal(3);
    expect(task2?.startedAt).to.equal(AT);
    expect(task2?.finishedAt).to.equal(AT);
    expect(task2?.changeSetId).to.equal('changeset-2');
    expect(task2?.validationRunId).to.equal('validation-2');
    expect(task2?.historyTaskId).to.equal('history-2');
    expect(task2?.repairProposalId).to.equal('repair-2');
    expect(task2?.appliedFiles).to.deep.equal([{ path: 'src/b.ts', hash: 'b'.repeat(64), kind: 'create' }]);
    expect(task2?.error).to.equal('boom');
  });

  test('sanitizes executions that reference unknown tasks', () => {
    const raw = session({
      tasks: [task({ id: 'task-1' })],
      executions: [
        { taskId: 'task-1', status: 'completed' as const, attempts: 1, appliedFiles: [] },
        { taskId: 'unknown-task', status: 'running' as const, attempts: 1, appliedFiles: [] },
      ] as unknown as AgentSession['executions'],
    });

    const sanitized = sanitizeSession(raw);
    expect(sanitized?.executions.map((entry) => entry.taskId)).to.deep.equal(['task-1']);
  });
});
