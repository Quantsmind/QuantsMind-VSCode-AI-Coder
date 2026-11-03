import { expect } from 'chai';
import type { AgentTask, TaskStatus } from '../../src/agent/models';
import {
  findTask,
  orderTasks,
  refreshBlockedTasks,
  schedule,
  updateTask,
  validateTaskGraph,
} from '../../src/agent/scheduler';

function task(id: string, dependsOn: readonly string[] = [], status: TaskStatus = 'pending'): AgentTask {
  return {
    id,
    title: `Task ${id}`,
    description: '',
    dependsOn,
    acceptanceCriteria: [],
    suggestedFiles: [],
    status,
    attempts: 0,
    repairAttempts: 0,
  };
}

suite('agent task scheduler', () => {
  test('rejects duplicate, unknown and cyclic dependencies', () => {
    expect(validateTaskGraph([task('a'), task('a')]).errors[0]).to.match(/more than once/);
    expect(validateTaskGraph([task('a', ['missing'])]).errors[0]).to.match(/unknown task/);
    const cyclic = validateTaskGraph([task('a', ['b']), task('b', ['a'])]);
    expect(cyclic.ok).to.equal(false);
    expect(cyclic.errors.join(' ')).to.match(/cycle/);
  });

  test('blocked tasks follow failed dependencies and recover on completion', () => {
    const blocked = refreshBlockedTasks([task('a', [], 'failed'), task('b', ['a'])]);
    expect(blocked.find((entry) => entry.id === 'b')?.status).to.equal('blocked');

    const recovered = refreshBlockedTasks([task('a', [], 'completed'), task('b', ['a'], 'blocked')]);
    expect(recovered.find((entry) => entry.id === 'b')?.status).to.equal('pending');
  });

  test('schedule prefers the first runnable task and waits for an active one', () => {
    const decision = schedule([task('a'), task('b', ['a'])]);
    expect(decision.reason).to.equal('runnable');
    expect(decision.runnable?.id).to.equal('a');

    const waiting = schedule([task('a', [], 'running'), task('b', ['a'])]);
    expect(waiting.reason).to.equal('waiting');
    expect(waiting.activeTaskId).to.equal('a');
  });

  test('schedule reports done, stopped and deadlock states', () => {
    expect(schedule([]).reason).to.equal('done');
    expect(schedule([task('a', [], 'completed')]).reason).to.equal('done');
    expect(schedule([task('a', [], 'failed'), task('b', [], 'skipped')]).reason).to.equal('stopped');

    const deadlocked = schedule([task('a', [], 'failed'), task('b', ['a'])]);
    expect(deadlocked.reason).to.equal('deadlock');
    expect(deadlocked.blockedTaskIds).to.deep.equal(['b']);
    expect(schedule([task('a', ['b']), task('b', ['a'])]).reason).to.equal('deadlock');
  });

  test('orderTasks returns a deterministic topological order', () => {
    const ordered = orderTasks([task('c', ['a', 'b']), task('b', ['a']), task('a')]);
    expect(ordered.map((entry) => entry.id)).to.deep.equal(['a', 'b', 'c']);
  });

  test('updateTask and findTask operate on immutable copies', () => {
    const tasks = [task('a')];
    const updated = updateTask(tasks, 'a', { status: 'completed', attempts: 1 });
    expect(tasks[0].status).to.equal('pending');
    expect(findTask(updated, 'a')?.status).to.equal('completed');
    expect(findTask(updated, 'a')?.attempts).to.equal(1);
  });
});
