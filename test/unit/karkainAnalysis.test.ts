import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  analyzeSourceFile,
  isSupportedSourcePath,
  languageForPath,
} from '../../src/repository/symbols';
import {
  analyzeKarkainProject,
  buildKarkainModuleGraph,
  collectKarkainContext,
  isKarkainPath,
  isKarkainProject,
  karkainModuleName,
  resolveKarkainImport,
  summarizeKarkainProject,
  type AnalyzeKarkainProjectInput,
} from '../../src/project/karkain';
import type { WorkspaceEntry } from '../../src/workspace/analyze';

const FIXTURE_ROOT = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'karkain-project');

function readProjectFiles(): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      const relative = path.relative(FIXTURE_ROOT, absolute).split(path.sep).join('/');
      if (relative === 'karkain.toml') {
        continue;
      }
      files.push({ path: relative, content: fs.readFileSync(absolute, 'utf8') });
    }
  };
  walk(FIXTURE_ROOT);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function projectEntries(): WorkspaceEntry[] {
  const files = readProjectFiles();
  return [
    ...files.map((file) => ({ path: file.path, size: file.content.length })),
    { path: 'karkain.toml', size: fs.statSync(path.join(FIXTURE_ROOT, 'karkain.toml')).size },
  ];
}

function fixtureAnalyses() {
  return readProjectFiles().map((file) => analyzeSourceFile(file.path, file.content));
}

function projectFixture(): AnalyzeKarkainProjectInput {
  return {
    rootName: 'karkain-project',
    entries: projectEntries(),
    files: readProjectFiles(),
  };
}

suite('Karkain language detection', () => {
  test('recognizes .kark files as a supported language', () => {
    expect(languageForPath('main.kark')).to.equal('karkain');
    expect(languageForPath('src/deep/module.kark')).to.equal('karkain');
    expect(isSupportedSourcePath('src/module.kark')).to.equal(true);
    expect(isKarkainPath('src/module.kark')).to.equal(true);
    expect(isKarkainPath('src/module.py')).to.equal(false);
  });

  test('detects a Karkain project from sources or a manifest', () => {
    expect(isKarkainProject(projectEntries())).to.equal(true);
    expect(isKarkainProject([{ path: 'src/main.ts' }])).to.equal(false);
    expect(isKarkainProject([], { 'karkain.toml': 'name = "demo"' })).to.equal(true);
  });

  test('derives module names from file basenames', () => {
    expect(karkainModuleName('main.kark')).to.equal('main');
    expect(karkainModuleName('src/mathutils.kark')).to.equal('mathutils');
    expect(karkainModuleName('middleware/auth.kark')).to.equal('auth');
  });
});

suite('Karkain syntax-aware analysis', () => {
  const main = fs.readFileSync(path.join(FIXTURE_ROOT, 'main.kark'), 'utf8');
  const models = fs.readFileSync(path.join(FIXTURE_ROOT, 'models.kark'), 'utf8');
  const mathutils = fs.readFileSync(path.join(FIXTURE_ROOT, 'mathutils.kark'), 'utf8');

  test('extracts functions and imports from a real .kark source', () => {
    const analysis = analyzeSourceFile('main.kark', main);

    expect(analysis.error).to.equal(undefined);
    expect(analysis.language).to.equal('karkain');
    expect(analysis.symbols.map((symbol) => symbol.name)).to.include('main');
    const imports = analysis.imports.map((reference) => reference.specifier);
    expect(imports).to.deep.equal(['mathutils', 'middleware', 'std.io']);
    expect(analysis.imports[0].confidence).to.equal('confirmed');
  });

  test('extracts struct and enum declarations with correct symbol kinds', () => {
    const analysis = analyzeSourceFile('models.kark', models);

    const byName = new Map(analysis.symbols.map((symbol) => [symbol.name, symbol]));
    expect(byName.get('User')?.kind).to.equal('struct');
    expect(byName.get('Role')?.kind).to.equal('enum');
    expect(byName.get('new_user')?.exported).to.equal(true);
  });

  test('honours public visibility for exports', () => {
    const analysis = analyzeSourceFile('mathutils.kark', mathutils);
    const byName = new Map(analysis.symbols.map((symbol) => [symbol.name, symbol]));

    expect(byName.get('square')?.exported).to.equal(false);
    expect(byName.get('magnitude')?.exported).to.equal(true);
    expect(analysis.exports.map((item) => item.name)).to.include('magnitude');
  });

  test('ignores declarations inside line and nested block comments', () => {
    const source = [
      '// func commented_line() { return 1 }',
      '/* func commented_block() { return 1 }',
      '/* nested func commented_nested() { return 1 } */',
      '*/',
      'func real_one() { return 1 }',
    ].join('\n');

    const analysis = analyzeSourceFile('commented.kark', source);
    const names = analysis.symbols.map((symbol) => symbol.name);

    expect(names).to.deep.equal(['real_one']);
  });

  test('ignores declarations inside string literals', () => {
    const source = [
      'func real_one() {',
      '    let text = "func fake() { return 1 }"',
      '    print(text)',
      '    return 1',
      '}',
    ].join('\n');

    const analysis = analyzeSourceFile('strings.kark', source);

    expect(analysis.symbols.map((symbol) => symbol.name)).to.deep.equal(['real_one']);
  });

  test('treats a malformed file as an unsupported path, not a crash', () => {
    const analysis = analyzeSourceFile('binary.kark', 'a\u0000b');

    expect(analysis.error).to.equal('binary-content');
  });
});

