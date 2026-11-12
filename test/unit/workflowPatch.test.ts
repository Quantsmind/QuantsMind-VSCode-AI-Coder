import { expect } from 'chai';
import { applyChangePlan } from '../../src/changes/apply';
import {
  hashContent,
  validateChangeInputs,
  type ChangePlan,
  type FileChangeInput,
} from '../../src/changes/model';
import { MemoryChangeFs } from './changeFs';

function makePlan(inputs: readonly FileChangeInput[]): ChangePlan {
  const validation = validateChangeInputs(inputs);
  if (validation.errors.length > 0) {
    throw new Error(validation.errors.join(' '));
  }
  return { id: 'plan-1', summary: 'Test plan', changes: validation.changes };
}

suite('patch cancellation (v2.5.5)', () => {
  test('cancellation before any mutation applies nothing and reports every file as skipped', async () => {
    const fs = new MemoryChangeFs();
    const plan = makePlan([
      { kind: 'create', path: 'src/a.ts', content: 'a' },
      { kind: 'create', path: 'src/b.ts', content: 'b' },
    ]);
    const outcome = await applyChangePlan(plan, fs, { shouldCancel: () => true });

    expect(outcome.applied).to.deep.equal([]);
    expect(fs.files.has('src/a.ts')).to.equal(false);
    expect(fs.files.has('src/b.ts')).to.equal(false);
    expect(outcome.results.every((result) => result.status === 'skipped')).to.equal(true);
    expect(outcome.results[0]?.message).to.contain('Cancelled');
  });

  test('cancellation mid-plan keeps applied files and skips the rest', async () => {
    const fs = new MemoryChangeFs();
    const plan = makePlan([
      { kind: 'create', path: 'src/a.ts', content: 'a' },
      { kind: 'create', path: 'src/b.ts', content: 'b' },
      { kind: 'create', path: 'src/c.ts', content: 'c' },
    ]);
    let calls = 0;
    const outcome = await applyChangePlan(plan, fs, {
      shouldCancel: () => {
        calls += 1;
        return calls > 1; // cancel from the second file onward
      },
    });

    expect(outcome.applied.map((file) => file.path)).to.deep.equal(['src/a.ts']);
    const byPath = new Map(outcome.results.map((result) => [result.path, result]));
    expect(byPath.get('src/a.ts')?.status).to.equal('applied');
    expect(byPath.get('src/b.ts')?.status).to.equal('skipped');
    expect(byPath.get('src/c.ts')?.status).to.equal('skipped');
    expect(fs.files.has('src/a.ts')).to.equal(true);
    expect(fs.files.has('src/b.ts')).to.equal(false);
    expect(fs.files.has('src/c.ts')).to.equal(false);
  });

  test('cancellation never applies a file silently after the user asked to stop', async () => {
    const fs = new MemoryChangeFs({ 'src/y.ts': 'y1' });
    const plan = makePlan([
      { kind: 'create', path: 'src/x.ts', content: 'x' },
      { kind: 'modify', path: 'src/y.ts', content: 'y2', expectedHash: hashContent('y1') },
    ]);
    const outcome = await applyChangePlan(plan, fs, { shouldCancel: () => true });

    expect(outcome.applied).to.deep.equal([]);
    expect(fs.files.has('src/x.ts')).to.equal(false);
    expect(fs.files.get('src/y.ts')).to.equal('y1');
  });
});
