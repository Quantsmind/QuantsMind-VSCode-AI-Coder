import { expect } from 'chai';
import { hashContent, type ChangePlan } from '../../src/changes/model';
import type { CommandResult } from '../../src/commands/runner';
import {
  resolveAgentSettings,
  resolveCommandSettings,
  type ResolvedAgentSettings,
} from '../../src/config/resolve';
import {
  AgentOrchestrator,
  AgentSessionError,
  type OrchestratorDependencies,
} from '../../src/agent/orchestrator';
import type {
  AgentSessionView,
  AppliedFileOutcome,
  ApplyOutcomeLike,
  IFileChangeService,
  PreparedChangeSet,
  ProjectContext,
  RetrievalResult,
} from '../../src/agent/models';
import type { ChatMessage } from '../../src/providers/types';
import {
  SessionRepository,
  type KeyValueStore,
} from '../../src/sessions/repository';
import type { WorkspaceSummary } from '../../src/workspace/analyze';
import { TestCancellationToken } from './helpers';

const WORKSPACE = '/workspace/demo';

const SUMMARY: WorkspaceSummary = {
  rootName: 'demo',
  fileCount: 1,
  technologies: [],
  topLevel: [],
  entryPoints: [],
  testFiles: 0,
  text: 'Workspace demo: 1 indexed file.',
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

class FakeChangeService implements IFileChangeService {
  readonly files = new Map<string, string>();
  readonly applyCalls: { approvedIds: string[]; taskId: string; summary: string }[] = [];
  alwaysConflict = false;
  prepareError?: string;

  async prepare(plan: ChangePlan, _taskId: string): Promise<PreparedChangeSet> {
    if (this.prepareError !== undefined) {
      return {
        plan: { ...plan, changes: [] },
        review: [],
        errors: [this.prepareError],
        warnings: [],
      };
    }
    const changes = plan.changes.map((change) => {
      if (change.kind === 'create') {
        return change;
      }
      const sourcePath = change.kind === 'rename' ? (change.fromPath ?? change.path) : change.path;
      const before = this.files.get(sourcePath);
      return before === undefined ? change : { ...change, expectedHash: hashContent(before) };
    });
    const prepared: ChangePlan = { ...plan, changes };
    return {
      plan: prepared,
      review: changes.map((change) => ({
        id: change.id,
        kind: change.kind,
        path: change.path,
        fromPath: change.fromPath,
        summary: change.summary,
        diff: `--- a/${change.path}\n+++ b/${change.path}\n@@\n-old\n+new`,
        additions: 1,
        deletions: 1,
        diffTruncated: false,
      })),
      errors: [],
      warnings: [],
    };
  }

  async apply(
    plan: ChangePlan,
    approvedIds: readonly string[],
    taskId: string,
    summary: string,
  ): Promise<{ outcome: ApplyOutcomeLike }> {
    this.applyCalls.push({ approvedIds: [...approvedIds], taskId, summary });
    const applied: AppliedFileOutcome[] = [];
    const conflicts: { changeId: string; path: string }[] = [];
    const failed: { changeId: string; path: string }[] = [];

    for (const change of plan.changes) {
      if (!approvedIds.includes(change.id)) {
        continue;
      }
      if (this.alwaysConflict) {
        conflicts.push({ changeId: change.id, path: change.path });
        continue;
      }
      const sourcePath = change.kind === 'rename' ? (change.fromPath ?? change.path) : change.path;
      const before = this.files.get(sourcePath);
      try {
        switch (change.kind) {
          case 'create':
            if (before !== undefined) {
              conflicts.push({ changeId: change.id, path: change.path });
              break;
            }
            this.files.set(change.path, change.content ?? '');
            applied.push({
              changeId: change.id,
              kind: change.kind,
              path: change.path,
              after: change.content,
              backupName: `${change.id}.json`,
            });
            break;
          case 'modify':
            if (before === undefined) {
              conflicts.push({ changeId: change.id, path: change.path });
              break;
            }
            this.files.set(change.path, change.content ?? '');
            applied.push({
              changeId: change.id,
              kind: change.kind,
              path: change.path,
              before,
              after: change.content,
              backupName: `${change.id}.json`,
            });
            break;
          case 'delete':
            if (before === undefined) {
              conflicts.push({ changeId: change.id, path: change.path });
              break;
            }
            this.files.delete(change.path);
            applied.push({
              changeId: change.id,
              kind: change.kind,
              path: change.path,
              before,
              backupName: `${change.id}.json`,
            });
            break;
          case 'rename':
            if (before === undefined || change.fromPath === undefined || this.files.has(change.path)) {
              conflicts.push({ changeId: change.id, path: change.path });
              break;
            }
            this.files.delete(change.fromPath);
            this.files.set(change.path, before);
            applied.push({
              changeId: change.id,
              kind: change.kind,
              path: change.path,
              fromPath: change.fromPath,
              before,
              after: before,
              backupName: `${change.id}.json`,
            });
            break;
        }
      } catch {
        failed.push({ changeId: change.id, path: change.path });
      }
    }

    return { outcome: { applied, conflicts, failed } };
  }

  async undo(_taskId: string): Promise<undefined> {
    return undefined;
  }

  async hashFile(path: string): Promise<string | undefined> {
    const content = this.files.get(path);
    return content === undefined ? undefined : hashContent(content);
  }
}

interface HarnessOptions {
  readonly responses?: readonly string[];
  readonly commandResults?: readonly CommandResult[];
  readonly runCommand?: (command: string, signal: AbortSignal) => Promise<CommandResult>;
  readonly agentSettings?: Partial<ResolvedAgentSettings>;
  readonly commandAllowlist?: readonly string[];
  readonly repository?: SessionRepository;
  readonly changes?: FakeChangeService;
}

interface Harness {
  readonly orchestrator: AgentOrchestrator;
  readonly changes: FakeChangeService;
  readonly calls: ChatMessage[][];
}

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    command: 'npm test',
    cwd: WORKSPACE,
    exitCode: 0,
    output: 'ok',
    timedOut: false,
    cancelled: false,
    truncated: false,
    durationMs: 5,
    ...overrides,
  };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const changes = options.changes ?? new FakeChangeService();
  const responses = [...(options.responses ?? [])];
  const commandResults = [...(options.commandResults ?? [])];
  const calls: ChatMessage[][] = [];

  const dependencies: OrchestratorDependencies = {
    workspaceRoot: WORKSPACE,
    complete: async (messages) => {
      calls.push(messages.map((message) => ({ ...message })));
      const text = responses.shift();
      if (text === undefined) {
        throw new Error('No scripted provider response remains.');
      }
      return { text };
    },
    inspect: async () => CONTEXT,
    retrieve: async (): Promise<RetrievalResult> => ({
      summary: SUMMARY,
      items: [],
      reasons: {},
      skipped: [],
    }),
    changes,
    runCommand:
      options.runCommand ??
      (async () => commandResults.shift() ?? commandResult()),
    agentSettings: () => ({ ...resolveAgentSettings({}), ...options.agentSettings }),
    commandSettings: () =>
      resolveCommandSettings({ allowlist: options.commandAllowlist ?? ['npm test'] }),
    hashFile: async (path) => changes.hashFile(path),
    repository: options.repository,
    now: () => new Date().toISOString(),
    logger: { info: () => undefined, warn: () => undefined },
  };

  return { orchestrator: new AgentOrchestrator(dependencies), changes, calls };
}

