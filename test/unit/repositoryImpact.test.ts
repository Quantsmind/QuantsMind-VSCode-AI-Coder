import { expect } from 'chai';
import { validateChangeInputs } from '../../src/changes/model';
import { discoverRepository } from '../../src/repository/discovery';
import { buildDependencyGraph } from '../../src/repository/graph';
import { analyzeChangeImpact, impactSummary } from '../../src/repository/impact';
import { analyzeSourceFile, type FileAnalysis } from '../../src/repository/symbols';

const ENTRIES = [
  { path: 'package.json' },
  { path: 'src/auth.ts' },
  { path: 'src/session.ts' },
  { path: 'src/auth.test.ts' },
];

const PACKAGE_JSON = JSON.stringify({
  name: 'demo',
  scripts: { test: 'mocha', compile: 'tsc -p .' },
});

function analyses(): FileAnalysis[] {
  return [
    analyzeSourceFile('src/auth.ts', 'export function login(): boolean { return true; }\n'),
    analyzeSourceFile(
      'src/session.ts',
      "import { login } from './auth';\nexport function session(): boolean { return login(); }\n",
    ),
    analyzeSourceFile(
      'src/auth.test.ts',
      "import { login } from './auth';\nexport const check = login();\n",
    ),
  ];
}

function overview() {
  return discoverRepository({
    rootName: 'demo',
    entries: ENTRIES,
    configContents: { 'package.json': PACKAGE_JSON },
  });
}

function changes(kind: 'create' | 'modify' = 'modify') {
  return validateChangeInputs([
    {
      kind,
      path: 'src/auth.ts',
      content: 'export function login(): boolean { return false; }\n',
      summary: 'Update login.',
    },
  ]).changes;
}

suite('change impact analysis', () => {
  test('reports direct and indirect files, tests, regression areas, and commands', () => {
    const items = analyses();
    const graph = buildDependencyGraph(items);
    const impact = analyzeChangeImpact(changes(), items, graph, overview(), {
      validationCommands: ['npm test'],
      generatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(impact.directFiles.map((file) => file.path)).to.deep.equal(['src/auth.ts']);
    expect(impact.indirectFiles.map((file) => file.path)).to.include.members([
      'src/session.ts',
      'src/auth.test.ts',
    ]);
    expect(impact.recommendedTests.map((test) => test.path)).to.include('src/auth.test.ts');
    expect(impact.regressionAreas.some((area) => area.path === 'src/auth.ts')).to.equal(true);
    expect(impact.relatedSymbols.some((symbol) => symbol.name === 'login')).to.equal(true);
    expect(impact.validationCommands.map((command) => command.command)).to.include('npm test');
    expect(impact.confidence).to.equal('high');
    expect(impact.limits.truncated).to.equal(false);
    expect(impact.generatedAt).to.equal('2026-01-01T00:00:00.000Z');
    expect(impactSummary(impact)).to.match(/recommended test/);
  });

  test('lowers confidence when a changed file has unresolved local references', () => {
    const items = [
      ...analyses(),
      analyzeSourceFile('src/broken.ts', "import { x } from './nope';\nexport const broken = x;\n"),
    ];
    const graph = buildDependencyGraph(items);
    const broken = validateChangeInputs([
      {
        kind: 'modify',
        path: 'src/broken.ts',
        content: "import { x } from './still-missing';\nexport const broken = x;\n",
        summary: 'Update broken.',
      },
    ]).changes;
    const impact = analyzeChangeImpact(broken, items, graph, overview());

    expect(impact.confidence).to.equal('low');
    expect(impact.evidence.join(' ')).to.match(/heuristic|unresolved/i);
    expect(impact.limits.truncated).to.equal(false);
  });

  test('caps affected files and records truncation', () => {
    const items = [
      ...analyses(),
      ...Array.from({ length: 6 }, (_, index) =>
        analyzeSourceFile(
          `src/consumer${index}.ts`,
          "import { login } from './auth';\nexport const value = login;\n",
        ),
      ),
    ];
    const graph = buildDependencyGraph(items);
    const impact = analyzeChangeImpact(changes(), items, graph, overview(), { maxFiles: 2 });

    expect(impact.indirectFiles).to.have.length(2);
    expect(impact.limits.truncated).to.equal(true);
  });
});
