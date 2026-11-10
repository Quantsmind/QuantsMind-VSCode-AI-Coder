import { isTestPath, normalizeWorkspacePath } from '../workspace/analyze';
import type { FileChange } from '../changes/model';
import {
  directDependencies,
  directDependents,
  traverseDependencies,
  type DependencyGraph,
} from './graph';
import type { RepositoryOverview } from './discovery';
import {
  analyzeSourceFile,
  languageForPath,
  type Confidence,
  type FileAnalysis,
  type SymbolKind,
} from './symbols';

export type ImpactConfidence = 'high' | 'medium' | 'low';

export interface ImpactedFile {
  readonly path: string;
  readonly relationship: 'changed' | 'dependency' | 'dependent' | 'test' | 'module';
  readonly distance: number;
  readonly confidence: Confidence;
  readonly reason: string;
}

export interface ImpactedSymbol {
  readonly path: string;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly changeId?: string;
  readonly relationship: 'changed' | 'added' | 'removed' | 'exported';
  readonly confidence: Confidence;
}

export interface RegressionArea {
  readonly path: string;
  readonly risk: 'high' | 'medium' | 'low';
  readonly reason: string;
  readonly evidence: readonly string[];
}

export interface RecommendedTest {
  readonly path: string;
  readonly reason: string;
  readonly confidence: Confidence;
}

export interface ValidationCommandSuggestion {
  readonly command: string;
  readonly source: string;
  readonly confidence: Confidence;
}

export interface ChangeImpact {
  readonly directFiles: readonly ImpactedFile[];
  readonly indirectFiles: readonly ImpactedFile[];
  readonly relatedSymbols: readonly ImpactedSymbol[];
  readonly relatedModules: readonly string[];
  readonly regressionAreas: readonly RegressionArea[];
  readonly recommendedTests: readonly RecommendedTest[];
  readonly validationCommands: readonly ValidationCommandSuggestion[];
  readonly confidence: ImpactConfidence;
  readonly evidence: readonly string[];
  readonly generatedAt: string;
  readonly limits: {
    readonly maxDepth: number;
    readonly maxFiles: number;
    readonly truncated: boolean;
  };
}

export interface ImpactOptions {
  readonly maxDepth?: number;
  readonly maxFiles?: number;
  readonly validationCommands?: readonly string[];
  readonly generatedAt?: string;
}

const MAX_RELATED_SYMBOLS = 60;
const MAX_RECOMMENDED_TESTS = 10;
const MAX_VALIDATION_COMMANDS = 8;
const MAX_EVIDENCE = 20;

function normalize(path: string): string {
  return normalizeWorkspacePath(path);
}

