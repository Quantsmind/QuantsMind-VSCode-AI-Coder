import { expect } from 'chai';
import {
  SESSION_SCHEMA_VERSION,
  type AgentSession,
  type AgentTask,
  type DevelopmentPlan,
  type SessionEvent,
} from '../../src/agent/models';
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
    expect(sanitized?.validationRuns[0].evidence.passed).to.equal(false);
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
});
