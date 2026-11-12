import { expect } from 'chai';
import type { CommandResult } from '../../src/commands/runner';
import { hashContent, type ChangePlan } from '../../src/changes/model';
import {
  SessionRepository,
  type KeyValueStore,
} from '../../src/sessions/repository';
import {
  SESSION_SCHEMA_VERSION,
  type AgentSession,
  type AgentSessionView,
  type AgentTask,
  type PreparedChangeSet,
  type ProjectContext,
  type RetrievalResult,
} from '../../src/agent/models';
import { AgentOrchestrator } from '../../src/agent/orchestrator';
import type { CancellationTokenLike, CompletionResult } from '../../src/providers/types';
import type { WorkspaceSummary } from '../../src/workspace/analyze';

/**
 * Continuation/recovery behaviour for persisted agent sessions.
 * Every collaborator is injected; the suite exercises the real restore path:
 * state marking, verification of applied files, continuation notes, and
 * user-approved resume after restore.
 */

const ROOT = '/virtual/root';
const NOW = '2026-11-11T00:00:00.000Z';

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
  fileCount: 1,
  technologies: [],
  topLevel: [],
  entryPoints: [],
  testFiles: 1,
  text: 'Workspace demo: 1 indexed file.',
};

class MemoryKeyValueStore implements KeyValueStore {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

interface HarnessOptions {
  readonly repository: SessionRepository;
  readonly hashFile?: (path: string) => Promise<string | undefined>;
}

interface Harness {
  readonly controller: AgentOrchestrator;
}

function makeRepository(): SessionRepository {
  const memory = new MemoryKeyValueStore();
  return new SessionRepository(memory);
}

function storedTask(patch: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task-1',
    title: 'Add greeting helper',
    description: 'Add a greeting helper with a single focused change.',
    dependsOn: [],
    acceptanceCriteria: [],
    suggestedFiles: ['src/greeting.ts'],
    status: 'pending',
    attempts: 0,
    repairAttempts: 0,
    ...patch,
  };
}

