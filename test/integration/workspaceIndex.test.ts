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

  test('exposes entry-point and test-path helpers', async () => {
    const index = new WorkspaceIndexService(settings, logger);
    expect(await index.entryPoints()).to.deep.equal([]);
    expect(await index.isTestOnly('src/example.ts')).to.equal(false);
    expect(await index.isTestOnly('test/example.test.ts')).to.equal(true);
  });
});
