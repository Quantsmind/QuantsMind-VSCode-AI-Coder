import { expect } from 'chai';
import {
  buildWorkspaceSummary,
  detectTechnologies,
  entryPointsOf,
  isTestPath,
  normalizeWorkspacePath,
  rankRelevantFiles,
  type WorkspaceEntry,
} from '../../src/workspace/analyze';

const ENTRIES: WorkspaceEntry[] = [
  { path: 'package.json', size: 1_000 },
  { path: 'tsconfig.json', size: 500 },
  { path: 'src/extension.ts', size: 2_000 },
  { path: 'src/chat/chatViewProvider.ts', size: 12_000 },
  { path: 'src/chat/persistence.ts', size: 6_000 },
  { path: 'test/unit/chat.test.ts', size: 3_000 },
  { path: 'test/unit/provider.test.ts', size: 3_000 },
  { path: 'src/providers/openai.ts', size: 8_000 },
  { path: 'docs/readme.md', size: 1_500 },
  { path: 'src/oversized.ts', size: 500_000 },
];

suite('workspace analysis', () => {
  test('normalizes separators and leading path noise', () => {
    expect(normalizeWorkspacePath('.\\src\\chat\\provider.ts')).to.equal('src/chat/provider.ts');
    expect(normalizeWorkspacePath('./src//chat///provider.ts')).to.equal('src/chat/provider.ts');
    expect(normalizeWorkspacePath('/src/index.ts')).to.equal('src/index.ts');
  });

  test('recognizes test paths across common conventions', () => {
    expect(isTestPath('test/unit/provider.test.ts')).to.equal(true);
    expect(isTestPath('src/__tests__/thing.ts')).to.equal(true);
    expect(isTestPath('pkg/specs/thing.js')).to.equal(true);
    expect(isTestPath('src/provider.spec.ts')).to.equal(true);
    expect(isTestPath('tests/test_helpers.py')).to.equal(true);
    expect(isTestPath('src/provider.ts')).to.equal(false);
    expect(isTestPath('contest/entry.ts')).to.equal(false);
  });

  test('detects entry points in priority order', () => {
    expect(entryPointsOf(ENTRIES)).to.deep.equal(['src/extension.ts']);
    const many: WorkspaceEntry[] = [
      { path: 'src/index.ts' },
      { path: 'src/main.ts' },
      { path: 'main.py' },
    ];
    expect(entryPointsOf(many)).to.deep.equal(['src/main.ts', 'src/index.ts', 'main.py']);
  });

  test('detects languages and project markers with counts', () => {
    const technologies = detectTechnologies(ENTRIES);
    const typescript = technologies.find((item) => item.name === 'TypeScript');
    expect(typescript?.kind).to.equal('language');
    expect(typescript?.files).to.equal(7);
    expect(technologies.some((item) => item.name === 'Node.js' && item.kind === 'tooling')).to.equal(
      true,
    );
    expect(
      technologies.some((item) => item.name === 'TypeScript' && item.kind === 'tooling'),
    ).to.equal(true);
    expect(detectTechnologies([])).to.deep.equal([]);
  });

  test('summarizes file counts, top-level entries, and test files', () => {
    const summary = buildWorkspaceSummary('Demo', ENTRIES);
    expect(summary.rootName).to.equal('Demo');
    expect(summary.fileCount).to.equal(ENTRIES.length);
    expect(summary.entryPoints).to.deep.equal(['src/extension.ts']);
    expect(summary.testFiles).to.equal(2);
    expect(summary.topLevel[0]).to.deep.equal({ name: 'src', files: 5 });
    expect(summary.text).to.contain('Workspace Demo: 10 indexed files.');
    expect(summary.text).to.contain('TypeScript (7)');
    expect(summary.text).to.contain('Likely entry points: src/extension.ts.');
  });

  test('reports an empty workspace without inventing technologies', () => {
    const summary = buildWorkspaceSummary('Empty', []);
    expect(summary.fileCount).to.equal(0);
    expect(summary.technologies).to.deep.equal([]);
    expect(summary.text).to.contain('Languages: none detected');
  });

  test('ranks file-name matches above path-only matches', () => {
    const ranked = rankRelevantFiles('fix chat view provider', ENTRIES, { maxFiles: 3 });
    expect(ranked.length).to.be.greaterThan(0);
    expect(ranked[0].path).to.equal('src/chat/chatViewProvider.ts');
    expect(ranked[0].reason).to.contain('file name matches the request');
  });

  test('never returns more files than requested and backs off with entry points', () => {
    const ranked = rankRelevantFiles('unrelated wording', ENTRIES, { maxFiles: 2 });
    expect(ranked).to.have.length(2);
    expect(ranked[0].path).to.equal('src/extension.ts');
    expect(ranked[0].reason).to.contain('likely entry point');
  });

  test('penalizes oversized files and rewards tests only when requested', () => {
    const normal = rankRelevantFiles('oversized', ENTRIES, { maxFiles: 20 });
    const oversized = normal.find((item) => item.path === 'src/oversized.ts');
    // +6 for the file-name match, -2 for exceeding the size heuristic.
    expect(oversized?.score).to.equal(4);

    const wantsTests = rankRelevantFiles('fix provider tests', ENTRIES, { maxFiles: 5 });
    const testPath = wantsTests.find((item) => item.path === 'test/unit/provider.test.ts');
    expect(testPath?.reason).to.contain('test file');
  });

  test('honors a zero file limit', () => {
    expect(rankRelevantFiles('chat', ENTRIES, { maxFiles: 0 })).to.deep.equal([]);
  });
});
