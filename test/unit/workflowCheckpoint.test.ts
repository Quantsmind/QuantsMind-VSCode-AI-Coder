import { expect } from 'chai';
import {
  canTransitionWorkflowPhase,
  computeWorkflowRestoration,
  isTerminalWorkflowPhase,
  isWorkflowPhase,
  makeCheckpointMessage,
  parseCheckpointMessage,
} from '../../src/workflow/checkpoint';
import { WORKFLOW_PHASES } from '../../src/workflow/model';

suite('workflow checkpoint phases and transitions', () => {
  test('the happy path transitions are legal', () => {
    const sequence = ['created', 'planned', 'awaiting-review', 'approved', 'editing', 'changes-applied', 'validation-pending', 'validation-complete', 'completed'] as const;
    for (let index = 0; index < sequence.length - 1; index += 1) {
      expect(canTransitionWorkflowPhase(sequence[index], sequence[index + 1]), `${sequence[index]} -> ${sequence[index + 1]}`).to.equal(true);
    }
  });

  test('illegal jumps are rejected', () => {
    expect(canTransitionWorkflowPhase('created', 'completed')).to.equal(false);
    expect(canTransitionWorkflowPhase('planned', 'editing')).to.equal(false);
    expect(canTransitionWorkflowPhase('cancelled', 'planned')).to.equal(false);
    expect(canTransitionWorkflowPhase('completed', 'editing')).to.equal(false);
    expect(canTransitionWorkflowPhase('awaiting-review', 'editing')).to.equal(false);
  });

  test('cancellation is legal from every non-terminal phase', () => {
    for (const phase of WORKFLOW_PHASES) {
      if (isTerminalWorkflowPhase(phase)) {
        continue;
      }
      expect(canTransitionWorkflowPhase(phase, 'cancelled'), `${phase} -> cancelled`).to.equal(true);
    }
    expect(canTransitionWorkflowPhase('completed', 'cancelled')).to.equal(false);
    expect(canTransitionWorkflowPhase('cancelled', 'cancelled')).to.equal(true);
  });

  test('terminal phases are recognized', () => {
    expect(isTerminalWorkflowPhase('completed')).to.equal(true);
    expect(isTerminalWorkflowPhase('cancelled')).to.equal(true);
    expect(isTerminalWorkflowPhase('blocked')).to.equal(true);
    expect(isTerminalWorkflowPhase('editing')).to.equal(false);
  });

  test('checkpoint messages round-trip through the parser', () => {
    const message = makeCheckpointMessage('editing', 'changeset-42');

    expect(parseCheckpointMessage(message)).to.deep.equal({ phase: 'editing', detail: 'changeset-42' });
    expect(parseCheckpointMessage('workflow:planned')).to.deep.equal({ phase: 'planned' });
  });

  test('malformed checkpoint messages are ignored', () => {
    expect(parseCheckpointMessage('completely unrelated note')).to.equal(undefined);
    expect(parseCheckpointMessage('workflow:not-a-phase')).to.equal(undefined);
    expect(parseCheckpointMessage(42 as unknown as string)).to.equal(undefined);
    expect(parseCheckpointMessage('workflow:completed something')).to.deep.equal({ phase: 'completed', detail: 'something' });
  });

  test('an interruption during editing requires inspection before further work', () => {
    const restoration = computeWorkflowRestoration([
      { type: 'note', message: 'workflow:planned 2 tasks' },
      { type: 'task', message: 'The change set for task "x" is awaiting approval.' },
      { type: 'note', message: 'workflow:editing changeset-7' },
    ]);

    expect(restoration.phase).to.equal('editing');
    expect(restoration.requiresInspection).to.equal(true);
    expect(restoration.terminal).to.equal(false);
    expect(restoration.note).to.contain('Verify the files on disk');
  });

  test('applied-but-unvalidated changes also require inspection', () => {
    const restoration = computeWorkflowRestoration([
      { type: 'note', message: 'workflow:changes-applied' },
    ]);

    expect(restoration.requiresInspection).to.equal(true);
  });

  test('a completed workflow is terminal and does not require inspection', () => {
    const restoration = computeWorkflowRestoration([
      { type: 'note', message: 'workflow:editing changeset-3' },
      { type: 'note', message: 'workflow:changes-applied changeset-3' },
      { type: 'note', message: 'workflow:validation-complete' },
      { type: 'note', message: 'workflow:completed' },
    ]);

    expect(restoration.phase).to.equal('completed');
    expect(restoration.requiresInspection).to.equal(false);
    expect(restoration.terminal).to.equal(true);
  });

  test('restoration ignores non-note events and picks the latest checkpoint', () => {
    const restoration = computeWorkflowRestoration([
      { type: 'state', message: 'workflow:editing' }, // wrong type: ignored
      { type: 'note', message: 'workflow:planned 1 task' },
      { type: 'note', message: 'task garbage line' },
    ]);

    expect(restoration.phase).to.equal('planned');
    expect(restoration.requiresInspection).to.equal(false);
  });

  test('phase validation rejects unknown tokens', () => {
    expect(isWorkflowPhase('editing')).to.equal(true);
    expect(isWorkflowPhase('Editig')).to.equal(false);
    expect(isWorkflowPhase(undefined)).to.equal(false);
  });
});
