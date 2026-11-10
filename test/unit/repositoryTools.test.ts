import { expect } from 'chai';
import { RepositoryTools } from '../../src/agent/repositoryTools';

suite('repository tools', () => {
  test('returns a repository overview', async () => {
    const intelligence = {
      async overview() {
        return {
          rootName: 'repo',
          fileCount: 10,
          sourceFileCount: 8,
          testFileCount: 2,
          languages: [{ name: 'TypeScript' }],
          technologies: [{ name: 'Node.js' }],
          entryPoints: ['src/index.ts'],
          manifests: [{ path: 'package.json' }],
          buildSystems: [{ name: 'npm' }],
        } as any;
      },
      async selectContext() {
        return { selections: [], truncated: false, budgetChars: 1000 };
      },
    };
    const tools = new RepositoryTools(intelligence as any);
    const tool = tools.toAgentTools().find((item) => item.name === 'get_repository_overview')!;
    const result = await tool.execute({});

    expect(result.ok).to.equal(true);
    expect(result.output).to.contain('TypeScript');
    expect(result.output).to.contain('src/index.ts');
  });

  test('selects repository context for a query', async () => {
    const intelligence = {
      async overview() {
        return { rootName: 'repo', fileCount: 1, sourceFileCount: 1, testFileCount: 0, languages: [], technologies: [], entryPoints: [], manifests: [], buildSystems: [] } as any;
      },
      async selectContext(_query: string, options: any) {
        return {
          truncated: false,
          budgetChars: options.maxChars,
          selections: [{ path: 'src/a.ts', score: 5, reason: 'matches query', relationship: 'query', confidence: 'high' }],
        };
      },
    };
    const tools = new RepositoryTools(intelligence as any);
    const tool = tools.toAgentTools().find((item) => item.name === 'select_repository_context')!;
    const result = await tool.execute({ query: 'needle', maxFiles: 3, maxChars: 2000 });

    expect(result.ok).to.equal(true);
    expect(result.output).to.contain('src/a.ts');
    expect(result.output).to.contain('matches query');
  });

  test('rejects an empty context query', async () => {
    const intelligence = {
      async overview() { return {} as any; },
      async selectContext() { return { selections: [], truncated: false, budgetChars: 1 }; },
    };
    const tools = new RepositoryTools(intelligence as any);
    const tool = tools.toAgentTools().find((item) => item.name === 'select_repository_context')!;
    const result = await tool.execute({ query: '' });

    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('A query is required');
  });

  test('finds symbols', async () => {
    const intelligence = {
      async overview() { return {} as any; },
      async selectContext() { return { selections: [], truncated: false, budgetChars: 1 }; },
      async analyzeChanges() { return {}; },
      async findSymbols(_query: string) {
        return [{ path: 'src/a.ts', name: 'needle', kind: 'function', line: 3, exported: true, confidence: 'confirmed' }];
      },
    };
    const tools = new RepositoryTools(intelligence as any);
    const tool = tools.toAgentTools().find((item) => item.name === 'find_symbols')!;
    const result = await tool.execute({ query: 'needle' });

    expect(result.ok).to.equal(true);
    expect(result.output).to.contain('needle');
    expect(result.output).to.contain('src/a.ts');
  });

  test('rejects an empty symbol query', async () => {
    const intelligence = {
      async overview() { return {} as any; },
      async selectContext() { return { selections: [], truncated: false, budgetChars: 1 }; },
      async analyzeChanges() { return {}; },
      async findSymbols() { return []; },
    };
    const tools = new RepositoryTools(intelligence as any);
    const tool = tools.toAgentTools().find((item) => item.name === 'find_symbols')!;
    const result = await tool.execute({ query: '' });

    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('A query is required');
  });

  test('analyzes change impact', async () => {
    const intelligence = {
      async overview() { return {} as any; },
      async selectContext() { return { selections: [], truncated: false, budgetChars: 1 }; },
      async analyzeChanges(changes: any, commands: any) {
        return { directFiles: changes.map((change: any) => change.path), validationCommands: commands, confidence: 'high' };
      },
    };
    const tools = new RepositoryTools(intelligence as any);
    const tool = tools.toAgentTools().find((item) => item.name === 'analyze_change_impact')!;
    const result = await tool.execute({ changes: [{ kind: 'modify', path: 'src/a.ts', summary: 'change' }], validationCommands: ['npm run test:unit'] });

    expect(result.ok).to.equal(true);
    expect(result.output).to.contain('src/a.ts');
    expect(result.output).to.contain('npm run test:unit');
  });

  test('rejects impact analysis without changes', async () => {
    const intelligence = {
      async overview() { return {} as any; },
      async selectContext() { return { selections: [], truncated: false, budgetChars: 1 }; },
      async analyzeChanges() { return {}; },
    };
    const tools = new RepositoryTools(intelligence as any);
    const tool = tools.toAgentTools().find((item) => item.name === 'analyze_change_impact')!;
    const result = await tool.execute({ changes: [] });

    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('At least one change is required');
  });
});