function extensionless(path: string): string {
  const name = normalize(path).split('/').pop() ?? normalize(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

function testStem(path: string): string {
  return extensionless(path)
    .replace(/\.(?:test|spec)$/i, '')
    .replace(/^(?:test_|spec_)/i, '')
    .replace(/_test$/i, '');
}

function confidenceRank(confidence: Confidence): number {
  return confidence === 'confirmed' ? 0 : 1;
}

function uniqueById<T>(items: readonly T[], id: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = id(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function proposalAnalysis(change: FileChange): FileAnalysis | undefined {
  if ((change.kind === 'create' || change.kind === 'modify') && typeof change.content === 'string') {
    if (languageForPath(change.path) === undefined) {
      return undefined;
    }
    return analyzeSourceFile(change.path, change.content, { maxFileChars: 200_000 });
  }
  return undefined;
}

function symbolsForImpact(
  changes: readonly FileChange[],
  analysisByPath: ReadonlyMap<string, FileAnalysis>,
): ImpactedSymbol[] {
  const result: ImpactedSymbol[] = [];
  for (const change of changes) {
    const current = analysisByPath.get(normalize(change.path));
    const proposed = proposalAnalysis(change);
    if (change.kind === 'delete') {
      for (const symbol of current?.symbols ?? []) {
        result.push({
          path: normalize(change.path),
          name: symbol.name,
          kind: symbol.kind,
          changeId: change.id,
          relationship: 'removed',
          confidence: symbol.confidence,
        });
      }
      continue;
    }
    if (proposed === undefined) {
      for (const symbol of current?.symbols ?? []) {
        result.push({
          path: normalize(change.path),
          name: symbol.name,
          kind: symbol.kind,
          changeId: change.id,
          relationship: 'changed',
          confidence: symbol.confidence,
        });
      }
      continue;
    }
    const currentNames = new Map((current?.symbols ?? []).map((symbol) => [symbol.name, symbol]));
    const proposedNames = new Set(proposed.symbols.map((symbol) => symbol.name));
    for (const symbol of proposed.symbols) {
      const before = currentNames.get(symbol.name);
      result.push({
        path: normalize(change.path),
        name: symbol.name,
        kind: symbol.kind,
        changeId: change.id,
        relationship: before === undefined ? 'added' : 'changed',
        confidence: symbol.confidence,
      });
    }
    for (const symbol of current?.symbols ?? []) {
      if (!proposedNames.has(symbol.name)) {
        result.push({
          path: normalize(change.path),
          name: symbol.name,
          kind: symbol.kind,
          changeId: change.id,
          relationship: 'removed',
          confidence: symbol.confidence,
        });
      }
    }
  }
  return result
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.name.localeCompare(right.name) ||
        left.relationship.localeCompare(right.relationship),
    )
    .slice(0, MAX_RELATED_SYMBOLS);
}

function moduleNamesFor(
  paths: readonly string[],
  overview: RepositoryOverview,
): string[] {
  const modules = overview.modules
    .filter((module) =>
      paths.some(
        (path) => module.path === '.' || path === module.path || path.startsWith(`${module.path}/`),
      ),
    )
    .map((module) => module.name);
  return [...new Set(modules)].slice(0, 8);
}

function recommendedTestsFor(
  directPaths: ReadonlySet<string>,
  impactedPaths: ReadonlySet<string>,
  analyses: readonly FileAnalysis[],
  graph: DependencyGraph,
): RecommendedTest[] {
  const directStems = new Set([...directPaths].map((path) => extensionless(path).toLowerCase()));
  const directTestStems = new Set([...directPaths].map((path) => testStem(path).toLowerCase()));
  const candidates = analyses.filter((analysis) => isTestPath(analysis.path));
  const ranked: (RecommendedTest & { readonly score: number })[] = [];
  for (const analysis of candidates) {
    let score = 0;
    const reasons: string[] = [];
    const path = analysis.path;
    const stem = testStem(path).toLowerCase();
    const directEdges = graph.edges.filter(
      (edge) =>
        (edge.from === path && directPaths.has(edge.to)) ||
        (edge.to === path && directPaths.has(edge.from)),
    );
    if (directEdges.length > 0) {
      score += 8;
      reasons.push(
        `test imports or is imported by ${directEdges
          .map((edge) => (edge.from === path ? edge.to : edge.from))
          .slice(0, 2)
          .join(', ')}`,
      );
    }
    if (directStems.has(stem) || directTestStems.has(stem)) {
      score += 6;
      reasons.push('test name matches the changed file');
    }
    if ([...directPaths].some((changed) => changed.split('/').slice(0, -1).join('/') === path.split('/').slice(0, -1).join('/'))) {
      score += 2;
      reasons.push('test is in the same directory as a changed file');
    }
    if ([...impactedPaths].some((changed) => graph.edges.some((edge) => edge.from === path && edge.to === changed))) {
      score += 3;
      reasons.push('test references an indirectly affected file');
    }
    if (score > 0) {
      ranked.push({
        path,
        reason: reasons.join('; '),
        confidence: directEdges.length > 0 ? 'confirmed' : 'heuristic',
        score,
      });
    }
  }
  return ranked
    .sort(
      (left, right) =>
        right.score - left.score ||
        confidenceRank(left.confidence) - confidenceRank(right.confidence) ||
        left.path.localeCompare(right.path),
    )
    .slice(0, MAX_RECOMMENDED_TESTS)
    .map(({ path, reason, confidence }) => ({ path, reason, confidence }));
}

function validationCommandsFor(
  overview: RepositoryOverview,
  impactedLanguages: ReadonlySet<string>,
  provided: readonly string[],
): ValidationCommandSuggestion[] {
  const result: ValidationCommandSuggestion[] = [];
  for (const command of provided) {
    const trimmed = command.trim();
    if (trimmed.length > 0 && trimmed.length <= 300) {
      result.push({ command: trimmed, source: 'session allowlist', confidence: 'confirmed' });
    }
  }
  for (const system of overview.buildSystems) {
    const relevant =
      system.commands.length > 0 &&
      (system.manifest === 'package.json' ||
        (system.name === 'Python tests' && impactedLanguages.has('Python')) ||
        (system.name === 'Go modules' && impactedLanguages.has('Go')) ||
        (system.name === 'Maven' && impactedLanguages.has('Java')) ||
        (system.name === 'Gradle' && impactedLanguages.has('Java')) ||
        (system.name === 'CMake' && (impactedLanguages.has('C') || impactedLanguages.has('C++'))) ||
        (system.name === 'Make' && (impactedLanguages.has('C') || impactedLanguages.has('C++'))) ||
        (system.name === 'TypeScript compiler' && (impactedLanguages.has('TypeScript') || impactedLanguages.has('JavaScript'))));
    if (!relevant) {
      continue;
    }
    for (const command of system.commands.slice(0, 3)) {
      result.push({
        command,
        source: `${system.name} manifest`,
        confidence: system.confidence,
      });
    }
  }
  return uniqueById(result, (item) => item.command).slice(0, MAX_VALIDATION_COMMANDS);
}

/**
 * Produces a bounded, evidence-backed impact assessment for a proposed change
 * set. Relationships carry their own confidence; the aggregate confidence is
 * lowered whenever a direct relationship is unresolved or the graph was
 * truncated.
 */
export function analyzeChangeImpact(
  changes: readonly FileChange[],
  analyses: readonly FileAnalysis[],
  graph: DependencyGraph,
  overview: RepositoryOverview,
  options: ImpactOptions = {},
): ChangeImpact {
  const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 2, 4));
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 80, 200));
  const analysisByPath = new Map(analyses.map((analysis) => [normalize(analysis.path), analysis]));
  const directPaths = new Set<string>();
  const directFiles: ImpactedFile[] = [];
  for (const change of changes) {
    const path = normalize(change.path);
    if (path.length === 0) {
      continue;
    }
    const reason = `${change.kind}: ${change.summary || 'planned change'}`;
    if (!directPaths.has(path)) {
      directPaths.add(path);
      directFiles.push({
        path,
        relationship: 'changed',
        distance: 0,
        confidence: analysisByPath.has(path) || change.kind === 'create' ? 'confirmed' : 'heuristic',
        reason,
      });
    }
    if (change.kind === 'rename' && change.fromPath !== undefined) {
      const from = normalize(change.fromPath);
      if (from.length > 0 && !directPaths.has(from)) {
        directPaths.add(from);
        directFiles.push({
          path: from,
          relationship: 'changed',
          distance: 0,
          confidence: 'heuristic',
          reason: `rename source for ${path}`,
        });
      }
    }
  }

  const traversal = traverseDependencies(graph, [...directPaths], {
    depth: maxDepth,
    maxNodes: maxFiles,
    direction: 'both',
  });
  const indirectFiles: ImpactedFile[] = traversal.files
    .filter((file) => !directPaths.has(file.path))
    .map((file) => ({
      path: file.path,
      relationship: isTestPath(file.path) ? 'test' : file.direction,
      distance: file.distance,
      confidence: file.confidence,
      reason:
        file.direction === 'dependent'
          ? `imports or references ${file.via}`
          : `is imported by ${file.via}`,
    }));

  const impactedPaths = new Set([...directPaths, ...indirectFiles.map((file) => file.path)]);
  const relatedSymbols = symbolsForImpact(changes, analysisByPath);
  for (const path of directPaths) {
    const analysis = analysisByPath.get(path);
    for (const symbol of analysis?.symbols ?? []) {
      if (symbol.exported) {
        relatedSymbols.push({
          path,
          name: symbol.name,
          kind: symbol.kind,
          relationship: 'exported',
          confidence: symbol.confidence,
        });
      }
    }
  }
  const boundedSymbols = uniqueById(relatedSymbols, (symbol) => `${symbol.path}:${symbol.name}:${symbol.relationship}`).slice(
    0,
    MAX_RELATED_SYMBOLS,
  );

  const regressionAreas: RegressionArea[] = [];
  for (const path of directPaths) {
    const dependents = directDependents(graph, path);
    const dependencies = directDependencies(graph, path);
    const testFiles = indirectFiles.filter((file) => file.relationship === 'test');
    const analysis = analysisByPath.get(path);
    const evidence = [
      `${dependents.length} direct dependent(s)`,
      `${dependencies.length} direct dependency(ies)`,
      analysis?.publicApi === true ? 'public API boundary' : '',
      dependents.some((edge) => edge.confidence === 'heuristic') ? 'dependent relationship is heuristic' : '',
      testFiles.length > 0 ? `${testFiles.length} related test file(s)` : 'no related test file found',
      graph.unresolved.some((reference) => reference.from === path)
        ? 'unresolved local reference in this file'
        : '',
    ].filter((item) => item.length > 0);
    const risk =
      graph.unresolved.some((reference) => reference.from === path) || dependents.length >= 3
        ? 'high'
        : analysis?.publicApi === true || dependents.length > 0 || dependencies.length > 0
          ? 'medium'
          : 'low';
    regressionAreas.push({
      path,
      risk,
      reason:
        risk === 'high'
          ? 'Several dependents or unresolved references make regressions likely outside the changed file.'
          : risk === 'medium'
            ? 'The file participates in a dependency relationship that should be revalidated.'
            : 'No analyzed dependent was found; keep the local check focused.',
      evidence,
    });
  }

  const recommendedTests = recommendedTestsFor(directPaths, impactedPaths, analyses, graph);
  const impactedLanguages = new Set(
    [...impactedPaths]
      .map((path) => languageForPath(path))
      .filter((language): language is NonNullable<typeof language> => language !== undefined),
  );
  const validationCommands = validationCommandsFor(
    overview,
    impactedLanguages,
    options.validationCommands ?? [],
  );
  const directHeuristic = graph.edges.some(
    (edge) =>
      (directPaths.has(edge.from) || directPaths.has(edge.to)) &&
      edge.confidence === 'heuristic',
  );
  const directUnresolved = graph.unresolved.some((reference) => directPaths.has(reference.from));
  const confidence: ImpactConfidence =
    graph.stats.truncated || directUnresolved
      ? 'low'
      : directHeuristic || traversal.files.some((file) => file.confidence === 'heuristic')
        ? 'medium'
        : recommendedTests.length > 0
          ? 'high'
          : 'medium';

  const evidence = [
    `Directly changed: ${directPaths.size} file(s).`,
    `Indirect: ${indirectFiles.length} file(s) within depth ${maxDepth}${
      traversal.truncated ? ' (traversal truncated)' : ''
    }.`,
    `Dependency graph: ${graph.stats.nodeCount} node(s), ${graph.stats.edgeCount} edge(s), ${graph.stats.heuristicEdges} heuristic edge(s), ${graph.stats.unresolvedCount} unresolved reference(s).`,
    recommendedTests.length > 0
      ? `Recommended tests: ${recommendedTests.map((test) => test.path).join(', ')}.`
      : 'No matching test file was found in the analyzed set.',
    directHeuristic
      ? 'Some direct relationships are heuristic; treat the affected boundary as a review candidate, not a certainty.'
      : 'All direct relationships matched the graph exactly.',
    graph.stats.truncated
      ? 'Graph analysis hit its configured resource limit; the impact list may be incomplete.'
      : 'Graph analysis stayed within its configured resource limit.',
  ];

  return {
    directFiles: directFiles.slice(0, 50),
    indirectFiles: indirectFiles.slice(0, maxFiles),
    relatedSymbols: boundedSymbols,
    relatedModules: moduleNamesFor([...impactedPaths], overview),
    regressionAreas: regressionAreas.slice(0, 50),
    recommendedTests,
    validationCommands,
    confidence,
    evidence: evidence.slice(0, MAX_EVIDENCE),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    limits: {
      maxDepth,
      maxFiles,
      truncated: traversal.truncated || graph.stats.truncated || indirectFiles.length >= maxFiles,
    },
  };
}

export function impactSummary(impact: ChangeImpact): string {
  const direct = impact.directFiles.length;
  const indirect = impact.indirectFiles.length;
  const tests = impact.recommendedTests.length;
  return `${direct} direct, ${indirect} indirect file(s), ${tests} recommended test(s), confidence ${impact.confidence}.`;
}
