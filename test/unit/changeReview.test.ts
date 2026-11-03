import { expect } from 'chai';
import { buildReviewChanges } from '../../src/changes/review';
import {
  validateChangeInputs,
  type ChangePlan,
  type FileChangeInput,
} from '../../src/changes/model';

function makePlan(inputs: readonly FileChangeInput[]): ChangePlan {
  const validation = validateChangeInputs(inputs);
  if (validation.errors.length > 0) {
    throw new Error(validation.errors.join(' '));
  }
  return { id: 'p1', summary: 's', changes: validation.changes };
}

suite('change review rendering', () => {
  test('renders a create diff and reports counts', () => {
    const plan = makePlan([
      { kind: 'create', path: 'src/a.ts', content: 'one\ntwo\n', summary: 'Add module' },
    ]);
    const review = buildReviewChanges(plan.changes, new Map([['src/a.ts', undefined]]));
    expect(review).to.have.length(1);
    expect(review[0].diff).to.contain('--- /dev/null');
    expect(review[0].diff).to.contain('+one');
    expect(review[0].additions).to.equal(2);
    expect(review[0].deletions).to.equal(0);
    expect(review[0].warning).to.equal(undefined);
    expect(review[0].summary).to.equal('Add module');
  });

  test('warns when create would overwrite and when modify targets a missing file', () => {
    const createPlan = makePlan([{ kind: 'create', path: 'src/a.ts', content: 'x' }]);
    expect(
      buildReviewChanges(createPlan.changes, new Map([['src/a.ts', 'existing']]))[0].warning,
    ).to.contain('already exists');

    const modifyPlan = makePlan([{ kind: 'modify', path: 'src/b.ts', content: 'x' }]);
    expect(
      buildReviewChanges(modifyPlan.changes, new Map([['src/b.ts', undefined]]))[0].warning,
    ).to.contain('does not currently exist');
  });

  test('renders rename diffs against the source path', () => {
    const plan = makePlan([{ kind: 'rename', fromPath: 'src/old.ts', path: 'src/new.ts' }]);
    const review = buildReviewChanges(
      plan.changes,
      new Map([['src/old.ts', 'same content']]),
    );
    expect(review[0].diff).to.contain('--- a/src/old.ts');
    expect(review[0].diff).to.contain('+++ b/src/new.ts');
    expect(review[0].fromPath).to.equal('src/old.ts');
    expect(review[0].warning).to.equal(undefined);
  });

  test('renders a deletion to /dev/null', () => {
    const plan = makePlan([{ kind: 'delete', path: 'src/gone.ts' }]);
    const review = buildReviewChanges(plan.changes, new Map([['src/gone.ts', 'bye\n']]));
    expect(review[0].diff).to.contain('+++ /dev/null');
    expect(review[0].deletions).to.equal(1);
  });
});
