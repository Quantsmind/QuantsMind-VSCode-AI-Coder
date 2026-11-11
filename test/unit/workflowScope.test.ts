import { expect } from 'chai';
import { checkChangeScope, taskCompletionStatus } from '../../src/workflow/scope';

suite('planned vs actual change scope', () => {
  test('matched files are reported with normalized paths and case-insensitive matching', () => {
    const check = checkChangeScope(['src/a.ts', 'src/b.ts'], ['SRC\\a.ts']);

    // Matching is case-insensitive and backslash-normalized, but the applied
    // path keeps the caller's casing.
    expect(check.matched).to.deep.equal(['SRC/a.ts']);
    expect(check.missing).to.deep.equal(['src/b.ts']);
    expect(check.scopeExpanded).to.equal(false);
    expect(check.complete).to.equal(false);
  });

  test('out-of-scope applied files flag scope expansion', () => {
    const check = checkChangeScope(['src/a.ts'], ['src/a.ts', 'src/other.ts']);

    expect(check.unexpected).to.deep.equal(['src/other.ts']);
    expect(check.scopeExpanded).to.equal(true);
    expect(check.complete).to.equal(false);
  });

  test('fully covered scope reports complete', () => {
    const check = checkChangeScope(['src/a.ts', 'src/b.ts'], ['src/a.ts', 'src/b.ts']);

    expect(check.unexpected).to.deep.equal([]);
    expect(check.missing).to.deep.equal([]);
    expect(check.complete).to.equal(true);
    expect(taskCompletionStatus(['src/a.ts', 'src/b.ts'], ['src/a.ts', 'src/b.ts'])).to.equal('complete');
  });

  test('expected-but-never-applied files report partial completion, not success', () => {
    expect(taskCompletionStatus(['src/a.ts', 'src/b.ts'], ['src/a.ts'])).to.equal('partial');
    expect(taskCompletionStatus(['src/a.ts'], [])).to.equal('planned-not-applied');
  });

  test('expected empty with unexpected files is partial, never complete', () => {
    const check = checkChangeScope([], ['src/surprise.ts']);

    expect(check.scopeExpanded).to.equal(true);
    expect(check.complete).to.equal(false);
    expect(taskCompletionStatus([], ['src/surprise.ts'])).to.equal('partial');
  });

  test('path normalization rejects traversal consistently for both sides', () => {
    const check = checkChangeScope(['src/a.ts'], ['../outside.ts', 'src/a.ts']);

    expect(check.unexpected).to.deep.equal([]); // the traversal entry is dropped, not treated as in-scope
    expect(check.matched).to.deep.equal(['src/a.ts']);
    expect(check.complete).to.equal(true);
  });

  test('duplicate expected paths are deduped', () => {
    const check = checkChangeScope(['src/a.ts', 'src/a.ts'], ['src/a.ts']);

    expect(check.matched).to.deep.equal(['src/a.ts']);
    expect(check.complete).to.equal(true);
  });
});
