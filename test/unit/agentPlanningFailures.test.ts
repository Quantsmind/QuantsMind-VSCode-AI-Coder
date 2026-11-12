import { expect } from 'chai';
import type { CommandResult } from '../../src/commands/runner';
import { type ChangePlan } from '../../src/changes/model';
import {
  type AgentSession,
  type AgentSessionView,
  type ProjectContext,
  type RetrievalResult,
} from '../../src/agent/models';
import { AgentOrchestrator } from '../../src/agent/orchestrator';
import {
  parseDevelopmentPlan,
  type ParseDevelopmentPlanOptions,
} from '../../src/agent/planning';
import type { CancellationTokenLike, ChatMessage, CompletionResult } from '../../src/providers/types';
import {
  CHECKPOINT_STORAGE_KEY,
  CheckpointRepository,
  type CheckpointKeyValueStore,
} from '../../src/sessions/checkpointRepository';
import type { ISessionRepository } from '../../src/sessions/repository';
import type { WorkspaceSummary } from '../../src/workspace/analyze';

/**
 * v3.1.0 regression coverage for the Agent planning failure path.
 *
 * Root causes covered:
 * - A short workspace-inspection request previously produced no plan because the
 *   parser had no read-only outcome shape: providers answered without a `tasks`
 *   array and the session failed with "The development plan did not include a
 *   tasks array."
 * - A failed planning operation was followed by a checkpoint-save warning,
 *   because failSession persisted an execution checkpoint with an empty planId.
 * - Truncation (finishReason=length) was reported as invalid JSON instead of
 *   as the provider-side output limit it is.
 */

const TOKEN: CancellationTokenLike = {
  isCancellationRequested: false,
  onCancellationRequested() {
    return { dispose() {} };
  },
};

