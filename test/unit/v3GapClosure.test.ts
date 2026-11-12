import { expect } from 'chai';
import type { CommandResult } from '../../src/commands/runner';
import {
  type ChangePlan,
} from '../../src/changes/model';
import {
  type AgentSessionView,
  type AppliedFileOutcome,
  type ApplyOutcomeLike,
  type ApplyReportLike,
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
import type { WorkspaceSummary } from '../../src/workspace/analyze';
import { AGENT_LIMIT_DEFAULTS } from '../../src/agent/limits';

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

function validationPlan(): string {
  return JSON.stringify({
    summary: 'Implement with verification.',
    approach: 'Inspect, implement, verify.',
    tasks: [
      {
        id: 'task-1',
        title: 'Add greeting helper',
        description: 'Create the helper.',
        dependsOn: [],
        suggestedFiles: ['src/greeting.ts'],
        validationCommand: 'npm test',
        criteria: [{ text: 'npm test passes', verification: 'command' }],
      },
    ],
  });
}

function changePlan(adds: readonly Record<string, unknown>[], summary: string): string {
  return JSON.stringify({ summary, changes: adds });
}

const GREETING_CHANGE = changePlan(
  [{ kind: 'create', path: 'src/greeting.ts', summary: 'Create the greeting helper.', content: 'export const greeting = "hello";\n' }],
  'Create the helper.',
);
const REPAIR_CHANGE = changePlan(
  [{ kind: 'modify', path: 'src/greeting.ts', summary: 'Fix the failing expectation.', content: 'export const greeting = "hello, world";\n' }],
  'Fix the expectation.',
);
const BIG_REPAIR = changePlan(
  [{ kind: 'modify', path: 'src/greeting.ts', summary: 'Big fix', content: 'x'.repeat(1_400) }],
  'Big fix.',
);

interface Harness {
  controller: AgentOrchestrator;
  readonly counters: { complete: number; apply: number; runCommand: number };
  planText: string;
  changeTexts: string[];
  repairText: string;
  commandExitCode: number;
}

function createHarness(
  executionLimits?: () => typeof AGENT_LIMIT_DEFAULTS,
  checkpointStore?: CheckpointKeyValueStore,
): Harness {
  const counters = { complete: 0, apply: 0, runCommand: 0 };
  const harness: Harness = {
    counters,
    planText: validationPlan(),
    changeTexts: [GREETING_CHANGE],
    repairText: REPAIR_CHANGE,
    commandExitCode: 0,
    controller: undefined as unknown as AgentOrchestrator,
  };

  const controller = new AgentOrchestrator({
    workspaceRoot: () => ROOT,
    isTrusted: () => true,
    ...(executionLimits !== undefined ? { executionLimits } : {}),
    ...(checkpointStore !== undefined ? { checkpointRepository: new CheckpointRepository(checkpointStore) } : {}),
    agentSettings: () => ({ maxSteps: 20, maxRepairIterations: 2, timeoutMs: 60_000 }),
    commandSettings: () => ({ allowlist: ['npm test', 'npm run compile'], timeoutMs: 10_000, maxOutputChars: 4_000 }),
    inspect: async () => CONTEXT,
    retrieve: async () => ({ summary: SUMMARY, items: [], reasons: {}, skipped: [] } satisfies RetrievalResult),
    complete: async (messages: readonly ChatMessage[]): Promise<CompletionResult> => {
      counters.complete += 1;
      const prompt = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
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
        return { plan, review: [], errors: [], warnings: [] };
      },
      async apply(
        plan: ChangePlan,
        approvedIds: readonly string[],
        _taskId: string,
        _summary: string,
        _applyId?: string,
      ): Promise<ApplyReportLike> {
        counters.apply += 1;
        const outcome: ApplyOutcomeLike = {
          applied: plan.changes
            .filter((change) => approvedIds.includes(change.id))
            .map(
              (change): AppliedFileOutcome => ({
                changeId: change.id,
                kind: change.kind,
                path: change.path,
                ...(change.kind === 'delete' ? { before: 'previous' } : { after: change.content ?? '' }),
                backupName: `backup-${change.id}`,
              }),
            ),
          conflicts: [],
          failed: [],
        };
        return { outcome };
      },
      async undo() {
        return { restored: 0, conflicts: 0 };
      },
    },
    runCommand: async (command: string) => {
      counters.runCommand += 1;
      return {
        command,
        cwd: ROOT,
        exitCode: harness.commandExitCode,
        output: harness.commandExitCode === 0 ? 'ok' : 'fail',
        durationMs: 1,
        timedOut: false,
      } as CommandResult;
    },
  });

  harness.controller = controller;
  return harness;
}