function developmentPlan(options: { validationCommand?: string; tasks?: number } = {}): string {
  const count = options.tasks ?? 1;
  const tasks = Array.from({ length: count }, (_, index) => ({
    id: `task-${index + 1}`,
    title: `Task ${index + 1}`,
    description: `Implement part ${index + 1}.`,
    dependsOn: index === 0 ? [] : [`task-${index}`],
    suggestedFiles: [`src/a${index + 1}.ts`],
    ...(options.validationCommand !== undefined
      ? { validationCommand: options.validationCommand }
      : {}),
    criteria: [
      {
        text: 'The behavior is demonstrated.',
        verification: options.validationCommand !== undefined ? 'command' : 'manual',
      },
    ],
  }));
  return JSON.stringify({ summary: 'Plan', approach: 'Do it', tasks });
}

function changeResponse(
  path = 'src/a.ts',
  content = 'export const a = 1;\n',
  kind: 'create' | 'modify' = 'create',
): string {
  return JSON.stringify({
    summary: 'Change',
    changes: [{ kind, path, summary: 'Apply the change.', content }],
  });
}

async function reachChangeApproval(
  harness: Harness,
  token = new TestCancellationToken(),
): Promise<AgentSessionView | undefined> {
  const started = await harness.orchestrator.start('Implement the feature', token);
  return harness.orchestrator.approvePlan(started.id, token);
}