const OPTIONS: ParseDevelopmentPlanOptions = {
  requirementId: 'req-1',
  planId: 'plan-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  allowlist: ['npm test', 'npm run compile'],
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
  summaryText: 'Workspace demo uses npm.',
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

suite('planning response validation (v3.1.0)', () => {
  const VALID_IMPLEMENTATION = JSON.stringify({
    kind: 'implementation',
    summary: 'Add a greeting helper',
    approach: 'Create one module with one exported constant.',
    tasks: [
      {
        id: 'task-1',
        title: 'Add greeting helper',
        description: 'Create the helper module.',
        dependsOn: [],
        suggestedFiles: ['src/greeting.ts'],
        criteria: [{ text: 'module exported', verification: 'review' }],
      },
    ],
  });

  test('classifies empty output as empty, not as a session failure', () => {
    const parsed = parseDevelopmentPlan('', OPTIONS);
    expect(parsed.category).to.equal('empty');
    expect(parsed.plan).to.equal(undefined);
  });

  test('classifies output with no JSON object as no-json', () => {
    const parsed = parseDevelopmentPlan('I cannot help with that.', OPTIONS);
    expect(parsed.category).to.equal('no-json');
    expect(parsed.errors[0]).to.contain('did not contain a JSON development plan');
  });

  test('classifies malformed JSON as invalid-json', () => {
    const parsed = parseDevelopmentPlan('{"summary":"x", "approach": ?}', OPTIONS);
    expect(parsed.category).to.equal('invalid-json');
  });

  test('classifies a missing tasks array as missing-tasks', () => {
    const parsed = parseDevelopmentPlan('{"summary":"x","approach":"y"}', OPTIONS);
    expect(parsed.category).to.equal('missing-tasks');
    expect(parsed.errors[0]).to.contain('tasks array');
  });

  test('rejects a truncated response even when the partial output parses as JSON', () => {
    const parsed = parseDevelopmentPlan(VALID_IMPLEMENTATION, {
      ...OPTIONS,
      finishReason: 'length',
    });
    expect(parsed.category).to.equal('truncated');
    expect(parsed.plan).to.equal(undefined);
    expect(parsed.errors[0]).to.contain('output token limit');
  });

  test('rejects a truncated response with an incomplete JSON plan', () => {
    const parsed = parseDevelopmentPlan('{"summary":"x", "tasks":[{"id":"task-1"', {
      ...OPTIONS,
      finishReason: 'length',
    });
    expect(parsed.category).to.equal('truncated');
    expect(parsed.plan).to.equal(undefined);
  });

  test('accepts a stop-finished response with the same content', () => {
    const parsed = parseDevelopmentPlan(VALID_IMPLEMENTATION, {
      ...OPTIONS,
      finishReason: 'stop',
    });
    expect(parsed.category).to.equal(undefined);
    expect(parsed.plan?.kind).to.equal('implementation');
  });

  test('parses an inspection plan with findings and no tasks', () => {
    const parsed = parseDevelopmentPlan(
      JSON.stringify({
        kind: 'inspection',
        summary: 'The workspace is a VS Code extension that builds as tsc output.',
        findings: [
          'src/agent/orchestrator.ts owns plan approval and task scheduling.',
          'test/unit/agentOrchestrator.test.ts covers the approval flow.',
        ],
        relevantFiles: ['src/agent/orchestrator.ts', './src/agent/planning.ts'],
      }),
      OPTIONS,
    );
    expect(parsed.errors).to.deep.equal([]);
    expect(parsed.plan?.kind).to.equal('inspection');
    expect(parsed.plan?.tasks).to.deep.equal([]);
    expect(parsed.plan?.findings).to.have.length(2);
    expect(parsed.plan?.relevantFiles).to.deep.equal([
      'src/agent/orchestrator.ts',
      'src/agent/planning.ts',
    ]);
  });

  test('rejects an inspection plan without meaningful findings', () => {
    const parsed = parseDevelopmentPlan(
      JSON.stringify({ kind: 'inspection', summary: 'I looked.', findings: [] }),
      OPTIONS,
    );
    expect(parsed.category).to.equal('missing-findings');
    expect(parsed.plan).to.equal(undefined);
  });

  test('drops unsafe relevantFiles in an inspection plan and keeps the safe ones', () => {
    const parsed = parseDevelopmentPlan(
      JSON.stringify({
        kind: 'inspection',
        summary: 'Inspected configuration.',
        findings: ['the tsconfig targets a single out directory'],
        relevantFiles: ['../outside.ts', '/etc/passwd', 'src/agent/planning.ts'],
      }),
      OPTIONS,
    );
    expect(parsed.plan?.relevantFiles).to.deep.equal(['src/agent/planning.ts']);
    expect(parsed.plan?.warnings.join(' ')).to.contain('unsafe path');
  });

  test('discards embedded tasks in an inspection plan rather than executing them', () => {
    const parsed = parseDevelopmentPlan(
      JSON.stringify({
        kind: 'inspection',
        summary: 'Inspected the module.',
        findings: ['scheduler owns dependency evaluation'],
        tasks: [{ id: 'task-1', title: 'Refactor everything' }],
      }),
      OPTIONS,
    );
    expect(parsed.plan?.tasks).to.deep.equal([]);
    expect(parsed.plan?.warnings.join(' ')).to.contain('tasks were discarded');
  });
});

class CountingCheckpointStore implements CheckpointKeyValueStore {
  private readonly values = new Map<string, unknown>();
  updates = 0;

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.updates += 1;
    this.values.set(key, value);
  }

  savedCheckpoints(): readonly { planId: string }[] {
    const envelope = this.values.get(CHECKPOINT_STORAGE_KEY) as
      | { checkpoints?: { planId: string }[] }
      | undefined;
    return envelope?.checkpoints ?? [];
  }
}

interface HarnessOptions {
  readonly planResponse?: () => CompletionResult | Promise<CompletionResult>;
  readonly onRecord?: (view: AgentSessionView) => void;
}

interface Harness {
  readonly controller: AgentOrchestrator;
  readonly counters: {
    inspect: number;
    retrieve: number;
    complete: number;
    apply: number;
    runCommand: number;
  };
  readonly store: CountingCheckpointStore;
  readonly warnings: readonly string[];
  readonly savedSessions: AgentSession[];
}

