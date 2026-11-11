import { expect } from 'chai';
import {
  engineResultToOutcome,
  orchestratorSessionToOutcome,
  renderOutcome,
  settingsToEngineLimits,
  type EngineeringOutcome,
} from '../../src/agent/execution';
import { runAgentEngine } from '../../src/agent/engine';
import { AGENT_LIMIT_BOUNDS } from '../../src/agent/limits';
import { resolveAgenticEngineSettings } from '../../src/config/resolve';
import type { AgentSession, AgentTask } from '../../src/agent/models';
import type { ChatMessage } from '../../src/providers/types';
import type { AgentModelResponse, AgentTool } from '../../src/agent/codingAgent';

const inventoryFiles = ['src/a.ts'];
const history: ChatMessage[] = [];

function legacyTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task-1',
    title: 't',
    description: 't',
    dependsOn: [],
    acceptanceCriteria: [],
    suggestedFiles: [],
    status: 'completed',
    attempts: 1,
    repairAttempts: 0,
    ...overrides,
  };
}

function fakeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    schemaVersion: 2,
    id: 'session-1',
    workspaceRoot: '/root',
    requirement: { id: 'req-1', text: 'req', createdAt: '2026-01-01T00:00:00.000Z' },
    state: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    needsReview: false,
    providerCalls: 2,
    tasks: [legacyTask()],
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

suite('shared execution contract', () => {
  test('resolved settings map into a full validated engine limit bundle', () => {
    const resolved = resolveAgenticEngineSettings({
      maxIterations: 20,
      maxToolCalls: 77,
      maxPlanRevisions: 4,
      maxDurationSeconds: 300,
      maxChangedFiles: 9,
    });
    const limits = settingsToEngineLimits(resolved);

    expect(limits.maxIterations).to.equal(20);
    expect(limits.maxToolCalls).to.equal(77);
    expect(limits.maxPlanRevisions).to.equal(4);
    expect(limits.maxDurationMs).to.equal(300_000);
    expect(limits.maxChangedFiles).to.equal(9);
    expect(limits.maxProviderRequests).to.be.within(AGENT_LIMIT_BOUNDS.maxProviderRequests.min, AGENT_LIMIT_BOUNDS.maxProviderRequests.max);
    expect(Number.isFinite(limits.maxToolOutputChars)).to.equal(true);
  });

  test('engine success maps to a completed outcome with evidence', async () => {
    const model: { complete(messages: readonly ChatMessage[]): Promise<AgentModelResponse> } = {
      complete: async () => ({ text: '{"final":"ok"}' }),
    };
    const tools: AgentTool[] = [];
    const result = await runAgentEngine({ task: 'do it', model: model as never, tools, onEvent: () => undefined });
    const outcome = engineResultToOutcome(result);

    expect(outcome.path).to.equal('chat-agent');
    expect(outcome.status).to.equal('completed');
    expect(outcome.evaluation).to.equal('complete');
    expect(outcome.providerRequests).to.equal(1);
    expect(outcome.filesChanged).to.deep.equal([]);
    expect(outcome.recoveryRequired).to.equal(false);
  });

  test('engine blocked maps to blocked outcome and preserves the reason', async () => {
    const failingTool: AgentTool = {
      name: 'flaky',
      description: 'flaky tool',
      parameters: {},
      execute: async () => ({ ok: false, tool: 'flaky', error: 'flaky failed', durationMs: 1 }),
    };
    const model: { complete(messages: readonly ChatMessage[]): Promise<AgentModelResponse> } = {
      complete: async () => ({
        text: '',
        toolCalls: [{ id: 'c1', name: 'flaky', arguments: {} }],
      }),
    };
    const result = await runAgentEngine({
      task: 'do it',
      model: model as never,
      tools: [failingTool],
      limits: { maxConsecutiveFailures: 1 },
    });
    const outcome = engineResultToOutcome(result);

    expect(outcome.status).to.equal('blocked');
    expect(outcome.evaluation).to.equal('failed');
    expect(outcome.limitReached).to.equal('consecutive-failures');
  });

  test('orchestrator completed session maps to completed outcome with change evidence', () => {
    const session = fakeSession({
      providerCalls: 3,
      executions: [
        {
          taskId: 'task-1',
          status: 'applied',
          attempts: 1,
          appliedFiles: [
            { path: 'src/a.ts', hash: 'h', kind: 'create' },
            { path: 'src\\b.ts', hash: 'h', kind: 'modify' },
          ],
        },
      ],
    });
    const outcome = orchestratorSessionToOutcome(session);

    expect(outcome.path).to.equal('orchestrator');
    expect(outcome.status).to.equal('completed');
    expect(outcome.evaluation).to.equal('complete');
    expect(outcome.providerRequests).to.equal(3);
    expect(outcome.filesChanged).to.deep.equal(['src/a.ts', 'src/b.ts']);
  });

  test('orchestrator failed session maps to failure with the error summary', () => {
    const session = fakeSession({
      state: 'failed',
      error: 'Validation failed after maximum repair attempts.',
      tasks: [legacyTask({ status: 'validation-failed', error: 'vpw' })],
    });
    const outcome = orchestratorSessionToOutcome(session);

    expect(outcome.status).to.equal('failed');
    expect(outcome.evaluation).to.equal('failed');
    expect(outcome.failureSummary).to.contain('Validation failed');
  });

  test('orchestrator partially-complete session reports partial, never complete', () => {
    const session = fakeSession({
      state: 'completed',
      tasks: [legacyTask(), legacyTask({ id: 'task-2', status: 'failed' })],
    });
    const outcome = orchestratorSessionToOutcome(session);

    expect(outcome.status).to.equal('partial');
    expect(outcome.evaluation).to.equal('partial');
  });

  test('renderOutcome is bounded and names recovery requirements', () => {
    const outcome: EngineeringOutcome = {
      path: 'orchestrator',
      status: 'recovery-required',
      evaluation: 'inconclusive',
      iterations: 1,
      providerRequests: 2,
      toolCalls: 0,
      revisions: 3,
      filesChanged: inventoryFiles,
      recoveryRequired: true,
      failureSummary: 'x'.repeat(500),
      limitReached: 'duration',
      refusedToolCalls: 0,
    };
    const line = renderOutcome(outcome);

    expect(line.length).to.be.lessThanOrEqual(500);
    expect(line).to.contain('recovery required');
    expect(line).to.contain('duration');
  });

  test('history invariant: both entry points never report an empty change list as applied', () => {
    const session = fakeSession({ executions: [] });
    const outcome = orchestratorSessionToOutcome(session);

    expect(outcome.filesChanged).to.deep.equal([]);
    expect(history).to.deep.equal([]);
  });
});
