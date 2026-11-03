import { expect } from 'chai';
import {
  createIgnoreMatcher,
  isIgnored,
  mergeIgnoreFiles,
  parseIgnoreFile,
} from '../../src/workspace/ignore';

suite('workspace ignore matching', () => {
  test('parses comments, blanks, negation, anchoring, and directory rules', () => {
    const rules = parseIgnoreFile(
      ['# comment', '', 'node_modules/', '*.log', '!important.log', '/build/', 'docs/**'].join(
        '\n',
      ),
    );
    expect(rules).to.have.length(5);
    expect(rules[0]).to.deep.equal({
      pattern: 'node_modules',
      negated: false,
      directoryOnly: true,
      anchored: false,
    });
    expect(rules[2]).to.deep.equal({
      pattern: 'important.log',
      negated: true,
      directoryOnly: false,
      anchored: false,
    });
    expect(rules[3]).to.deep.equal({
      pattern: 'build',
      negated: false,
      directoryOnly: true,
      anchored: true,
    });
    expect(rules[4].anchored).to.equal(true);
  });

  test('ignores directory contents and directory entries', () => {
    const rules = parseIgnoreFile('node_modules/');
    expect(isIgnored('node_modules', true, rules)).to.equal(true);
    expect(isIgnored('node_modules/pkg/index.js', false, rules)).to.equal(true);
    expect(isIgnored('packages/app/node_modules/x.js', false, rules)).to.equal(true);
    expect(isIgnored('src/node_modules.txt', false, rules)).to.equal(false);
  });

  test('anchored directory rules only match from the workspace root', () => {
    const rules = parseIgnoreFile('/build/');
    expect(isIgnored('build', true, rules)).to.equal(true);
    expect(isIgnored('build/app.js', false, rules)).to.equal(true);
    expect(isIgnored('src/build/app.js', false, rules)).to.equal(false);
  });

  test('applies the last matching rule so negation works in order', () => {
    const keep = parseIgnoreFile('*.log\n!important.log');
    expect(isIgnored('important.log', false, keep)).to.equal(false);
    expect(isIgnored('other.log', false, keep)).to.equal(true);

    const lateIgnore = parseIgnoreFile('!important.log\n*.log');
    expect(isIgnored('important.log', false, lateIgnore)).to.equal(true);
  });

  test('never ignores an empty path', () => {
    const rules = parseIgnoreFile('*');
    expect(isIgnored('', false, rules)).to.equal(false);
    expect(isIgnored('', true, rules)).to.equal(false);
  });

  test('normalizes Windows separators and leading dots', () => {
    const rules = parseIgnoreFile('dist/');
    expect(isIgnored('.\\dist\\bundle.js', false, rules)).to.equal(true);
    expect(isIgnored('./dist/bundle.js', false, rules)).to.equal(true);
  });

  test('supports escaped hash patterns and drops oversized patterns', () => {
    const rules = parseIgnoreFile(['\\#literal', `a${'b'.repeat(400)}`].join('\n'));
    expect(rules).to.have.length(1);
    expect(rules[0].pattern).to.equal('#literal');
    expect(isIgnored('#literal', false, rules)).to.equal(true);
  });

  test('merges missing files without failing', () => {
    const rules = mergeIgnoreFiles([undefined, null, '', '*.tmp']);
    expect(rules).to.have.length(1);
  });

  test('createIgnoreMatcher evaluates combined rules', () => {
    const ignored = createIgnoreMatcher(['*.tmp\n', undefined, '!keep.tmp']);
    expect(ignored('scratch.tmp', false)).to.equal(true);
    expect(ignored('keep.tmp', false)).to.equal(false);
    expect(ignored('src/index.ts', false)).to.equal(false);
  });
});