function storedSession(tasks: AgentTask[], patch: Partial<AgentSession> = {}): AgentSession {
  const base = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: patch.id ?? 'session-stored',
    workspaceRoot: ROOT,
    requirement: {
      id: 'req-stored',
      text: 'Add a greeting helper',
      createdAt: NOW,
    },
    state: 'executing' as const,
    needsReview: false,
    createdAt: NOW,
    updatedAt: NOW,
    providerCalls: 1,
    plan: {
      id: 'plan-stored',
      requirementId: 'req-stored',
      summary: 'Add a greeting helper.',
      approach: 'Implement and test.',
      tasks,
      risks: [],
      warnings: [],
      createdAt: NOW,
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
  return base as unknown as AgentSession;
}

function createHarness(options: HarnessOptions): Harness {
  const controller = new AgentOrchestrator({
    workspaceRoot: () => ROOT,
    isTrusted: () => true,
    repository: options.repository,
    hashFile: options.hashFile,
    logger: { info: () => undefined, warn: () => undefined },
    agentSettings: () => ({ maxSteps: 20, maxRepairIterations: 2, timeoutMs: 60_000 }),
    commandSettings: () => ({
      allowlist: ['npm test'],
      timeoutMs: 10_000,
      maxOutputChars: 4_000,
    }),
    inspect: async (): Promise<ProjectContext> => CONTEXT,
    retrieve: async (): Promise<RetrievalResult> => ({
      summary: SUMMARY,
      items: [],
      reasons: {},
      skipped: [],
    }),
    complete: async (): Promise<CompletionResult> => ({ text: '{"tool_calls": []}' }),
    changes: {
      async prepare(plan: ChangePlan): Promise<PreparedChangeSet> {
        return { plan, review: [], errors: [], warnings: [] };
      },
      async apply() {
        return { outcome: { applied: [], conflicts: [], failed: [] } };
      },
      async undo() {
        return { restored: 0, conflicts: 0 };
      },
    },
    runCommand: async (command: string, _signal: AbortSignal): Promise<CommandResult> => ({
      command,
      cwd: ROOT,
      exitCode: 0,
      output: 'ok',
      timedOut: false,
      cancelled: false,
      truncated: false,
      durationMs: 1,
    }),
  } as never);

  return { controller };
}

const notesOf = (view: AgentSessionView | undefined): readonly string[] =>
  (view?.events ?? []).filter((event) => event.type === 'note').map((event) => event.message);

suite('session continuation and recovery', () => {
  test('restores an executing session: running tasks are marked interrupted, a continuation note is emitted', async () => {
    const completed = storedTask({ id: 'task-1', status: 'completed' });
    const running = storedTask({ id: 'task-2', status: 'running', dependsOn: ['task-1'] });
    const pending = storedTask({ id: 'task-3', status: 'pending', dependsOn: ['task-2'] });
    const seed = storedSession([completed, running, pending]);
    const repository = makeRepository();
    // Seed through the repository's own envelope path.
    const stored = await repository.get('session-stored');
    expect(stored).to.equal(undefined); // sanity: not readable before save()
    await repository.save(seed);
    const harness = createHarness({ repository, hashFile: async () => hashContent('content') });

    const view = await harness.controller.restore('session-stored');

    expect(view).to.not.equal(undefined);
    const tasks = new Map(view?.tasks.map((task) => [task.id, task.status]) ?? []);
    expect(tasks.get('task-1')).to.equal('completed');
    expect(tasks.get('task-2')).to.equal('failed');
    expect(view?.tasks.find((task) => task.id === 'task-2')?.error).to.contain('Interrupted');
    expect(tasks.get('task-3')).to.equal('pending');

    const notes = notesOf(view);
    expect(notes.some((note) => note.includes('Continuation plan') && note.includes('resumable'))).to.equal(true);
    expect(view?.state).to.equal('paused');
  });

  test('fails restore with an actionable error when an applied file changed on disk', async () => {
    const appliedHash = hashContent('applied content');
    const task = storedTask({ id: 'task-1', status: 'completed' });
    const seed = storedSession([task], {
      executions: [
        {
          taskId: 'task-1',
          status: 'completed',
          attempts: 1,
          startedAt: NOW,
          finishedAt: NOW,
          appliedFiles: [{ path: 'src/greeting.ts', hash: appliedHash, kind: 'modify' }],
        },
      ],
    });
    const repository = makeRepository();
    await repository.save(seed);
    const harness = createHarness({
      repository,
      hashFile: async (path) => (path === 'src/greeting.ts' ? hashContent('user changed this') : appliedHash),
    });

    const view = await harness.controller.restore('session-stored');

    expect(view?.state).to.equal('failed');
    expect(view?.needsReview).to.equal(true);
    expect(view?.error).to.contain('src/greeting.ts');
    expect(view?.error).to.contain('changed');
  });

  test('restores a cancelling session to cancelled with needsReview', async () => {
    const seed = storedSession([storedTask({ id: 'task-1', status: 'running' })], { state: 'cancelling' });
    const repository = makeRepository();
    await repository.save(seed);
    const harness = createHarness({ repository });

    const view = await harness.controller.restore('session-stored');

    expect(view?.state).to.equal('cancelled');
    expect(view?.needsReview).to.equal(true);
  });

  test('a user-approved resume re-enters the scheduler without re-running completed work', async () => {
    const completed = storedTask({ id: 'task-1', status: 'completed' });
    const pending = storedTask({ id: 'task-2', status: 'pending', dependsOn: ['task-1'] });
    const seed = storedSession([completed, pending]);
    const repository = makeRepository();
    await repository.save(seed);
    const harness = createHarness({ repository, hashFile: async () => hashContent('x') });

    const restored = await harness.controller.restore('session-stored');

    expect(restored?.state).to.equal('paused');
    expect(restored?.needsReview).to.equal(false);

    const resumed = await harness.controller.resume('session-stored', TOKEN);

    const taskStatuses = new Map(resumed.tasks.map((task) => [task.id, task.status]));
    expect(taskStatuses.get('task-1')).to.equal('completed');
  });

  test('restore is idempotent for already-interrupted tasks', async () => {
    const running = storedTask({ id: 'task-1', status: 'running' });
    const seed = storedSession([running]);
    const repository = makeRepository();
    await repository.save(seed);
    const harness = createHarness({ repository, hashFile: async () => hashContent('x') });

    const first = await harness.controller.restore('session-stored');
    const second = await harness.controller.restore('session-stored');

    expect(first?.tasks[0]?.status).to.equal('failed');
    expect(second?.tasks[0]?.status).to.equal('failed');
    expect(second?.tasks[0]?.error).to.contain('Interrupted');
  });
});
