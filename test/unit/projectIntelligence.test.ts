import { expect } from 'chai';
import type { RetrievalResult } from '../../src/agent/models';
import {
  ProjectIntelligenceService,
  analyzeProject,
  isProjectConfigPath,
  type ProjectWorkspaceSource,
} from '../../src/project/intelligence';
import type { WorkspaceEntry, WorkspaceSummary } from '../../src/workspace/analyze';
import { TestCancellationToken } from './helpers';

const ENTRIES: WorkspaceEntry[] = [
  { path: 'package.json', size: 900 },
  { path: 'package-lock.json', size: 5_000 },
  { path: 'tsconfig.json', size: 400 },
  { path: '.github/workflows/ci.yml', size: 600 },
  { path: 'src/extension.ts', size: 2_000 },
  { path: 'src/agent/orchestrator.ts', size: 9_000 },
  { path: 'test/unit/orchestrator.test.ts', size: 3_000 },
  { path: 'media/chat.css', size: 4_000 },
  { path: 'README.md', size: 1_200 },
];

const PACKAGE_JSON = JSON.stringify({
  name: 'fixture',
  scripts: { compile: 'tsc -p tsconfig.json', test: 'mocha', 'bad name': 'echo nope' },
  dependencies: { vscode: '^1.95.0' },
  devDependencies: { typescript: '^5.9.3', mocha: '^11.0.0' },
});

suite('project intelligence', () => {
  test('recognizes common configuration files at the root and in nested folders', () => {
    expect(isProjectConfigPath('package.json')).to.equal(true);
    expect(isProjectConfigPath('./tsconfig.build.json')).to.equal(true);
    expect(isProjectConfigPath('.github/workflows/ci.yml')).to.equal(true);
    expect(isProjectConfigPath('packages/core/package.json')).to.equal(true);
    expect(isProjectConfigPath('src/app/eslint.config.mjs')).to.equal(true);
    expect(isProjectConfigPath('src/extension.ts')).to.equal(false);
    expect(isProjectConfigPath('docs/package-json.md')).to.equal(false);
    expect(isProjectConfigPath('')).to.equal(false);
  });

  test('derives package facts, languages, modules and entry points locally', () => {
    const context = analyzeProject({
      rootName: 'fixture',
      entries: ENTRIES,
      configFiles: [
        { path: 'package.json', content: PACKAGE_JSON },
        { path: 'tsconfig.json' },
        { path: '.github/workflows/ci.yml' },
      ],
    });

    expect(context.rootName).to.equal('fixture');
    expect(context.packageManager).to.equal('npm');
    expect(context.scripts.compile).to.equal('tsc -p tsconfig.json');
    expect(context.scripts.test).to.equal('mocha');
    expect(context.scripts['bad name']).to.equal(undefined);
    expect(context.languages.map((language) => language.name)).to.include('TypeScript');
    expect(context.modules.map((module) => module.name)).to.include('src');
    expect(context.entryPoints).to.deep.equal(['src/extension.ts']);
    expect(context.testFiles).to.equal(1);
    expect(context.configFiles).to.include('tsconfig.json');
    expect(context.facts.some((fact) => fact.fact.includes('Package manager detected'))).to.equal(
      true,
    );
    expect(context.summaryText).to.include('Package manager: npm');
    expect(context.summaryText).to.include('Scripts: compile, test');
  });

  test('assumes npm when package.json has no lockfile', () => {
    const context = analyzeProject({
      rootName: 'fixture',
      entries: [{ path: 'package.json', size: 10 }, { path: 'src/index.ts', size: 10 }],
      configFiles: [{ path: 'package.json', content: '{}' }],
    });

    expect(context.packageManager).to.equal('npm');
    expect(context.facts.some((fact) => fact.fact.includes('npm assumed'))).to.equal(true);
  });

  test('reports unparseable package.json without failing analysis', () => {
    const context = analyzeProject({
      rootName: 'fixture',
      entries: [{ path: 'package.json', size: 10 }],
      configFiles: [{ path: 'package.json', content: '{ not json' }],
    });

    expect(context.packageManager).to.equal('npm');
    expect(context.scripts).to.deep.equal({});
    expect(
      context.facts.some((fact) => fact.fact.includes('could not be parsed as JSON')),
    ).to.equal(true);
  });

  test('reads only package.json content through the service', async () => {
    const reads: string[] = [];
    const token = new TestCancellationToken();
    const source: ProjectWorkspaceSource = {
      rootName: 'fixture',
      listEntries: async () => ENTRIES,
      readText: async (path) => {
        reads.push(path);
        return path === 'package.json' ? PACKAGE_JSON : 'SECRET=should-not-be-read';
      },
      retrieve: async () => emptyRetrieval(),
    };

    const context = await new ProjectIntelligenceService(source).inspect(token);

    expect(reads).to.deep.equal(['package.json']);
    expect(context.scripts.compile).to.equal('tsc -p tsconfig.json');
    expect(context.configFiles).to.include('.github/workflows/ci.yml');
    expect(context.configFiles).to.not.include('src/extension.ts');
  });

  test('returns an empty analysis when inspection is cancelled before reading', async () => {
    const token = new TestCancellationToken();
    token.cancel();
    const source: ProjectWorkspaceSource = {
      rootName: 'fixture',
      listEntries: async () => ENTRIES,
      readText: async () => {
        throw new Error('readText must not run after cancellation');
      },
      retrieve: async () => emptyRetrieval(),
    };

    const context = await new ProjectIntelligenceService(source).inspect(token);

    expect(context.summaryText).to.include('0 indexed file(s)');
    expect(context.configFiles).to.deep.equal([]);
    expect(context.languages).to.deep.equal([]);
  });

  test('delegates retrieval unchanged to the workspace source', async () => {
    const expected = emptyRetrieval();
    let received = '';
    const source: ProjectWorkspaceSource = {
      rootName: 'fixture',
      listEntries: async () => [],
      readText: async () => undefined,
      retrieve: async (query) => {
        received = query;
        return expected;
      },
    };

    const result = await new ProjectIntelligenceService(source).retrieve(
      'approval flow',
      new TestCancellationToken(),
    );

    expect(received).to.equal('approval flow');
    expect(result).to.equal(expected);
  });
});

function emptyRetrieval(): RetrievalResult {
  return {
    summary: {} as WorkspaceSummary,
    items: [],
    reasons: {},
    skipped: [],
  };
}
