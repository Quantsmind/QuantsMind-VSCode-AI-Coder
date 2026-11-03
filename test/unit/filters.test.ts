import { expect } from 'chai';
import {
  CONTEXT_TRUNCATION_MARKER,
  buildContext,
  filterContextCandidates,
  isPathExcluded,
  normalizeContextPath,
  type ContextCandidate,
  type ContextFilterOptions,
} from '../../src/context/filters';

const TEST_SECRET = 'sk-test-abcdefghijklmnopqrstuvwxyz';

function options(overrides: Partial<ContextFilterOptions> = {}): ContextFilterOptions {
  return {
    excludeGlobs: ['.env', '.env.*', '*.pem', '**/secrets/**', '**/node_modules/**', 'custom/**'],
    maxFileSizeBytes: 4096,
    maxTotalChars: 10_000,
    maxFiles: 10,
    ...overrides,
  };
}

function candidate(path: string, content = 'const value = 1;'): ContextCandidate {
  return { path, content, languageId: 'typescript' };
}

suite('context path handling', () => {
  test('normalizes separators and redundant prefixes', () => {
    expect(normalizeContextPath('src\\nested\\\\file.ts')).to.equal('src/nested/file.ts');
    expect(normalizeContextPath('./src/file.ts')).to.equal('src/file.ts');
    expect(normalizeContextPath('  src/file.ts  ')).to.equal('src/file.ts');
  });

  test('matches exclusions case-insensitively at any depth', () => {
    const globs = options().excludeGlobs;
    expect(isPathExcluded('.env', globs)).to.equal(true);
    expect(isPathExcluded('config/.env.local', globs)).to.equal(true);
    expect(isPathExcluded('certs/server.PEM', globs)).to.equal(true);
    expect(isPathExcluded('src/secrets/credentials.json', globs)).to.equal(true);
    expect(isPathExcluded('node_modules/pkg/index.js', globs)).to.equal(true);
    expect(isPathExcluded('custom/tool/config.json', globs)).to.equal(true);
    expect(isPathExcluded('src/index.ts', globs)).to.equal(false);
  });

  test('ignores blank and malformed patterns', () => {
    expect(isPathExcluded('src/index.ts', ['', '   '])).to.equal(false);
    expect(isPathExcluded('src/index.ts', ['[invalid'])).to.equal(false);
  });
});

suite('context candidate filtering', () => {
  test('skips excluded, empty, binary and oversized content', () => {
    const result = filterContextCandidates(
      [
        candidate('.env', 'SECRET=value'),
        candidate('src/empty.ts', ''),
        candidate('src/binary.ts', 'abc\u0000def'),
        candidate('src/huge.ts', 'x'.repeat(5000)),
        candidate('src/ok.ts'),
      ],
      options(),
    );

    expect(result.included.map((item) => item.path)).to.deep.equal(['src/ok.ts']);
    expect(result.skipped).to.deep.equal([
      { path: '.env', reason: 'excluded' },
      { path: 'src/empty.ts', reason: 'empty' },
      { path: 'src/binary.ts', reason: 'binary' },
      { path: 'src/huge.ts', reason: 'too_large' },
    ]);
  });

  test('detects duplicates while allowing distinct selections', () => {
    const result = filterContextCandidates(
      [
        candidate('src/a.ts'),
        candidate('src/a.ts'),
        {
          ...candidate('src/a.ts'),
          isSelection: true,
          startLine: 1,
          endLine: 2,
        },
        {
          ...candidate('src/a.ts'),
          isSelection: true,
          startLine: 4,
          endLine: 5,
        },
      ],
      options(),
    );

    expect(result.included).to.have.length(3);
    expect(result.skipped).to.deep.equal([{ path: 'src/a.ts', reason: 'duplicate' }]);
  });

  test('enforces the maximum file count', () => {
    const result = filterContextCandidates(
      [candidate('a.ts'), candidate('b.ts'), candidate('c.ts')],
      options({ maxFiles: 2 }),
    );

    expect(result.included.map((item) => item.path)).to.deep.equal(['a.ts', 'b.ts']);
    expect(result.skipped).to.deep.equal([{ path: 'c.ts', reason: 'limit_files' }]);
  });

  test('truncates content that exceeds the remaining character budget', () => {
    const result = filterContextCandidates(
      [candidate('long.ts', 'y'.repeat(5000))],
      options({ maxFileSizeBytes: 10_000, maxTotalChars: 1000 }),
    );

    expect(result.skipped).to.deep.equal([]);
    expect(result.included).to.have.length(1);
    const item = result.included[0];
    expect(item.content).to.have.length(1000);
    expect(item.content.endsWith(CONTEXT_TRUNCATION_MARKER)).to.equal(true);
  });

  test('skips a file when less than the minimum truncation budget remains', () => {
    const result = filterContextCandidates(
      [candidate('first.ts', 'a'.repeat(1800)), candidate('second.ts', 'b'.repeat(1000))],
      options({ maxFileSizeBytes: 10_000, maxTotalChars: 2000 }),
    );

    expect(result.included.map((item) => item.path)).to.deep.equal(['first.ts']);
    expect(result.skipped).to.deep.equal([{ path: 'second.ts', reason: 'limit_chars' }]);
  });

  test('reports a stable size in bytes', () => {
    const result = filterContextCandidates([candidate('utf8.ts', 'é')], options());
    expect(result.included[0].sizeBytes).to.equal(2);
  });
});

suite('context building and redaction', () => {
  test('redacts the exact configured credential and detected secrets', () => {
    const result = buildContext(
      [
        candidate(
          'src/config.ts',
          `const key = '${TEST_SECRET}';\nconst gh = 'ghp_abcdefghijklmnopqrstuvwxyz123456';`,
        ),
      ],
      options(),
      TEST_SECRET,
    );

    expect(result.items).to.have.length(1);
    expect(result.items[0].content).to.not.contain(TEST_SECRET);
    expect(result.items[0].content).to.not.contain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(result.items[0].content).to.contain('[REDACTED]');
    expect(result.items[0].redactions).to.be.greaterThan(0);
  });

  test('applies exclusions and redaction together', () => {
    const result = buildContext(
      [candidate('.env', `TOKEN=${TEST_SECRET}`), candidate('src/app.ts', `key: '${TEST_SECRET}'`)],
      options(),
      TEST_SECRET,
    );

    expect(result.items.map((item) => item.path)).to.deep.equal(['src/app.ts']);
    expect(result.skipped).to.deep.equal([{ path: '.env', reason: 'excluded' }]);
  });
});