suite('Karkain module graph', () => {
  test('resolves sibling files, sibling directories and stdlib modules', () => {
    const knownPaths = ['main.kark', 'mathutils.kark', 'middleware/auth.kark', 'stdlib/io.kark', 'stdlib/net.kark'];

    expect(resolveKarkainImport('mathutils', 'main.kark', knownPaths)?.targets).to.deep.equal(['mathutils.kark']);
    expect(resolveKarkainImport('middleware', 'main.kark', knownPaths)?.targets).to.deep.equal(['middleware/auth.kark']);
    expect(resolveKarkainImport('std.io', 'main.kark', knownPaths)?.targets).to.deep.equal(['stdlib/io.kark']);
    expect(resolveKarkainImport('missing', 'main.kark', knownPaths)?.targets).to.deep.equal([]);
  });

  test('builds edges, ordering, and reports no false cycles', () => {
    const graph = buildKarkainModuleGraph(fixtureAnalyses());

    const edgeKeys = graph.edges.map((edge) => `${edge.from}->${edge.to}`);
    expect(edgeKeys).to.include('main->mathutils');
    expect(edgeKeys).to.include('main->io');
    expect(edgeKeys).to.include('main->auth');
    expect(edgeKeys).to.include('auth->net');
    expect(edgeKeys).to.include('net->io');
    expect(edgeKeys).to.include('auth->net');

    const order = graph.order;
    expect(order.indexOf('mathutils.kark')).to.be.lessThan(order.indexOf('tests/test_math.kark'));
    expect(order.indexOf('mathutils.kark')).to.be.lessThan(order.indexOf('main.kark'));
    expect(order.indexOf('stdlib/io.kark')).to.be.lessThan(order.indexOf('stdlib/net.kark'));
    expect(order[order.length - 1]).to.equal('main.kark');

    expect(graph.cycles).to.deep.equal([]);
    expect(graph.unresolved).to.deep.equal([]);
    expect(graph.root).to.equal('main');
  });

  test('reports unresolved modules instead of guessing', () => {
    const analyses = [
      analyzeSourceFile('a.kark', 'import definitely_missing\nfunc a() { return 1 }'),
    ];

    const graph = buildKarkainModuleGraph(analyses);

    expect(graph.unresolved).to.have.length(1);
    expect(graph.unresolved[0].name).to.equal('definitely_missing');
    expect(graph.unresolved[0].from).to.equal('a');
  });

  test('detects import cycles deterministically', () => {
    const analyses = [
      analyzeSourceFile('a.kark', 'import b\nfunc a() { return 1 }'),
      analyzeSourceFile('b.kark', 'import a\nfunc b() { return 1 }'),
    ];

    const graph = buildKarkainModuleGraph(analyses);

    expect(graph.cycles.length).to.equal(1);
    expect([...graph.cycles[0]].sort()).to.deep.equal(['a.kark', 'a.kark', 'b.kark']);
  });

  test('main.kark is reachable as the entry module', () => {
    const graph = buildKarkainModuleGraph(fixtureAnalyses());

    expect(graph.root).to.equal('main');
    expect(graph.modules.map((module) => module.name)).to.include('main');
  });
});

suite('Karkain project analysis', () => {
  test('analyzes a fixture project end to end', () => {
    const result = analyzeKarkainProject(projectFixture());

    expect(result.summary.isKarkainProject).to.equal(true);
    expect(result.summary.fileCount).to.be.greaterThan(5);
    expect(result.summary.entryPoints).to.deep.equal(['main.kark']);
    expect(result.summary.testFiles).to.include('tests/test_math.kark');
    const typeNames = result.summary.types.map((type) => type.name);
    expect(typeNames).to.include('User');
    expect(typeNames).to.include('Role');
  });

  test('collects relevant multi-file context for a query', () => {
    const analyses = fixtureAnalyses();
    const result = collectKarkainContext('square mathutils', analyses, { maxFiles: 4 });

    expect(result.files.length).to.be.greaterThan(0);
    expect(result.files.map((file) => file.path)).to.include('mathutils.kark');
    expect(result.summaryText).to.contain('Karkain context');
    const moduleOrder = result.moduleOrder;
    expect(moduleOrder).to.deep.equal([...new Set(moduleOrder)]);
  });

  test('context expansion includes module dependencies of selected files', () => {
    const analyses = fixtureAnalyses();
    const result = collectKarkainContext('main', analyses, { maxFiles: 5 });

    expect(result.files.map((file) => file.path)).to.include('main.kark');
    expect(result.files.map((file) => file.path)).to.include('mathutils.kark');
  });

  test('summarizeKarkainProject reports module and import statistics', () => {
    const analyses = fixtureAnalyses();
    const graph = buildKarkainModuleGraph(analyses);
    const summary = summarizeKarkainProject('karkain-project', analyses, graph);

    expect(summary.isKarkainProject).to.equal(true);
    expect(summary.moduleCount).to.equal(analyses.length);
    expect(summary.summaryText).to.contain('Karkain project karkain-project');
    expect(summary.technologies).to.include('Karkain');
  });
});