const INSPECTION_PLAN = JSON.stringify({
  kind: 'inspection',
  summary: 'The extension activates on a view; the provider adapter lives in src/providers.',
  findings: [
    'src/providers/openaiCompatible.ts implements the OpenAI-compatible adapter.',
    'src/agent/orchestrator.ts owns plan approval and task scheduling.',
  ],
  relevantFiles: ['src/providers/openaiCompatible.ts', 'src/agent/orchestrator.ts'],
  risks: ['provider behavior could not be exercised without a live endpoint'],
});

const TRUNCATED_PLAN = JSON.stringify({
  kind: 'implementation',
  summary: 'Add a greeting helper',
  approach: 'One module.',
  tasks: [{ id: 'task-1', title: 'Add greeting helper' }],
});

function createHarness(options: HarnessOptions = {}): Harness {
  const counters = { inspect: 0, retrieve: 0, complete: 0, apply: 0, runCommand: 0 };
  const warnings: string[] = [];
  const savedSessions: AgentSession[] = [];
  const store = new CountingCheckpointStore();
  const repository: ISessionRepository = {
    load: async () => [],
    get: async () => undefined,
    save: async (session: AgentSession) => {
      savedSessions.push(session);
    },
    remove: async () => undefined,
  };

  const controller = new AgentOrchestrator({
    workspaceRoot: () => '/virtual/root',
    isTrusted: () => true,
    checkpointRepository: new CheckpointRepository(store),
    repository,
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
    complete: async (_messages: readonly ChatMessage[]): Promise<CompletionResult> => {
      counters.complete += 1;
      if (options.planResponse !== undefined) {
        return options.planResponse();
      }
      return { text: 'no plan', finishReason: 'stop' };
    },
    changes: {
      async prepare(plan: ChangePlan, _taskId: string) {
        return { plan, review: [], errors: [], warnings: [] };
      },
      async apply(): Promise<never> {
        counters.apply += 1;
        throw new Error('apply must never be reached in planning-failure tests');
      },
      async undo(): Promise<{ restored: number; conflicts: number }> {
        return { restored: 0, conflicts: 0 };
      },
    },
    runCommand: async (command: string): Promise<CommandResult> => {
      counters.runCommand += 1;
      return {
        command,
        cwd: '/virtual/root',
        exitCode: 0,
        output: '',
        timedOut: false,
        cancelled: false,
        truncated: false,
        durationMs: 1,
      };
    },
  });

  return { controller, counters, store, warnings, savedSessions };
}

function planSnapshot(store: CountingCheckpointStore): readonly { planId: string }[] {
  return store.savedCheckpoints();
}

