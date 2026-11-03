import { expect } from 'chai';
import {
  SESSION_SCHEMA_VERSION,
  type AgentSession,
  type AgentState,
} from '../../src/agent/models';
import {
  canPause,
  canTransition,
  deriveStages,
  transitionSession,
} from '../../src/agent/stateMachine';

function baseSession(state: AgentState): AgentSession {
  const at = '2026-01-01T00:00:00.000Z';
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: 'session-1',
    workspaceRoot: '/workspace/demo',
    requirement: { id: 'req-1', text: 'Do the work', createdAt: at },
    state,
    needsReview: false,
    createdAt: at,
    updatedAt: at,
    providerCalls: 0,
    tasks: [],
    executions: [],
    changeSets: [],
    approvals: [],
    validationRuns: [],
    diagnostics: [],
    repairProposals: [],
    events: [],
  };
}

suite('agent state machine', () => {
  test('only safe states can pause', () => {
    const pausable: AgentState[] = [
      'ready',
      'awaiting-plan-approval',
      'awaiting-change-approval',
      'awaiting-repair-approval',
      'diagnosing',
    ];
    for (const state of pausable) {
      expect(canPause(state), state).to.equal(true);
    }
    expect(canPause('executing')).to.equal(false);
    expect(canPause('validating')).to.equal(false);
    expect(canPause('applying')).to.equal(false);
  });

  test('terminal states have no outgoing transitions', () => {
    for (const state of ['completed', 'failed', 'rejected', 'cancelled'] as const) {
      expect(canTransition(state, 'ready'), state).to.equal(false);
      expect(canTransition(state, 'failed'), state).to.equal(false);
    }
  });

  test('paused sessions resume only to a resumable state and can still fail or cancel', () => {
    expect(canTransition('paused', 'ready')).to.equal(true);
    expect(canTransition('paused', 'awaiting-plan-approval')).to.equal(true);
    expect(canTransition('paused', 'diagnosing')).to.equal(true);
    expect(canTransition('paused', 'executing')).to.equal(false);
    expect(canTransition('paused', 'paused')).to.equal(false);
    expect(canTransition('paused', 'failed')).to.equal(true);
    expect(canTransition('paused', 'cancelling')).to.equal(true);
  });

  test('cancelling only completes as cancelled or failed', () => {
    expect(canTransition('cancelling', 'cancelled')).to.equal(true);
    expect(canTransition('cancelling', 'failed')).to.equal(true);
    expect(canTransition('cancelling', 'ready')).to.equal(false);
    expect(canTransition('executing', 'cancelling')).to.equal(true);
  });

  test('transitionSession records pause origin and clears it on resume', () => {
    const paused = transitionSession(baseSession('awaiting-change-approval'), 'paused', {
      at: '2026-01-01T00:00:01.000Z',
      eventId: 'event-1',
      message: 'Paused.',
    });
    expect(paused.state).to.equal('paused');
    expect(paused.pausedFrom).to.equal('awaiting-change-approval');
    expect(paused.events).to.have.length(1);

    const resumed = transitionSession(paused, 'awaiting-change-approval', {
      at: '2026-01-01T00:00:02.000Z',
      eventId: 'event-2',
      message: 'Resumed.',
    });
    expect(resumed.state).to.equal('awaiting-change-approval');
    expect(resumed.pausedFrom).to.equal(undefined);
    expect(resumed.events).to.have.length(2);
  });

  test('invalid transitions are rejected', () => {
    expect(() =>
      transitionSession(baseSession('ready'), 'awaiting-plan-approval', {
        at: '2026-01-01T00:00:01.000Z',
        eventId: 'event-1',
        message: 'Invalid.',
      }),
    ).to.throw(/Invalid agent transition/);
  });

  test('deriveStages never advances a stage from a provider claim', () => {
    const planned = baseSession('awaiting-plan-approval');
    const stages = deriveStages(planned);
    expect(stages.find((stage) => stage.name === 'plan')?.status).to.equal('pending');
    expect(stages.find((stage) => stage.name === 'plan-approval')?.status).to.equal('running');
    expect(stages.find((stage) => stage.name === 'validate')?.status).to.equal('pending');
  });

  test('deriveStages reports recorded validation evidence', () => {
    const completed = {
      ...baseSession('completed'),
      validationRuns: [
        {
          id: 'validation-1',
          taskId: 'task-1',
          command: 'npm test',
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:00:01.000Z',
          evidence: {
            command: 'npm test',
            exitCode: 0,
            passed: true,
            timedOut: false,
            cancelled: false,
            truncated: false,
            durationMs: 1,
            output: 'ok',
          },
        },
      ],
    } satisfies AgentSession;
    const stages = deriveStages(completed);
    expect(stages.find((stage) => stage.name === 'validate')?.status).to.equal('complete');
    expect(stages.find((stage) => stage.name === 'report')?.status).to.equal('pending');
  });
});
