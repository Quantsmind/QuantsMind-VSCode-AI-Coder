import { expect } from 'chai';
import { createUnifiedDiff } from '../../src/changes/diff';

suite('unified diff generation', () => {
  test('renders a create diff against /dev/null', () => {
    const diff = createUnifiedDiff('src/new.ts', undefined, 'export const a = 1;\nexport const b = 2;\n');
    expect(diff.text).to.contain('--- /dev/null');
    expect(diff.text).to.contain('+++ b/src/new.ts');
    expect(diff.text).to.contain('@@ -0,0 +1,2 @@');
    expect(diff.text).to.contain('+export const a = 1;');
    expect(diff.additions).to.equal(2);
    expect(diff.deletions).to.equal(0);
    expect(diff.truncated).to.equal(false);
  });

  test('renders a delete diff against /dev/null', () => {
    const diff = createUnifiedDiff('src/gone.ts', 'line one\nline two\n', undefined);
    expect(diff.text).to.contain('--- a/src/gone.ts');
    expect(diff.text).to.contain('+++ /dev/null');
    expect(diff.text).to.contain('-line one');
    expect(diff.additions).to.equal(0);
    expect(diff.deletions).to.equal(2);
  });

  test('renders a rename header with the source path', () => {
    const diff = createUnifiedDiff('src/b.ts', 'same\n', 'same\n', 'src/a.ts');
    expect(diff.text).to.contain('--- a/src/a.ts');
    expect(diff.text).to.contain('+++ b/src/b.ts');
    expect(diff.additions).to.equal(0);
    expect(diff.deletions).to.equal(0);
  });

  test('produces a change hunk with context and line numbers', () => {
    const before = ['one', 'two', 'three', 'four', 'five'].join('\n');
    const after = ['one', 'two', 'THREE', 'four', 'five'].join('\n');
    const diff = createUnifiedDiff('src/numbers.txt', before, after, undefined, {
      contextLines: 1,
    });
    expect(diff.text).to.contain('@@ -2,3 +2,3 @@');
    expect(diff.text).to.contain(' two');
    expect(diff.text).to.contain('-three');
    expect(diff.text).to.contain('+THREE');
    expect(diff.text).to.contain(' four');
    expect(diff.additions).to.equal(1);
    expect(diff.deletions).to.equal(1);
  });

  test('splits distant changes into separate hunks', () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`);
    const after = before.map((line, index) =>
      index === 1 || index === 18 ? `${line} changed` : line,
    );
    const diff = createUnifiedDiff('src/lines.txt', before.join('\n'), after.join('\n'));
    const hunks = diff.text.match(/@@ /g) ?? [];
    expect(hunks).to.have.length(2);
    expect(diff.additions).to.equal(2);
    expect(diff.deletions).to.equal(2);
  });

  test('returns only headers for an identical file', () => {
    const diff = createUnifiedDiff('src/same.ts', 'a\nb\n', 'a\nb\n');
    expect(diff.text).to.equal('--- a/src/same.ts\n+++ b/src/same.ts');
    expect(diff.additions).to.equal(0);
    expect(diff.deletions).to.equal(0);
  });

  test('handles empty and missing trailing newlines', () => {
    expect(createUnifiedDiff('a.txt', undefined, '').additions).to.equal(0);
    const diff = createUnifiedDiff('a.txt', 'a', 'a\nb');
    expect(diff.text).to.contain('+b');
    expect(diff.additions).to.equal(1);
  });

  test('truncates very large diffs and reports it', () => {
    const before = Array.from({ length: 400 }, (_, index) => `before ${index}`).join('\n');
    const after = Array.from({ length: 400 }, (_, index) => `after ${index}`).join('\n');
    const diff = createUnifiedDiff('src/big.txt', before, after, undefined, { maxChars: 1_000 });
    expect(diff.truncated).to.equal(true);
    expect(diff.text.length).to.be.lessThan(1_200);
    expect(diff.text).to.contain('diff truncated at 1000 characters');
  });

  test('falls back to whole-file replacement for very large edits', () => {
    const before = Array.from({ length: 2_100 }, (_, index) => `old ${index}`).join('\n');
    const after = Array.from({ length: 2_100 }, (_, index) => `new ${index}`).join('\n');
    const diff = createUnifiedDiff('src/huge.txt', before, after, undefined, {
      maxChars: 5_000_000,
    });
    expect(diff.additions).to.equal(2_100);
    expect(diff.deletions).to.equal(2_100);
  });

  test('clamps the context option', () => {
    const before = Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n');
    const after = before.replace('line 5', 'line five');
    const diff = createUnifiedDiff('src/x.txt', before, after, undefined, { contextLines: 99 });
    expect(diff.text).to.contain('@@ -1,10 +1,10 @@');
  });
});
