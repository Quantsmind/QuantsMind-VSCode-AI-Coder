import { expect } from 'chai';
import { computeContinuationPlan } from '../../src/agent/continuation';

suite('continuation plan', () => {
  test('marks completed tasks done and leaves nothing resumable when all finished', () => {
    const plan = computeContinuationPlan([
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'applied' },
      { id: 'c', status: 'skipped' },
    ]);

    expect(plan.done).to.deep.equal(['a', 'b', 'c']);
    expect(plan.resumable).to.have.length(0);
    expect(plan.interrupted).to.have.length(0);
    expect(plan.failed).to.have.length(0);
    expect(plan.blocked).to.have.length(0);
  });

  test('running and awaiting-approval tasks are interrupted and become resumable', () => {
    const plan = computeContinuationPlan([
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'running', dependencies: ['a'] },
      { id: 'c', status: 'awaiting-approval', dependencies: ['b'] },
    ]);

    expect(plan.interrupted).to.deep.equal(['b', 'c']);
    expect(plan.resumable).to.deep.equal(['b', 'c']);
    expect(plan.blocked).to.have.length(0);
  });

  test('failed tasks block their dependents and require attention', () => {
    const plan = computeContinuationPlan([
      { id: 'a', status: 'failed' },
      { id: 'b', status: 'pending', dependencies: ['a'] },
      { id: 'c', status: 'pending', dependencies: ['b'] },
      { id: 'd', status: 'pending' },
    ]);

    expect(plan.failed).to.deep.equal(['a']);
    expect(plan.resumable).to.deep.equal(['d']);
    expect(plan.blocked).to.deep.equal(['b', 'c']);
    expect(plan.reasons.b).to.contain('failed dependency');
  });

  test('validation-failed and cancelled tasks are treated as failed', () => {
    const plan = computeContinuationPlan([
      { id: 'a', status: 'validation-failed' },
      { id: 'b', status: 'cancelled' },
      { id: 'c', status: 'running', dependencies: ['a'] },
    ]);

    expect(plan.failed).to.deep.equal(['a', 'b']);
    expect(plan.blocked).to.deep.equal(['c']);
  });

  test('handles empty input', () => {
    const plan = computeContinuationPlan([]);

    expect(plan.done).to.have.length(0);
    expect(plan.resumable).to.have.length(0);
  });
});
