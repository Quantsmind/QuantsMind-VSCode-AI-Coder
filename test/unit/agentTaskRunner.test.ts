import { expect } from 'chai';
import { AgentTaskRunner, type AgentTaskView } from '../../src/agent/taskRunner';
import type { HistoryEntry } from '../../src/changes/history';
import type { ApplyReport, ChangeService, PreparedPlan } from '../../src/changes/changeService';
import type { UndoOutcome } from '../../src/changes/apply';
import type { ChangePlan } from '../../src/changes/model';
import type { ReviewChange } from '../../src/changes/review';
import type { CommandResult } from '../../src/commands/runner';
import { resolveAgentSettings, type ResolvedAgentSettings } from '../../src/config/resolve';
import type { CancellationTokenLike } from '../../src/providers/types';
import type { WorkspaceSummary } from '../../src/workspace/analyze';
import { TestCancellationToken } from './helpers';

const SUMMARY: WorkspaceSummary = {
  rootName: 'demo',
  fileCount: 1,
  technologies: [],
  topLevel: [],
  entryPoints: [],
  testFiles: 0,
  text: 'Workspace demo: 1 indexed file.',
};

function planText(changes: readonly Record<string, unknown>[] = [
  { kind: 'create', path: 'src/a.ts', content: 'export const a = 1;\n' },
]): string {
  return JSON.stringify({ summary: 'Add a file', notes: 'Check tests.', changes });
}

function reviewOf(plan: ChangePlan): ReviewChange[] {
  return plan.changes.map((change) => ({
    id: change.id,
    kind: change.kind,
    path: change.path,
    fromPath: change.fromPath,
    summary: change.summary,
    diff: `--- a/${change.path}\n+++ b/${change.path}`,
    additions: 1,
    deletions: 0,
    diffTruncated: false,
  }));
}

interface HarnessOptions {
  readonly responses?: readonly string[];
  readonly complete?: (token: CancellationTokenLike) => Promise<string>;
  readonly retrieve?: (
    query: string,
    token: CancellationTokenLike,
  ) => Promise<{
    summary: WorkspaceSummary;
    items: [];
    reasons: Record<string, string>;
    skipped: { path: string; reason: string }[];
  }>;
  readonly prepareError?: string;
  readonly applyEmpty?: boolean;
  readonly undoOutcome?: UndoOutcome | undefined;
  readonly commandResult?: Partial<CommandResult>;
  readonly agentSettings?: Partial<ResolvedAgentSettings>;
}

interface Harness {
  readonly runner: AgentTaskRunner;
  readonly token: TestCancellationToken;
  readonly events: AgentTaskView[];
  readonly calls: {
    readonly complete: number;
    readonly prepare: ChangePlan[];
    readonly apply: { plan: ChangePlan; approvedIds: readonly string[]; taskId: string }[];
    readonly undo: string[];
    readonly commands: string[];
  };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const token = new TestCancellationToken();
  const events: AgentTaskView[] = [];
  const responses = [...(options.responses ?? [planText()])];
  const calls = {
    complete: 0,
    prepare: [] as ChangePlan[],
    apply: [] as { plan: ChangePlan; approvedIds: readonly string[]; taskId: string }[],
    undo: [] as string[],
    commands: [] as string[],
  };

  const agentSettings: ResolvedAgentSettings = {
    ...resolveAgentSettings({}),
    ...options.agentSettings,
  };

  const changes = {
    prepare: async (plan: ChangePlan): Promise<PreparedPlan> => {
      calls.prepare.push(plan);
      return {
        plan,
        beforeByPath: new Map(),
        review: reviewOf(plan),
        errors: options.prepareError !== undefined ? [options.prepareError] : [],
        warnings: ['a warning'],
      };
    },
    apply: async (
      plan: ChangePlan,
      approvedIds: readonly string[],
      taskId: string,
    ): Promise<ApplyReport> => {
      calls.apply.push({ plan, approvedIds, taskId });
      const applied = options.applyEmpty === true
        ? []
        : plan.changes
            .filter((change) => approvedIds.includes(change.id))
            .map((change) => ({
              changeId: change.id,
              kind: change.kind,
              path: change.path,
              fromPath: change.fromPath,
              before: undefined,
              after: change.content,
              backupName: `${change.id}.json`,
            }));
      const results = plan.changes.map((change) => ({
        changeId: change.id,
        path: change.path,
        kind: change.kind,
        status: approvedIds.includes(change.id) ? ('applied' as const) : ('skipped' as const),
      }));
      const entry: HistoryEntry = {
        applyId: taskId,
        taskId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        summary: plan.summary,
        status: applied.length > 0 ? 'applied' : 'rejected',
        files: [],
        undoable: applied.length > 0,
      };
      return {
        outcome: { results, applied, conflicts: [], failed: [] },
        entry,
      };
    },
    undo: async (taskId: string): Promise<UndoOutcome | undefined> => {
      calls.undo.push(taskId);
      return options.undoOutcome;
    },
  } as unknown as ChangeService;