function planRequest(view: AgentSessionView): string {
  const request = view.pendingApproval;
  if (request === undefined || request.kind !== 'plan') {
    throw new Error('not waiting for plan approval');
  }
  return request.id;
}

function changeRequest(view: AgentSessionView): string {
  const request = view.pendingApproval;
  if (request === undefined || request.kind !== 'change-set') {
    throw new Error('not waiting for a change-set approval');
  }
  return request.id;
}

async function startAndApprove(harness: Harness) {
  const started = await harness.controller.start('Add a greeting helper with tests', TOKEN);
  return harness.controller.approvePlan(started.id, TOKEN, planRequest(started));
}

suite('v3.0.0 gap closure ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â Gap 3.2 (honest tool-call accounting)', () => {
  test('the outcome note carries real dispatched and refused counts', async () => {
    const harness = createHarness();
    const planned = await startAndApprove(harness);
    const applied = await harness.controller.approveChanges(planned.id, ['change-1'], TOKEN, changeRequest(planned));

    expect(applied.state).to.equal('validating');
    await harness.controller.requestValidation(applied.id, 'npm test');
    const validated = await harness.controller.approveValidation(
      applied.id,
      harness.controller.pendingApproval(applied.id)?.id ?? '',
      new AbortController().signal,
    );

    expect(validated.state).to.equal('completed');
    const outcomeNote = validated.events
      .filter((event) => event.type === 'note')
      .map((event) => event.message)
      .find((message) => message.startsWith('Outcome:'));

    expect(outcomeNote, 'an Outcome note is always emitted').to.not.equal(undefined);
    expect(outcomeNote).to.contain('completed');
    // apply + runCommand = 2 dispatches, 0 refused.
    expect(outcomeNote).to.contain('2 tool call(s) (0 refused)');
    expect(harness.counters.apply).to.equal(1);
    expect(harness.counters.runCommand).to.equal(1);
  });

  test('a refused command is reported as one refused call, not one dispatch', async () => {
    const harness = createHarness();
    const planned = await startAndApprove(harness);
    const applied = await harness.controller.approveChanges(planned.id, ['change-1'], TOKEN, changeRequest(planned));

    const denied = await harness.controller.requestValidation(applied.id, 'rm -rf /');

    expect(denied.state).to.equal('failed');
    const outcomeNote = denied.events
      .filter((event) => event.type === 'note')
      .map((event) => event.message)
      .find((message) => message.startsWith('Outcome:'));

    expect(outcomeNote, 'an Outcome note is always emitted').to.not.equal(undefined);
    expect(outcomeNote).to.contain('1 refused');
    expect(harness.counters.runCommand).to.equal(0);
  });
});

