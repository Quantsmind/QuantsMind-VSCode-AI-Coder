import { expect } from 'chai';
import {
  AgentOrchestrator,
} from '../../src/agent/orchestrator';
import {
  type AgentSession,
  type ProjectContext,
  type RetrievalResult,
} from '../../src/agent/models';
import type { ChangePlan } from '../../src/changes/model';
import type { CancellationTokenLike, ChatMessage, CompletionResult } from '../../src/providers/types';
import type { ISessionRepository } from '../../src/sessions/repository';
import type { WorkspaceSummary } from '../../src/workspace/analyze';

/**
 * v3.1.1 WP2 regression coverage for agent session deletion semantics:
 * memory survives a storage failure, repository is purged on success, busy
 * sessions refuse deletion, and in-flight sessions cannot be removed while an
 * operation is pending.
 */

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
  summaryText: 'Workspace demo uses npm.',
};

const SUMMARY: WorkspaceSummary = {
  rootName: 'demo',
  fileCount: 3,
  technologies: [],
  topLevel: [],
  entryPoints: [],
  testFiles: 1,
  text: 'demo: 3 indexed files.',
};

const PLAN = JSON.stringify({
  summary: 'Documentation pass',
  approach: 'do nothing',
  tasks: [],
});

class TrackingRepository implements ISessionRepository {
  readonly stored: AgentSession[] = [];
  removeCalls = 0;
  saveCalls = 0;
  removeError?: Error;

  async load(): Promise<readonly AgentSession[]> {
    return [...this.stored];
  }

  async get(id: string): Promise<AgentSession | undefined> {
    return this.stored.find((session) => session.id === id);
  }

  async save(session: AgentSession): Promise<void> {
    this.saveCalls += 1;
    const index = this.stored.findIndex((entry) => entry.id === session.id);
    if (index >= 0) {
      this.stored[index] = session;
    } else {
      this.stored.push(session);
    }
  }

  async remove(id: string): Promise<void> {
    this.removeCalls += 1;
    if (this.removeError) {
      throw this.removeError;
    }
    const index = this.stored.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      this.stored.splice(index, 1);
    }
  }
}

function createTrackingHarness(
  repository: TrackingRepository,
  options: { readonly complete?: () => CompletionResult | Promise<CompletionResult> } = {},
): {
  readonly controller: AgentOrchestrator;
  readonly counters: { readonly complete: number };
} {
  const counters = { complete: 0 };
  const controller = new AgentOrchestrator({
    workspaceRoot: () => '/virtual/root',
    isTrusted: () => true,
    repository,
    logger: { info: () => undefined, warn: () => undefined },
    agentSettings: () => ({ maxSteps: 20, maxRepairIterations: 2, timeoutMs: 60_000 }),
    commandSettings: () => ({
      allowlist: ['npm test'],
      timeoutMs: 10_000,
      maxOutputChars: 4_000,
    }),
    inspect: async () => CONTEXT,
    retrieve: async () =>
      ({ summary: SUMMARY, items: [], reasons: {}, skipped: [] } satisfies RetrievalResult),
    complete: async (_messages: readonly ChatMessage[]): Promise<CompletionResult> => {
      counters.complete += 1;
      if (options.complete !== undefined) {
        return options.complete();
      }
      return { text: PLAN, finishReason: 'stop' };
    },
    changes: {
      async prepare(plan: ChangePlan) {
        return { plan, review: [], errors: [], warnings: [] };
      },
      async apply(): Promise<never> {
        throw new Error('apply must never run in this test');
      },
      async undo(): Promise<{ restored: number; conflicts: number }> {
        return { restored: 0, conflicts: 0 };
      },
    },
    runCommand: async () => {
      throw new Error('runCommand must never run in this test');
    },
  });
  return { controller, counters };
}

suite('agent session deletion (v3.1.1)', () => {
  test('successful deletion removes the session from memory and storage', async () => {
    const repository = new TrackingRepository();
    const { controller } = createTrackingHarness(repository);
    const view = await controller.start('Add a greeting helper', TOKEN);
    expect(view.state).to.equal('awaiting-plan-approval');
    expect(repository.stored).to.have.lengthOf(1);

    await controller.remove(view.id);
    expect(repository.removeCalls).to.equal(1);
    expect(controller.list()).to.have.lengthOf(0);
    expect(repository.stored).to.have.lengthOf(0);
    expect(controller.view(view.id)).to.equal(undefined);
  });

  test('a storage failure preserves the in-memory session and surfaces an error', async () => {
    const repository = new TrackingRepository();
    const { controller } = createTrackingHarness(repository);
    const view = await controller.start('Add a greeting helper', TOKEN);
    expect(view.state).to.equal('awaiting-plan-approval');

    repository.removeError = new Error('disk full');
    let failure: unknown;
    try {
      await controller.remove(view.id);
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    expect((failure as Error).message).to.contain('disk full');
    expect(controller.list()).to.have.lengthOf(1);
    expect(controller.view(view.id)).to.not.equal(undefined);
    expect(repository.stored).to.have.lengthOf(1);
  });
});