  const commandResult: CommandResult = {
    command: 'npm run test:unit',
    cwd: '/workspace',
    exitCode: 0,
    output: 'all good',
    timedOut: false,
    cancelled: false,
    truncated: false,
    durationMs: 12,
    ...options.commandResult,
  };

  const runner = new AgentTaskRunner({
    complete: async (_messages, completionToken) => {
      calls.complete += 1;
      const text = options.complete !== undefined
        ? await options.complete(completionToken)
        : responses.shift() ?? '{}';
      return { text };
    },
    retrieve: async (_query, retrievalToken) => {
      if (options.retrieve !== undefined) {
        return options.retrieve(_query, retrievalToken);
      }
      return { summary: SUMMARY, items: [], reasons: {}, skipped: [] };
    },
    changes,
    runCommand: async (command) => {
      calls.commands.push(command);
      return { ...commandResult, command };
    },
    agentSettings: () => agentSettings,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    onChange: (task) => {
      events.push(task);
    },
  });

  return { runner, token, events, calls };
}

suite('agent task runner', () => {
  test('plans changes and stops for explicit approval without applying', async () => {
    const harness = createHarness();
    const task = await harness.runner.start('add a file', harness.token);

    expect(task.status).to.equal('awaiting-approval');
    expect(task.providerCalls).to.equal(1);
    expect(task.planSummary).to.equal('Add a file');
    expect(task.planNotes).to.equal('Check tests.');
    expect(task.review).to.have.length(1);
    expect(task.review[0].diff).to.contain('src/a.ts');
    expect(harness.calls.apply).to.have.length(0);

    const stage = (name: string) => task.stages.find((entry) => entry.name === name);
    expect(stage('retrieve')?.status).to.equal('complete');
    expect(stage('plan')?.status).to.equal('complete');
    expect(stage('review')?.status).to.equal('complete');
    expect(stage('approval')?.status).to.equal('running');
    expect(stage('apply')?.status).to.equal('pending');

    expect(harness.runner.pendingApproval(task.id)?.review).to.have.length(1);
  });

  test('accepts a plan that intentionally proposes no changes', async () => {
    const harness = createHarness({ responses: [planText([])] });
    const task = await harness.runner.start('explain only', harness.token);
    expect(task.status).to.equal('awaiting-approval');
    expect(task.review).to.deep.equal([]);
    expect(task.planSummary).to.equal('Add a file');
  });

  test('fails closed on an unparseable plan and never applies', async () => {
    const harness = createHarness({ responses: ['not json at all'] });
    const task = await harness.runner.start('do something', harness.token);
    expect(task.status).to.equal('failed');
    expect(task.error).to.contain('JSON');
    expect(task.hint).to.contain('more specific request');
    expect(harness.calls.apply).to.have.length(0);
  });

  test('fails when change preparation reports an error', async () => {
    const harness = createHarness({ prepareError: 'src/a.ts is excluded by the workspace security rules.' });
    const task = await harness.runner.start('add a file', harness.token);
    expect(task.status).to.equal('failed');
    expect(task.error).to.contain('excluded');
    expect(harness.calls.apply).to.have.length(0);
  });

  test('stops before the repository is touched when cancellation arrives during retrieval', async () => {
    const harness = createHarness({
      retrieve: async (_query, token) => {
        token.onCancellationRequested(() => undefined);
        (token as TestCancellationToken).cancel();
        return { summary: SUMMARY, items: [], reasons: {}, skipped: [] };
      },
    });
    const task = await harness.runner.start('add a file', harness.token);
    expect(task.status).to.equal('cancelled');
    expect(task.providerCalls).to.equal(0);
  });

  test('stops when cancellation arrives during the provider call', async () => {
    const harness = createHarness({
      complete: async (token) => {
        (token as TestCancellationToken).cancel();
        return planText();
      },
    });
    const task = await harness.runner.start('add a file', harness.token);
    expect(task.status).to.equal('cancelled');
    expect(harness.calls.prepare).to.have.length(0);
  });

  test('enforces the configured provider step limit', async () => {
    const harness = createHarness({ agentSettings: { maxSteps: 0 } });
    const task = await harness.runner.start('add a file', harness.token);
    expect(task.status).to.equal('failed');
    expect(task.error).to.contain('maximum of 0 provider step');
    expect(harness.calls.complete).to.equal(0);
  });

  test('applies only the explicitly approved files', async () => {
    const harness = createHarness({
      responses: [
        planText([
          { kind: 'create', path: 'src/a.ts', content: 'a' },
          { kind: 'create', path: 'src/b.ts', content: 'b' },
        ]),
      ],
    });
    const planned = await harness.runner.start('add files', harness.token);
    const applied = await harness.runner.approve(planned.id, ['change-2'], harness.token);

    expect(harness.calls.apply).to.have.length(1);
    expect(harness.calls.apply[0].approvedIds).to.deep.equal(['change-2']);
    expect(applied.status).to.equal('applied');
    expect(applied.stages.find((stage) => stage.name === 'approval')?.detail).to.equal(
      '1 of 2 approved',
    );
    expect(applied.stages.find((stage) => stage.name === 'validate')?.status).to.equal('pending');
    expect(harness.runner.pendingApproval(planned.id)).to.equal(undefined);
  });

  test('rejects every change without applying when nothing is approved', async () => {
    const harness = createHarness();
    const planned = await harness.runner.start('add a file', harness.token);
    const rejected = await harness.runner.approve(planned.id, [], harness.token);
    expect(rejected.status).to.equal('rejected');
    expect(harness.calls.apply).to.have.length(0);
  });

  test('rejects approval ids that belong to another plan', async () => {
    const harness = createHarness();
    const planned = await harness.runner.start('add a file', harness.token);
    const failed = await harness.runner.approve(planned.id, ['change-99'], harness.token);
    expect(failed.status).to.equal('failed');
    expect(failed.error).to.contain('None of the selected changes');
  });

  test('does not claim success when apply produced no files', async () => {
    const harness = createHarness({ applyEmpty: true });
    const planned = await harness.runner.start('add a file', harness.token);
    const failed = await harness.runner.approve(planned.id, ['change-1'], harness.token);
    expect(failed.status).to.equal('failed');
    expect(failed.error).to.contain('No files were applied');
  });

  test('records a passing validation command', async () => {
    const harness = createHarness();
    const planned = await harness.runner.start('add a file', harness.token);
    await harness.runner.approve(planned.id, ['change-1'], harness.token);

    const validated = await harness.runner.validate(
      planned.id,
      'npm run test:unit',
      new AbortController().signal,
    );
    expect(harness.calls.commands).to.deep.equal(['npm run test:unit']);
    expect(validated.status).to.equal('applied');
    expect(validated.validation?.passed).to.equal(true);
    expect(validated.stages.find((stage) => stage.name === 'validate')?.status).to.equal('complete');
  });

  test('marks a failed validation and allows one repair pass', async () => {
    const harness = createHarness({
      responses: [
        planText(),
        planText([{ kind: 'modify', path: 'src/a.ts', content: 'fixed' }]),
      ],
      commandResult: { exitCode: 1, output: 'test failed' },
    });
    const planned = await harness.runner.start('add a file', harness.token);
    await harness.runner.approve(planned.id, ['change-1'], harness.token);

    const validated = await harness.runner.validate(
      planned.id,
      'npm run test:unit',
      new AbortController().signal,
    );
    expect(validated.status).to.equal('validation-failed');
    expect(validated.validation?.passed).to.equal(false);
    expect(validated.error).to.contain('validation command failed');

    const repaired = await harness.runner.repair(planned.id, harness.token);
    expect(repaired.status).to.equal('awaiting-approval');
    expect(repaired.repairIterations).to.equal(1);
    expect(repaired.providerCalls).to.equal(2);
    expect(harness.calls.prepare).to.have.length(2);
    expect(harness.calls.prepare[1].changes[0].content).to.equal('fixed');
  });

  test('stops at the repair limit instead of looping', async () => {
    const harness = createHarness({
      agentSettings: { maxRepairIterations: 0 },
      commandResult: { exitCode: 1 },
    });
    const planned = await harness.runner.start('add a file', harness.token);
    await harness.runner.approve(planned.id, ['change-1'], harness.token);
    await harness.runner.validate(planned.id, 'npm run test:unit', new AbortController().signal);
    const failed = await harness.runner.repair(planned.id, harness.token);
    expect(failed.status).to.equal('failed');
    expect(failed.error).to.contain('repair limit of 0');
    expect(harness.calls.complete).to.equal(1);
  });

  test('treats a cancelled validation run as cancelled, not passed', async () => {
    const harness = createHarness({ commandResult: { cancelled: true, exitCode: null } });
    const planned = await harness.runner.start('add a file', harness.token);
    await harness.runner.approve(planned.id, ['change-1'], harness.token);
    const validated = await harness.runner.validate(
      planned.id,
      'npm run test:unit',
      new AbortController().signal,
    );
    expect(validated.status).to.equal('cancelled');
    expect(validated.validation?.passed).to.equal(false);
  });

  test('reports command launch errors without claiming success', async () => {
    const harness = createHarness({ commandResult: { error: 'spawn failed', exitCode: null } });
    const planned = await harness.runner.start('add a file', harness.token);
    await harness.runner.approve(planned.id, ['change-1'], harness.token);
    const validated = await harness.runner.validate(
      planned.id,
      'npm run test:unit',
      new AbortController().signal,
    );
    expect(validated.status).to.equal('validation-failed');
    expect(validated.error).to.equal('spawn failed');
  });

  test('undoes applied changes through the change service', async () => {
    const outcome: UndoOutcome = {
      results: [{ changeId: 'change-1', path: 'src/a.ts', status: 'restored' }],
      restored: 1,
      conflicts: 0,
    };
    const harness = createHarness({ undoOutcome: outcome });
    const planned = await harness.runner.start('add a file', harness.token);
    await harness.runner.approve(planned.id, ['change-1'], harness.token);
    const result = await harness.runner.undo(planned.id);
    expect(result?.task.status).to.equal('undone');
    expect(result?.outcome.restored).to.equal(1);
    expect(harness.calls.undo).to.deep.equal([planned.id]);
  });

  test('keeps the task recoverable when undo hits a conflict', async () => {
    const harness = createHarness({
      undoOutcome: {
        results: [{ changeId: 'change-1', path: 'src/a.ts', status: 'conflict' }],
        restored: 0,
        conflicts: 1,
      },
    });
    const planned = await harness.runner.start('add a file', harness.token);
    await harness.runner.approve(planned.id, ['change-1'], harness.token);
    const result = await harness.runner.undo(planned.id);
    expect(result?.task.status).to.equal('validation-failed');
    expect(result?.task.error).to.contain('modified after apply');
  });

  test('returns undefined when there is nothing to undo', async () => {
    const harness = createHarness({ undoOutcome: undefined });
    const planned = await harness.runner.start('add a file', harness.token);
    expect(await harness.runner.undo(planned.id)).to.equal(undefined);
    expect(await harness.runner.undo('missing')).to.equal(undefined);
  });

  test('cancellation marks the running stage as skipped', async () => {
    const harness = createHarness();
    const planned = await harness.runner.start('add a file', harness.token);
    harness.runner.cancel(planned.id);
    const view = harness.runner.viewById(planned.id);
    expect(view?.status).to.equal('cancelled');
    expect(view?.stages.find((stage) => stage.name === 'approval')?.status).to.equal('skipped');
  });

  test('exposes stable stage labels', () => {
    const labels = createHarness().runner.stageLabels();
    expect(labels.retrieve).to.equal('Select relevant workspace files');
    expect(labels.validate).to.equal('Run the approved validation command');
  });
});
