import { expect } from 'chai';
import { SettingsService } from '../../src/config/settings';
import { Logger } from '../../src/security/logger';
import { WorkspaceIndexService } from '../../src/workspace/indexService';

suite('workspace index and retrieval', () => {
  const settings = new SettingsService();
  const logs: string[] = [];
  const logger = new Logger({ appendLine: (line) => logs.push(line) });

  setup(() => {
    logs.length = 0;
  });

  test('indexes workspace files while excluding secrets and credential stores', async () => {
    const index = new WorkspaceIndexService(settings, logger);
    const entries = await index.getEntries();
    const paths = entries.map((entry) => entry.path);

    expect(paths).to.include('README.md');
    expect(paths).to.include('src/example.ts');
    expect(paths).to.include('src/utils.ts');
    expect(paths).to.not.include('.env');
    expect(paths.some((path) => path.includes('secrets/'))).to.equal(false);
    expect(paths.some((path) => path.includes('credentials.json'))).to.equal(false);
    expect(logs.some((line) => line.includes('workspace index built'))).to.equal(true);
  });

  test('summarizes the workspace without reading file contents', async () => {
    const index = new WorkspaceIndexService(settings, logger);
    const summary = await index.summarize();

    expect(summary.rootName).to.equal('workspace');
    expect(summary.fileCount).to.be.at.least(3);
    expect(summary.technologies.some((item) => item.name === 'TypeScript')).to.equal(true);
    expect(summary.text).to.contain('Workspace workspace:');
    expect(summary.text).to.contain('TypeScript');
  });

  test('retrieves only relevant files and redacts credential-shaped content', async () => {
    const index = new WorkspaceIndexService(settings, logger);
    const result = await index.retrieve('greeting example');

    const example = result.items.find((item) => item.path === 'src/example.ts');
    expect(example).to.not.equal(undefined);
    expect(example?.content).to.contain('export function greet');
    expect(example?.content).to.not.contain('sk-demo-not-a-real-key-000000000000');
    expect(example?.redactions).to.be.greaterThan(0);
    expect(result.reasons['src/example.ts']).to.be.a('string');
    expect(result.items.some((item) => item.path === '.env')).to.equal(false);
  });

  test('returns the cached index until it is invalidated', async () => {
    const index = new WorkspaceIndexService(settings, logger);
    const first = await index.getEntries();
    index.invalidate();
    const second = await index.getEntries();
    expect(second.map((entry) => entry.path)).to.deep.equal(first.map((entry) => entry.path));
  });

  test('builds repository intelligence from the indexed workspace', async () => {
    const index = new WorkspaceIndexService(settings, logger);
    const overview = await index.repositoryOverview();
    expect(overview).to.not.equal(undefined);
    expect(overview?.languages.map((language) => language.name)).to.include('TypeScript');
    expect(overview?.sourceFileCount).to.be.at.least(2);

    const graph = await index.dependencyGraph();
    expect(graph).to.not.equal(undefined);
    expect(graph?.nodes.map((node) => node.path)).to.include.members([
      'src/example.ts',
      'src/utils.ts',
    ]);

    const { validateChangeInputs } = await import('../../src/changes/model');
    const changes = validateChangeInputs([
      {
        kind: 'modify',
        path: 'src/utils.ts',
        content: 'export function sum(values: readonly number[]): number { return values.length; }\n',
        summary: 'Change sum.',
      },
    ]).changes;
    const impact = await index.analyzeChangeImpact(changes, []);
    expect(impact?.directFiles.map((file) => file.path)).to.deep.equal(['src/utils.ts']);
    expect(impact?.confidence).to.be.oneOf(['high', 'medium', 'low']);
  });

  test('blocks repository intelligence in restricted mode', async () => {
    const restricted = new WorkspaceIndexService(settings, logger, () => false);
    expect(await restricted.repositoryOverview()).to.equal(undefined);
    expect(await restricted.dependencyGraph()).to.equal(undefined);
    expect(await restricted.selectRepositoryContext('example', { maxFiles: 3, maxChars: 1000 })).to.equal(
      undefined,
    );
    expect(await restricted.analyzeChangeImpact([], [])).to.equal(undefined);
  });
});