async function reachValidation(
  harness: Harness,
  token = new TestCancellationToken(),
): Promise<AgentSessionView | undefined> {
  const waiting = await reachChangeApproval(harness, token);
  const ids = waiting?.pendingApproval?.ids ?? [];
  return harness.orchestrator.approveChanges(waiting?.id ?? '', ids, token);
}

function memoryStore(): KeyValueStore {
  let stored: unknown;
  return {
    get<T>(_key: string): T | undefined {
      return stored as T | undefined;
    },
    update(_key: string, value: unknown): PromiseLike<void> {
      stored = value;
      return Promise.resolve();
    },
  };
}

suite('agent orchestrator', () => {
  test('runs requirement to a verified completion with plan and change approval', async () => {
    const harness = createHarness({
      responses: [developmentPlan({ validationCommand: 'npm test' }), changeResponse()],
      commandResults: [commandResult({ exitCode: 0, output: 'all tests passed' })],
    });
    const token = new TestCancellationToken();

    const started = await harness.orchestrator.start('Implement the feature', token);
    expect(started.state).to.equal('awaiting-plan-approval');
    expect(started.plan?.tasks).to.have.length(1);
    expect(started.pendingApproval?.kind).to.equal('plan');

    const awaiting = await harness.orchestrator.approvePlan(started.id, token);
    expect(awaiting.state).to.equal('awaiting-change-approval');
    expect(awaiting.changeSets).to.have.length(1);
    expect(awaiting.pendingApproval?.kind).to.equal('change-set');

    const ids = awaiting.pendingApproval?.ids ?? [];
    const validating = await harness.orchestrator.approveChanges(started.id, ids, token);
    expect(validating.state).to.equal('validating');
    expect(harness.changes.files.get('src/a.ts')).to.equal('export const a = 1;\n');

    const completed = await harness.orchestrator.validate(
      started.id,
      'npm test',
      new AbortController().signal,
    );
    expect(completed.state).to.equal('completed');
    expect(completed.report?.outcome).to.equal('completed');
    expect(completed.validationRuns[0].evidence.passed).to.equal(true);
    expect(completed.tasks[0].status).to.equal('completed');
    expect(completed.report?.evidence.join(' ')).to.match(/passed with exit code 0/);
    expect(harness.calls).to.have.length(2);
  });

  test('rejects a plan without applying anything', async () => {
    const harness = createHarness({ responses: [developmentPlan()] });
    const started = await harness.orchestrator.start('Implement the feature', new TestCancellationToken());
    const rejected = await harness.orchestrator.rejectPlan(started.id);
    expect(rejected.state).to.equal('rejected');
    expect(rejected.report?.outcome).to.equal('rejected');
    expect(rejected.tasks[0].status).to.equal('skipped');
    expect(harness.changes.applyCalls).to.have.length(0);
  });

  test('rejects a change set without applying anything', async () => {
    const harness = createHarness({
      responses: [developmentPlan({ validationCommand: 'npm test' }), changeResponse()],
    });
    const awaiting = await reachChangeApproval(harness);
    const rejected = await harness.orchestrator.rejectChanges(awaiting?.id ?? '');
    expect(rejected.state).to.equal('rejected');
    expect(rejected.report?.outcome).to.equal('rejected');
    expect(harness.changes.applyCalls).to.have.length(0);
  });

  test('fails closed when apply reports a workspace conflict', async () => {
    const changes = new FakeChangeService();
    changes.alwaysConflict = true;
    const harness = createHarness({
      changes,
      responses: [developmentPlan({ validationCommand: 'npm test' }), changeResponse()],
    });
    const awaiting = await reachChangeApproval(harness);
    const failed = await harness.orchestrator.approveChanges(
      awaiting?.id ?? '',
      awaiting?.pendingApproval?.ids ?? [],
      new TestCancellationToken(),
    );
    expect(failed.state).to.equal('failed');
    expect(failed.report?.outcome).to.equal('failed');
    expect(failed.tasks[0].status).to.equal('failed');
    expect(failed.error).to.match(/No files were applied/);
    expect(failed.validationRuns).to.have.length(0);
  });

  test('diagnoses a failed validation and completes after an approved repair', async () => {
    const harness = createHarness({
      responses: [
        developmentPlan({ validationCommand: 'npm test' }),
        changeResponse(),
        changeResponse('src/a.ts', 'export const a = 2;\n', 'modify'),
      ],
      commandResults: [
        commandResult({
          exitCode: 1,
          output: "src/a.ts(1,1): error TS1005: ';' expected.\n",
        }),
        commandResult({ exitCode: 0, output: 'all tests passed' }),
      ],
    });
    const token = new TestCancellationToken();
    const validating = await reachValidation(harness, token);

    const diagnosing = await harness.orchestrator.validate(
      validating?.id ?? '',
      'npm test',
      new AbortController().signal,
    );
    expect(diagnosing.state).to.equal('diagnosing');
    expect(diagnosing.tasks[0].status).to.equal('validation-failed');
    expect(diagnosing.diagnostics.some((diagnostic) => diagnostic.file === 'src/a.ts')).to.equal(true);
    expect(diagnosing.diagnostics[0].message).to.match(/TS1005/);

    const proposed = await harness.orchestrator.generateRepair(validating?.id ?? '', token);
    expect(proposed.state).to.equal('awaiting-repair-approval');
    expect(proposed.repairProposals).to.have.length(1);
    expect(proposed.pendingApproval?.kind).to.equal('repair');
    expect(proposed.pendingApproval?.ids).to.have.length(1);

    const repaired = await harness.orchestrator.approveRepair(
      validating?.id ?? '',
      proposed.pendingApproval?.ids ?? [],
      token,
    );
    expect(repaired.state).to.equal('validating');
    expect(harness.changes.files.get('src/a.ts')).to.equal('export const a = 2;\n');

    const completed = await harness.orchestrator.validate(
      validating?.id ?? '',
      'npm test',
      new AbortController().signal,
    );
    expect(completed.state).to.equal('completed');
    expect(completed.tasks[0].repairAttempts).to.equal(1);
    expect(completed.report?.repairs).to.equal(1);
    expect(completed.validationRuns).to.have.length(2);
  });

  test('stops repairing at the configured repair limit', async () => {
    const harness = createHarness({
      agentSettings: { maxRepairIterations: 0 },
      responses: [developmentPlan({ validationCommand: 'npm test' }), changeResponse()],
      commandResults: [commandResult({ exitCode: 1, output: 'failure' })],
    });
    const validating = await reachValidation(harness);
    const diagnosing = await harness.orchestrator.validate(
      validating?.id ?? '',
      'npm test',
      new AbortController().signal,
    );
    expect(diagnosing.state).to.equal('diagnosing');

    const failed = await harness.orchestrator.generateRepair(validating?.id ?? '', new TestCancellationToken());
    expect(failed.state).to.equal('failed');
    expect(failed.error).to.match(/repair limit/);
  });

  test('reports a repair rejection as a failure with evidence', async () => {
    const harness = createHarness({
      responses: [
        developmentPlan({ validationCommand: 'npm test' }),
        changeResponse(),
        changeResponse('src/a.ts', 'export const a = 2;\n', 'modify'),
      ],
      commandResults: [commandResult({ exitCode: 1, output: 'failure' })],
    });
    const validating = await reachValidation(harness);
    await harness.orchestrator.validate(
      validating?.id ?? '',
      'npm test',
      new AbortController().signal,
    );
    const proposed = await harness.orchestrator.generateRepair(
      validating?.id ?? '',
      new TestCancellationToken(),
    );
    const failed = await harness.orchestrator.rejectRepair(proposed.id);
    expect(failed.state).to.equal('failed');
    expect(failed.report?.outcome).to.equal('failed');
    expect(failed.tasks[0].status).to.equal('failed');
  });

  test('cancels an in-flight validation command', async () => {
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const harness = createHarness({
      responses: [developmentPlan({ validationCommand: 'npm test' }), changeResponse()],
      runCommand: (command, signal) =>
        new Promise<CommandResult>((resolve) => {
          signalStarted?.();
          const finish = (): void =>
            resolve(
              commandResult({
                command,
                exitCode: null,
                output: '',
                cancelled: true,
              }),
            );
          if (signal.aborted) {
            finish();
          } else {
            signal.addEventListener('abort', finish, { once: true });
          }
        }),
    });
    const token = new TestCancellationToken();
    const validating = await reachValidation(harness, token);
    const pending = harness.orchestrator.validate(
      validating?.id ?? '',
      'npm test',
      new AbortController().signal,
    );
    await started;
    const cancelled = await harness.orchestrator.cancel(validating?.id ?? '');
    expect(cancelled.state).to.equal('cancelled');
    const settled = await pending;
    expect(settled.state).to.equal('cancelled');
    expect(settled.report?.outcome).to.equal('cancelled');
  });

  test('pauses and resumes at an approval boundary without auto-approving', async () => {
    const harness = createHarness({
      responses: [developmentPlan({ validationCommand: 'npm test' }), changeResponse()],
    });
    const awaiting = await reachChangeApproval(harness);
    const paused = await harness.orchestrator.pause(awaiting?.id ?? '');
    expect(paused.state).to.equal('paused');
    expect(paused.pausedFrom).to.equal('awaiting-change-approval');

    const resumed = await harness.orchestrator.resume(awaiting?.id ?? '', new TestCancellationToken());
    expect(resumed.state).to.equal('awaiting-change-approval');
    expect(resumed.pendingApproval?.kind).to.equal('change-set');
    expect(harness.changes.applyCalls).to.have.length(0);

    const applied = await harness.orchestrator.approveChanges(
      awaiting?.id ?? '',
      resumed.pendingApproval?.ids ?? [],
      new TestCancellationToken(),
    );
    expect(applied.state).to.equal('validating');
  });

  test('rejects a second plan approval after the plan was accepted', async () => {
    const harness = createHarness({
      responses: [developmentPlan({ validationCommand: 'npm test' }), changeResponse()],
    });
    const awaiting = await reachChangeApproval(harness);
    let caught: unknown;
    try {
      await harness.orchestrator.approvePlan(awaiting?.id ?? '', new TestCancellationToken());
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(AgentSessionError);
  });

  test('stops before planning when the provider step budget is exhausted', async () => {
    const harness = createHarness({
      agentSettings: { maxSteps: 1 },
      responses: [developmentPlan({ validationCommand: 'npm test' })],
    });
    const started = await harness.orchestrator.start(
      'Implement the feature',
      new TestCancellationToken(),
    );
    const failed = await harness.orchestrator.approvePlan(started.id, new TestCancellationToken());
    expect(failed.state).to.equal('failed');
    expect(failed.error).to.match(/maximum of 1 provider step/);
    expect(failed.report?.outcome).to.equal('failed');
  });

  test('completes a task with no validation command and says so in the report', async () => {
    const harness = createHarness({
      responses: [developmentPlan(), changeResponse()],
    });
    const applied = await reachValidation(harness);
    expect(applied?.state).to.equal('completed');
    expect(applied?.validationRuns).to.have.length(0);
    expect(applied?.report?.evidence.join(' ')).to.match(/No validation command was executed/);
  });

  test('blocks validation commands outside the allowlist and records a diagnostic', async () => {
    const harness = createHarness({
      responses: [developmentPlan({ validationCommand: 'npm test' }), changeResponse()],
    });
    const validating = await reachValidation(harness);
    const failed = await harness.orchestrator.validate(
      validating?.id ?? '',
      'rm -rf src',
      new AbortController().signal,
    );
    expect(failed.state).to.equal('failed');
    expect(failed.diagnostics.some((diagnostic) => /not permitted/.test(diagnostic.message))).to.equal(true);
    expect(harness.changes.applyCalls).to.have.length(1);
  });

  test('restores a persisted session after restart and revalidates its files', async () => {
    const repository = new SessionRepository(memoryStore(), { warn: () => undefined });
    const first = createHarness({
      repository,
      responses: [developmentPlan({ validationCommand: 'npm test' }), changeResponse()],
    });
    const awaiting = await reachChangeApproval(first);
    const id = awaiting?.id ?? '';

    const second = createHarness({ repository, changes: first.changes });
    const stored = await second.orchestrator.loadStoredSessions();
    expect(stored).to.have.length(1);
    expect(stored[0].id).to.equal(id);
    expect(stored[0].needsReview).to.equal(true);

    const restored = await second.orchestrator.restore(id);
    expect(restored?.state).to.equal('awaiting-change-approval');
    expect(restored?.needsReview).to.equal(false);
    expect(restored?.pendingApproval?.kind).to.equal('change-set');

    const applied = await second.orchestrator.approveChanges(
      id,
      restored?.pendingApproval?.ids ?? [],
      new TestCancellationToken(),
    );
    expect(applied?.state).to.equal('validating');
    expect(first.changes.files.get('src/a.ts')).to.equal('export const a = 1;\n');
  });

  test('fails a restored session whose applied file changed after apply', async () => {
    const repository = new SessionRepository(memoryStore(), { warn: () => undefined });
    const first = createHarness({
      repository,
      responses: [developmentPlan({ validationCommand: 'npm test' }), changeResponse()],
    });
    const validating = await reachValidation(first);
    const id = validating?.id ?? '';
    first.changes.files.set('src/a.ts', 'export const a = 999;\n');

    const second = createHarness({ repository, changes: first.changes });
    await second.orchestrator.loadStoredSessions();
    const restored = await second.orchestrator.restore(id);
    expect(restored?.state).to.equal('failed');
    expect(restored?.needsReview).to.equal(true);
    expect(restored?.error).to.match(/changed after it was applied/);
    expect(restored?.report?.outcome).to.equal('failed');
  });

  test('rejects resuming a session that still needs review', async () => {
    const repository = new SessionRepository(memoryStore(), { warn: () => undefined });
    const first = createHarness({
      repository,
      responses: [developmentPlan({ validationCommand: 'npm test' }), changeResponse()],
    });
    const awaiting = await reachChangeApproval(first);
    const paused = await first.orchestrator.pause(awaiting?.id ?? '');
    expect(paused.state).to.equal('paused');

    const second = createHarness({ repository, changes: first.changes });
    await second.orchestrator.loadStoredSessions();
    let caught: unknown;
    try {
      await second.orchestrator.resume(awaiting?.id ?? '', new TestCancellationToken());
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(AgentSessionError);
  });
});