suite('v3.0.0 gap closure ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â Gap 3.4 (consistent consecutive-failure handling)', () => {
  test('three consecutive validation failures stop the session before a fourth is proposed', async () => {
    const harness = createHarness();
    harness.commandExitCode = 1;
    const planned = await startAndApprove(harness);

    const apply1 = await harness.controller.approveChanges(planned.id, ['change-1'], TOKEN, changeRequest(planned));
    await harness.controller.requestValidation(apply1.id, 'npm test');
    const fail1 = await harness.controller.approveValidation(
      apply1.id,
      harness.controller.pendingApproval(apply1.id)?.id ?? '',
      new AbortController().signal,
    );
    expect(fail1.state).to.equal('diagnosing');

    await harness.controller.generateRepair(apply1.id, TOKEN);
    const requestId1 = harness.controller.pendingApproval(apply1.id)?.id ?? '';
    const repaired1 = await harness.controller.approveRepair(apply1.id, ['change-1'], TOKEN, requestId1);
    expect(repaired1.state).to.equal('validating');
    await harness.controller.requestValidation(repaired1.id, 'npm test');
    const fail2 = await harness.controller.approveValidation(
      repaired1.id,
      harness.controller.pendingApproval(repaired1.id)?.id ?? '',
      new AbortController().signal,
    );
    expect(fail2.state).to.equal('diagnosing');

    // Repair 2 then validation 3 hits the shared budget after 3 consecutive failures.
    await harness.controller.generateRepair(apply1.id, TOKEN);
    const requestId2 = harness.controller.pendingApproval(apply1.id)?.id ?? '';
    const repaired2 = await harness.controller.approveRepair(apply1.id, ['change-1'], TOKEN, requestId2);
    expect(repaired2.state).to.equal('validating');
    await harness.controller.requestValidation(repaired2.id, 'npm test');
    const fail3 = await harness.controller.approveValidation(
      repaired2.id,
      harness.controller.pendingApproval(repaired2.id)?.id ?? '',
      new AbortController().signal,
    );

    expect(fail3.state).to.equal('failed');
    expect(fail3.error ?? '').to.contain('consecutive-failure budget');
    expect(harness.counters.runCommand).to.equal(3);
  });

  test('a passing validation resets the failure sequence', async () => {
    const harness = createHarness();
    const planned = await startAndApprove(harness);
    harness.commandExitCode = 1;

    // First failure.
    const apply1 = await harness.controller.approveChanges(planned.id, ['change-1'], TOKEN, changeRequest(planned));
    await harness.controller.requestValidation(apply1.id, 'npm test');
    await harness.controller.approveValidation(
      apply1.id,
      harness.controller.pendingApproval(apply1.id)?.id ?? '',
      new AbortController().signal,
    );

    // Repair applied, then a passing validation ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â the sequence resets.
    harness.commandExitCode = 0;
    await harness.controller.generateRepair(apply1.id, TOKEN);
    const requestId1 = harness.controller.pendingApproval(apply1.id)?.id ?? '';
    const repaired1 = await harness.controller.approveRepair(apply1.id, ['change-1'], TOKEN, requestId1);

    expect(harness.counters.runCommand).to.equal(1);
    await harness.controller.requestValidation(repaired1.id, 'npm test');
    const validated = await harness.controller.approveValidation(
      repaired1.id,
      harness.controller.pendingApproval(repaired1.id)?.id ?? '',
      new AbortController().signal,
    );

    expect(validated.state).to.equal('completed');
  });
});

suite('v3.0.0 gap closure ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â Gap 3.3 (repair envelope cumulative patch-size protection)', () => {
  test('a repair proposal is refused when the cumulative patch budget is exceeded', async () => {
    const harness = createHarness(
      () => ({ ...AGENT_LIMIT_DEFAULTS, maxChangedFiles: 10, maxPatchSizeChars: 2_000, maxProviderRequests: 999, maxDurationMs: 9_999_999, maxPlanRevisions: 5 }),
    );
    harness.commandExitCode = 1;
    harness.repairText = BIG_REPAIR;

    const planned = await startAndApprove(harness);
    const apply1 = await harness.controller.approveChanges(planned.id, ['change-1'], TOKEN, changeRequest(planned));
    await harness.controller.requestValidation(apply1.id, 'npm test');
    await harness.controller.approveValidation(
      apply1.id,
      harness.controller.pendingApproval(apply1.id)?.id ?? '',
      new AbortController().signal,
    );

    // Repair 1: cumulative bytes = initial (~200) + repair1 (~1400) ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â allowed.
    const repair1 = await harness.controller.generateRepair(apply1.id, TOKEN);
    expect(repair1.state).to.equal('awaiting-repair-approval');
    const requestId1 = harness.controller.pendingApproval(apply1.id)?.id ?? '';
    const repaired1 = await harness.controller.approveRepair(apply1.id, ['change-1'], TOKEN, requestId1);
    expect(repaired1.state).to.equal('validating');

    await harness.controller.requestValidation(repaired1.id, 'npm test');
    await harness.controller.approveValidation(
      repaired1.id,
      harness.controller.pendingApproval(repaired1.id)?.id ?? '',
      new AbortController().signal,
    );

    // Repair 2 then validation 3 hits the shared budget after 3 consecutive failures.
    const repair2 = await harness.controller.generateRepair(apply1.id, TOKEN);

    expect(repair2.state).to.equal('failed');
    expect(repair2.error ?? '').to.contain('cumulative patch budget');
    expect(repair2.pendingApproval).to.equal(undefined);
    expect(repair2.repairProposals).to.have.length(1);
  });
});