suite('agent planning failure lifecycle (v3.1.0)', () => {
  test('planning failure persists the failed session and never persists a checkpoint', async () => {
    const harness = createHarness({
      planResponse: () => ({ text: 'I cannot help with that.', finishReason: 'stop' }),
    });
    const view = await harness.controller.start('Inspect the workspace', TOKEN);

    expect(view.state).to.equal('failed');
    expect(view.error).to.contain('did not contain a JSON development plan');
    expect(harness.store.updates).to.equal(0);
    expect(planSnapshot(harness.store)).to.have.length(0);
    expect(
      harness.warnings.some((warning) => warning.includes('agent plan validation failed')),
    ).to.equal(true);

    const failed = harness.savedSessions.filter((session) => session.state === 'failed').pop();
    expect(failed?.state).to.equal('failed');
    expect(failed?.error).to.contain('did not contain a JSON development plan');
    expect(failed?.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).to.equal(true);
    expect(failed?.events.some((event) => event.type === 'diagnostic')).to.equal(true);
  });

  test('truncated plan reports the output limit, not invalid JSON, and writes no checkpoint', async () => {
    const harness = createHarness({
      planResponse: () => ({ text: TRUNCATED_PLAN, finishReason: 'length' }),
    });
    const view = await harness.controller.start('Add a greeting helper', TOKEN);

    expect(view.state).to.equal('failed');
    expect(view.error).to.contain('output token limit');
    expect(view.error).not.to.contain('invalid JSON');
    expect(harness.store.updates).to.equal(0);
  });

  test('logger records the failure category and finish reason for diagnostics', async () => {
    const harness = createHarness({
      planResponse: () => ({ text: '{"summary":"x"', finishReason: 'length' }),
    });
    await harness.controller.start('Add a greeting helper', TOKEN);

    expect(
      harness.warnings.some(
        (warning) => warning.includes('category=truncated') && warning.includes('finishReason=length'),
      ),
    ).to.equal(true);
  });

  test('a valid implementation plan persists a checkpoint only after approval, with the real plan id', async () => {
    const harness = createHarness({
      planResponse: () => ({
        text: JSON.stringify({
          kind: 'implementation',
          summary: 'Documentation pass',
          approach: 'Nothing to build; record the outcome.',
          tasks: [],
        }),
        finishReason: 'stop',
      }),
    });
    const started = await harness.controller.start('Record the chosen approach', TOKEN);
    expect(started.state).to.equal('awaiting-plan-approval');
    expect(harness.store.updates).to.equal(0);

    const requestId = started.pendingApproval?.id;
    expect(requestId).to.be.a('string');
    const approved = await harness.controller.approvePlan(started.id, TOKEN, requestId!);
    expect(harness.store.updates).to.equal(1);
    const [saved] = planSnapshot(harness.store);
    expect(saved?.planId).to.equal(started.plan?.id);
    expect(saved?.planId).not.to.equal('');
    expect(approved.state).to.equal('completed');
    expect(harness.counters.runCommand).to.equal(0);
    expect(harness.counters.apply).to.equal(0);
  });

  test('inspection plan: approval completes the session without executing anything', async () => {
    const harness = createHarness({
      planResponse: () => ({ text: INSPECTION_PLAN, finishReason: 'stop' }),
    });
    const started = await harness.controller.start('Inspect the workspace layout', TOKEN);

    expect(started.state).to.equal('awaiting-plan-approval');
    expect(started.plan?.kind).to.equal('inspection');
    expect(started.plan?.tasks).to.deep.equal([]);
    expect(started.plan?.findings?.length).to.equal(2);
    const request = started.pendingApproval;
    expect(request?.kind).to.equal('plan');
    expect(request?.title).to.contain('Inspection (read-only) approval');
    expect(typeof request?.subjectId).to.equal('string');

    const approved = await harness.controller.approvePlan(started.id, TOKEN, request!.id);
    expect(approved.state).to.equal('completed');
    expect(approved.tasks).to.deep.equal([]);
    expect(approved.executions).to.deep.equal([]);
    expect(harness.counters.apply).to.equal(0);
    expect(harness.counters.runCommand).to.equal(0);
    expect(harness.store.updates).to.equal(1); // checkpoint under the real plan id, after approval only
    const [saved] = planSnapshot(harness.store);
    expect(saved?.planId).to.equal(approved.plan?.id);
    expect(saved?.planId).not.to.equal('');
    expect(approved.report?.outcome).to.equal('completed');
    expect(
      approved.events.some(
        (event) => event.type === 'note' && event.message.includes('finding'),
      ),
    ).to.equal(true);
  });

  test('inspection plan rejection finishes as rejected with no execution', async () => {
    const harness = createHarness({
      planResponse: () => ({ text: INSPECTION_PLAN, finishReason: 'stop' }),
    });
    const started = await harness.controller.start('Inspect the workspace layout', TOKEN);
    const rejected = await harness.controller.rejectPlan(started.id, started.pendingApproval!.id);

    expect(rejected.state).to.equal('rejected');
    expect(rejected.tasks).to.deep.equal([]);
    expect(harness.counters.apply).to.equal(0);
    expect(harness.counters.runCommand).to.equal(0);
  });

  test('an inspection plan never schedules an execution task', async () => {
    const harness = createHarness({
      planResponse: () => ({ text: INSPECTION_PLAN, finishReason: 'stop' }),
    });
    const started = await harness.controller.start('Inspect the workspace layout', TOKEN);
    const approved = await harness.controller.approvePlan(
      started.id,
      TOKEN,
      started.pendingApproval!.id,
    );

    expect(approved.state).to.equal('completed');
    expect(approved.providerCalls).to.equal(1); // no change-plan request was issued
  });
});
