import { expect } from 'chai';
import { allocateBudget, estimateTokens, describeAllocation } from '../../src/context/tokenBudget';

suite('token budget allocator', () => {
  test('estimateTokens approximates chars/4', () => {
    expect(estimateTokens('')).to.equal(0);
    expect(estimateTokens('abcd')).to.equal(1);
    expect(estimateTokens('x'.repeat(100))).to.equal(25);
  });

  test('selects candidates within budget by density, pinned first', () => {
    const report = allocateBudget(
      [
        { id: 'low', score: 10, estimatedTokens: 100 },
        { id: 'pinned', score: 1, estimatedTokens: 400, pinned: true },
        { id: 'dense-high', score: 90, estimatedTokens: 100 },
        { id: 'dense-mid', score: 30, estimatedTokens: 100 },
      ],
      500,
    );

    expect(report.included.map((entry) => entry.id)).to.deep.equal(['pinned', 'dense-high']);
    expect(report.excluded.map((entry) => entry.id)).to.deep.equal(['dense-mid', 'low']);
    expect(report.usedTokens).to.equal(500);
    expect(report.remainingTokens).to.equal(0);
  });

  test('reports budget exceeded for pinned candidates that overflow alone', () => {
    const report = allocateBudget(
      [{ id: 'huge', score: 1, estimatedTokens: 10_000, pinned: true }],
      100,
    );

    expect(report.included).to.have.length(1);
    expect(report.included[0]?.estimatedTokens).to.equal(10_000);
    expect(report.remainingTokens).to.equal(-9_900);
  });

  test('deterministic tie-break by id', () => {
    const left = allocateBudget(
      [
        { id: 'b', score: 10, estimatedTokens: 50 },
        { id: 'a', score: 10, estimatedTokens: 50 },
      ],
      25,
    );
    const right = allocateBudget(
      [
        { id: 'a', score: 10, estimatedTokens: 50 },
        { id: 'b', score: 10, estimatedTokens: 50 },
      ],
      25,
    );
    expect(left.included.map((entry) => entry.id)).to.deep.equal(right.included.map((entry) => entry.id));
  });

  test('handles empty input, duplicate ids and non-finite scores', () => {
    expect(allocateBudget([], 100).included).to.have.length(0);

    const report = allocateBudget(
      [
        { id: 'x', score: Number.NaN, estimatedTokens: 30 },
        { id: 'x', score: 99, estimatedTokens: 30 },
      ],
      100,
    );
    expect(report.included.map((entry) => entry.id)).to.deep.equal(['x']);
  });

  test('describeAllocation renders a bounded human summary', () => {
    const text = describeAllocation(
      { budgetTokens: 100, usedTokens: 60, remainingTokens: 40, included: [{ id: 'a.ts', estimatedTokens: 60, reason: 'selected' }], excluded: [{ id: 'b.ts', estimatedTokens: 20, reason: 'exceeds-budget' }] },
      'test-context',
    );

    expect(text).to.contain('test-context');
    expect(text).to.contain('a.ts');
    expect(text).to.contain('1 excluded');
  });
});
