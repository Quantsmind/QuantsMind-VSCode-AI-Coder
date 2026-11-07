import { expect } from 'chai';
import { validateChangeInputs } from '../../src/changes/model';
import {
  RepositoryIntelligenceService,
  type RepositoryWorkspaceSource,
} from '../../src/repository/repositoryIntelligence';
import type { WorkspaceEntry } from '../../src/workspace/analyze';

function source(files: Record<string, string>): RepositoryWorkspaceSource & {
  readonly files: Record<string, string>;
} {
  return {
    files,
    rootName: () => 'demo',
    listEntries: async (): Promise<readonly WorkspaceEntry[]> =>
      Object.keys(files).map((path) => ({ path, size: files[path]?.length })),
    readText: async (path: string) => files[path],
  };
}

const BASE_FILES: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'demo-app',
    scripts: { test: 'mocha', compile: 'tsc -p .' },
  }),
  'src/a.ts': "import { b } from './b';\nexport function a(): number { return b(); }\n",
  'src/b.ts': 'export function b(): number { return 1; }\n',
  'src/a.test.ts': "import { a } from './a';\nexport const check = a();\n",
};

suite('repository intelligence service', () => {
  test('builds a cached overview, graph, context selection, and impact from a workspace source', async () => {
    const service = new RepositoryIntelligenceService(source({ ...BASE_FILES }));

    const overview = await service.overview();
    expect(overview.rootName).to.equal('demo');
    expect(overview.languages.map((language) => language.name)).to.include('TypeScript');
    expect(overview.buildSystems.some((system) => system.name === 'npm')).to.equal(true);

    const graph = await service.graph();
    expect(graph.nodes.map((node) => node.path)).to.include('src/a.ts');
    expect(graph.edges.some((edge) => edge.from === 'src/a.ts' && edge.to === 'src/b.ts')).to.equal(
      true,
    );

    const selection = await service.selectContext('a', { maxFiles: 5, maxChars: 100_000 });
    expect(selection.selections.map((item) => item.path)).to.include('src/a.ts');

    const changes = validateChangeInputs([
      {
        kind: 'modify',
        path: 'src/a.ts',
        content: 'export function a(): number { return 2; }\n',
        summary: 'Change a.',
      },
    ]).changes;
    const impact = await service.analyzeChanges(changes, ['npm test']);
    expect(impact.directFiles.map((file) => file.path)).to.deep.equal(['src/a.ts']);
    expect(impact.recommendedTests.map((test) => test.path)).to.include('src/a.test.ts');
    expect(impact.validationCommands.map((command) => command.command)).to.include('npm test');

    expect(service.analyzedLanguages()).to.include('typescript');
  });

  test('updates a single file after initial load and removes deleted files', async () => {
    const files = { ...BASE_FILES };
    const service = new RepositoryIntelligenceService(source(files));
    await service.graph();

    files['src/b.ts'] = "import { helper } from './helper';\nexport function b(): number { return helper(); }\n";
    files['src/helper.ts'] = 'export function helper(): number { return 3; }\n';
    await service.updateFile('src/b.ts');
    await service.updateFile('src/helper.ts');
    const graph = await service.graph();
    expect(graph.edges.some((edge) => edge.from === 'src/b.ts' && edge.to === 'src/helper.ts')).to.equal(
      true,
    );

    service.removeFile('src/helper.ts');
    const after = await service.graph();
    expect(after.nodes.some((node) => node.path === 'src/helper.ts')).to.equal(false);
    expect(after.unresolved.some((reference) => reference.from === 'src/b.ts')).to.equal(true);
  });

  test('bounds analyzed files and marks the graph truncated', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `src/file${index}.ts`,
        `export const value${index} = ${index};\n`,
      ]),
    );
    const service = new RepositoryIntelligenceService(source(files), { maxAnalyzedFiles: 3 });

    const graph = await service.graph();
    expect(graph.nodes).to.have.length(3);
    expect(graph.stats.truncated).to.equal(true);
  });

  test('invalidating a manifest re-reads configuration on the next snapshot', async () => {
    const files = { ...BASE_FILES };
    const service = new RepositoryIntelligenceService(source(files));
    expect((await service.overview()).buildSystems.some((system) => system.name === 'npm')).to.equal(
      true,
    );

    files['package.json'] = JSON.stringify({ name: 'demo-app', scripts: { test: 'mocha' } });
    await service.updateFile('package.json');
    const refreshed = await service.overview();
    expect(refreshed.buildSystems.some((system) => system.name === 'npm')).to.equal(true);
  });
});
