import { expect } from 'chai';
import { checkChangeSetBudgets } from '../../src/workflow/executionBudgets';

const limits = { maxChangedFiles: 2, maxPatchSizeChars: 1_000 };

suite('change-set execution budgets (shared across paths)', () => {
  test('small change sets pass', () => {
    const result = checkChangeSetBudgets(
      [{ kind: 'create', path: 'src/a.ts', content: 'export const a = 1;\n' }],
      limits,
    );

    expect(result.ok).to.equal(true);
  });

  test('distinct file count over the budget is refused with changed-files', () => {
    const result = checkChangeSetBudgets(
      [
        { kind: 'create', path: 'src/a.ts', content: 'x' },
        { kind: 'create', path: 'src/b.ts', content: 'x' },
        { kind: 'create', path: 'src/c.ts', content: 'x' },
      ],
      limits,
    );

    expect(result.ok).to.equal(false);
    if (!result.ok) {
      expect(result.reason).to.equal('changed-files');
      expect(result.detail).to.contain('2');
    }
  });

  test('rename sources count toward the budget once', () => {
    const result = checkChangeSetBudgets(
      [{ kind: 'rename', path: 'src/new.ts', fromPath: 'src/old.ts', content: undefined }],
      limits,
    );

    expect(result.ok).to.equal(true);
    if (result.ok) {
      expect(result).to.deep.equal({ ok: true });
    }
  });

  test('cumulative content bytes over the budget is refused with patch-size', () => {
    const result = checkChangeSetBudgets(
      [
        { kind: 'create', path: 'src/a.ts', content: 'x'.repeat(600) },
        { kind: 'create', path: 'src/b.ts', content: 'x'.repeat(600) },
      ],
      limits,
    );

    expect(result.ok).to.equal(false);
    if (!result.ok) {
      expect(result.reason).to.equal('patch-size');
    }
  });

  test('paths that fail normalization do not inflate the file count', () => {
    const result = checkChangeSetBudgets(
      [
        { kind: 'create', path: '../evil.ts', content: 'x' },
        { kind: 'create', path: 'src/ok.ts', content: 'x' },
      ],
      limits,
    );

    expect(result.ok).to.equal(true);
  });

  test('a path may differ in case without double-counting', () => {
    const result = checkChangeSetBudgets(
      [
        { kind: 'modify', path: 'src/A.ts', content: 'x' },
        { kind: 'modify', path: 'src/a.ts', content: 'y' },
      ],
      limits,
    );

    expect(result.ok).to.equal(true);
  });
});
