import { expect } from 'chai';
import type { CommandResult } from '../../src/commands/runner';
import type { ChangePlan } from '../../src/changes/model';
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

function oneTaskPlan(): string {
  return JSON.stringify({
    summary: 'Implement in one focused pass.',
    approach: 'Inspect, implement, verify.',
    tasks: [
      {
        id: 'task-1',
        title: 'Add greeting helper',
        description: 'Create the helper.',
        dependsOn: [],
        suggestedFiles: ['src/greeting.ts'],
        criteria: [{ text: 'Reviewed', verification: 'review' }],
      },
    ],
  });
}

function bigChangePlan(fileCount: number): string {
  const changes = Array.from({ length: fileCount }, (_, index) => ({
    kind: 'create',
    path: `src/file-${index}.ts`,
    summary: `Create file ${index}`,
    content: `export const file${index} = ${index};\n`,
  }));
  return JSON.stringify({ summary: `Create ${fileCount} files`, changes });
}

function smallChangePlan(): string {
  return JSON.stringify({
    summary: 'Create the helper.',
    changes: [
      { kind: 'create', path: 'src/greeting.ts', summary: 'Create the greeting helper.', content: 'export const greeting = "hello";\n' },
    ],
  });
}

interface Harness {
  readonly controller: AgentOrchestrator;
  readonly counters: { complete: number; prepare: number; apply: number };
  readonly applied: { taskId: string; ids: readonly string[] }[];
}

function createHarness(executionLimits: (() => typeof AGENT_LIMIT_DEFAULTS) | undefined, changePlanText: string): Harness {
  const counters = { complete: 0, prepare: 0, apply: 0 };
  const applied: { taskId: string; ids: readonly string[] }[] = [];
  const planText = oneTaskPlan();

  const controller = new AgentOrchestrator({
    workspaceRoot: () => ROOT,
    isTrusted: () => true,
    ...(executionLimits !== undefined ? { executionLimits } : {}),
    agentSettings: () => ({ maxSteps: 20, maxRepairIterations: 2, timeoutMs: 60_000 }),
    commandSettings: () => ({ allowlist: ['npm test'], timeoutMs: 10_000, maxOutputChars: 4_000 }),
    inspect: async () => CONTEXT,
    retrieve: async () => ({ summary: SUMMARY, items: [], reasons: {}, skipped: [] } satisfies RetrievalResult),
    complete: async (messages: readonly ChatMessage[]): Promise<CompletionResult> => {
      counters.complete += 1;
      const prompt = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
      if (prompt.includes('Return the JSON development plan now.')) {
        return { text: planText };
      }
      return { text: changePlanText };
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
      async undo(_taskId: string) {
        return { restored: 0, conflicts: 0 };
      },
    },
    runCommand: async (command: string) => ({
      command,
      cwd: ROOT,
      exitCode: 0,
      output: 'ok',
      durationMs: 1,
      timedOut: false,
    }) as CommandResult,
  });

  return { controller, counters, applied };
}

function planRequest(view: AgentSessionView): string {
  const request = view.pendingApproval;
  if (request === undefined || request.kind !== 'plan') {
    throw new Error('not waiting for plan approval');
  }
  return request.id;
}

suite('orchestrator execution budgets (v2.5.7)', () => {
  test('nothing is budgeted when no execution limits are injected (legacy behavior)', async () => {
    const harness = createHarness(undefined, smallChangePlan());
    const start = await harness.controller.start('Add the greeting helper', TOKEN);
    expect(start.state).to.equal('awaiting-plan-approval');

    const afterApprove = await harness.controller.approvePlan(start.id, TOKEN, planRequest(start));
    expect(afterApprove.pendingApproval?.kind).to.equal('change-set');
    expect(harness.counters.complete).to.equal(2);
  });

  test('provider budget stops a second execution call with an honest, revision-free failure', async () => {
    const harness = createHarness(() => ({ ...AGENT_LIMIT_DEFAULTS, maxProviderRequests: 1 }), smallChangePlan());
    const start = await harness.controller.start('Add the greeting helper', TOKEN);
    expect(start.state).to.equal('awaiting-plan-approval');

    const afterApprove = await harness.controller.approvePlan(start.id, TOKEN, planRequest(start));

    expect(harness.counters.complete).to.equal(1); // the change-plan model call is refused by the shared budget
    expect(afterApprove.state).to.equal('failed');
    expect(afterApprove.error ?? '').to.contain('maxProviderRequests');
    expect(harness.counters.apply).to.equal(0);
  });

  test('an exhausted duration budget blocks the very first provider call', async () => {
    const harness = createHarness(() => ({ ...AGENT_LIMIT_DEFAULTS, maxDurationMs: 0 }), smallChangePlan());
    const view = await harness.controller.start('Add the greeting helper', TOKEN);

    expect(harness.counters.complete).to.equal(0);
    expect(view.state).to.equal('failed');
    expect(view.error ?? '').to.contain('maxDurationSeconds');
  });

  test('an oversized proposed change set is refused before the change-set approval appears', async () => {
    const harness = createHarness(() => ({ ...AGENT_LIMIT_DEFAULTS, maxChangedFiles: 3, maxProviderRequests: 999, maxDurationMs: 9_999_999 }), bigChangePlan(6));
    const start = await harness.controller.start('Add the greeting helpers', TOKEN);

    const afterApprove = await harness.controller.approvePlan(start.id, TOKEN, planRequest(start));

    expect(afterApprove.pendingApproval).to.equal(undefined);
    expect(afterApprove.error ?? '').to.contain('maxChangedFiles');
    expect(harness.counters.apply).to.equal(0);
    expect(harness.counters.prepare).to.equal(1); // preparation reported; refusal happened before approval
  });

  test('a compliant change set completes the legacy flow unchanged', async () => {
    const harness = createHarness(
      () => ({ ...AGENT_LIMIT_DEFAULTS, maxChangedFiles: 6, maxPatchSizeChars: 1_000_000, maxProviderRequests: 999, maxDurationMs: 9_999_999 }),
      smallChangePlan(),
    );
    const start = await harness.controller.start('Add the greeting helper', TOKEN);
    const afterApprove = await harness.controller.approvePlan(start.id, TOKEN, planRequest(start));

    expect(afterApprove.pendingApproval?.kind).to.equal('change-set');
    expect(afterApprove.error).to.equal(undefined);
  });
});
