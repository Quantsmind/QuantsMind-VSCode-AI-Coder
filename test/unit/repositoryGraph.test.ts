import { expect } from 'chai';
import {
  DependencyGraphBuilder,
  buildDependencyGraph,
  directDependencies,
  directDependents,
  traverseDependencies,
} from '../../src/repository/graph';
import { analyzeSourceFile, type FileAnalysis } from '../../src/repository/symbols';

function analysis(path: string, content: string): FileAnalysis {
  return analyzeSourceFile(path, content);
}

function fixture(): FileAnalysis[] {
  return [
    analysis('src/a.ts', "import { b } from './b';\nexport function a(): number { return b(); }\n"),
    analysis('src/b.ts', "import { a } from './a';\nexport function b(): number { return 1; }\n"),
    analysis('src/c.ts', "import { missing } from './missing';\nexport const c = missing;\n"),
    analysis('src/d.ts', "import React from 'react';\nexport const d = React;\n"),
  ];
}

suite('dependency graph', () => {
  test('resolves relative imports exactly and keeps external imports out of edges', () => {
    const graph = buildDependencyGraph(fixture());

    const aToB = directDependencies(graph, 'src/a.ts');
    expect(aToB).to.have.length(1);
    expect(aToB[0]?.to).to.equal('src/b.ts');
    expect(aToB[0]?.confidence).to.equal('confirmed');
    expect(directDependents(graph, 'src/b.ts').map((edge) => edge.from)).to.include('src/a.ts');

    expect(graph.edges.some((edge) => edge.to === 'react')).to.equal(false);
    expect(graph.nodes.find((node) => node.path === 'src/d.ts')?.externalImports).to.include('react');
  });

  test('records unresolved local references and detects cycles', () => {
    const graph = buildDependencyGraph(fixture());

    expect(graph.unresolved.some((reference) => reference.specifier === './missing')).to.equal(true);
    expect(graph.stats.unresolvedCount).to.be.at.least(1);
    expect(graph.cycles.some((cycle) => cycle.includes('src/a.ts') && cycle.includes('src/b.ts'))).to.equal(
      true,
    );
    expect(graph.stats.cycleCount).to.be.at.least(1);
  });

  test('traverses upstream and downstream within a bounded depth', () => {
    const graph = buildDependencyGraph(fixture());
    const forward = traverseDependencies(graph, ['src/b.ts'], {
      depth: 1,
      direction: 'dependencies',
    });
    expect(forward.files.map((file) => file.path)).to.include('src/a.ts');

    const reverse = traverseDependencies(graph, ['src/b.ts'], {
      depth: 1,
      direction: 'dependents',
    });
    expect(reverse.files.map((file) => file.path)).to.include('src/a.ts');

    const bounded = traverseDependencies(graph, ['src/a.ts'], { depth: 1, maxNodes: 1 });
    expect(bounded.files).to.have.length(1);
    expect(bounded.truncated).to.equal(false);
  });

  test('re-analyzes only the changed file and re-resolves the new edge', () => {
    const builder = new DependencyGraphBuilder();
    for (const item of fixture()) {
      builder.upsert(item);
    }
    const initial = builder.snapshot();
    expect(initial.unresolved.some((reference) => reference.from === 'src/c.ts')).to.equal(true);

    builder.upsert(
      analysis('src/c.ts', "import { b } from './b';\nexport const c = b;\n"),
    );
    const updated = builder.snapshot();
    expect(updated.edges.some((edge) => edge.from === 'src/c.ts' && edge.to === 'src/b.ts')).to.equal(
      true,
    );
    expect(updated.unresolved.some((reference) => reference.from === 'src/c.ts')).to.equal(false);

    builder.remove('src/b.ts');
    const removed = builder.snapshot();
    expect(removed.nodes.some((node) => node.path === 'src/b.ts')).to.equal(false);
    expect(removed.unresolved.some((reference) => reference.from === 'src/c.ts')).to.equal(true);
  });

  test('enforces node limits and marks truncated output', () => {
    const builder = new DependencyGraphBuilder({ maxNodes: 2 });
    for (const item of fixture()) {
      builder.upsert(item);
    }
    const graph = builder.snapshot();
    expect(graph.nodes).to.have.length(2);
    expect(graph.stats.truncated).to.equal(true);
  });
});
