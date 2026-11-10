import {
  analyzeSourceFile,
  type Confidence,
  type FileAnalysis,
  type SymbolInfo,
} from '../repository/symbols';
import { normalizeWorkspacePath, type WorkspaceEntry } from '../workspace/analyze';

export const KARKAIN_FILE_EXTENSION = 'kark';
export const KARKAIN_LANGUAGE_NAME = 'Karkain';
export const KARKAIN_MANIFEST_FILE = 'karkain.toml';
export const KARKAIN_STDLIB_PREFIX = 'std.';

export interface KarkainSourceFile {
  readonly path: string;
  readonly content: string;
}

export interface KarkainSymbolDetail {
  readonly name: string;
  readonly kind: SymbolInfo['kind'];
  readonly line: number;
  readonly exported: boolean;
  readonly confidence: Confidence;
}

export interface KarkainModuleNode {
  readonly name: string;
  readonly path: string;
  readonly symbols: readonly KarkainSymbolDetail[];
  readonly exported: readonly string[];
  readonly dependencies: readonly string[];
}

export interface KarkainModuleEdge {
  readonly from: string;
  readonly fromPath: string;
  readonly to: string;
  readonly toPath: string;
  readonly line: number;
}

export interface KarkainUnresolved {
  readonly from: string;
  readonly fromPath: string;
  readonly name: string;
  readonly line: number;
  readonly reason: string;
}

export interface KarkainModuleGraph {
  readonly root: string | undefined;
  readonly modules: readonly KarkainModuleNode[];
  readonly edges: readonly KarkainModuleEdge[];
  /** Dependencies first; the entry module is last. */
  readonly order: readonly string[];
  readonly cycles: readonly (readonly string[])[];
  readonly unresolved: readonly KarkainUnresolved[];
  readonly truncated: boolean;
}

export interface KarkainTypeSummary {
  readonly name: string;
  readonly kind: SymbolInfo['kind'];
  readonly path: string;
  readonly exported: boolean;
}

export interface KarkainProjectSummary {
  readonly isKarkainProject: boolean;
  readonly rootName: string;
  readonly fileCount: number;
  readonly moduleCount: number;
  readonly entryPoints: readonly string[];
  readonly testFiles: readonly string[];
  readonly types: readonly KarkainTypeSummary[];
  readonly technologies: readonly string[];
  readonly summaryText: string;
}

export interface KarkainContextFile {
  readonly path: string;
  readonly module: string;
  readonly symbols: readonly string[];
}

export interface KarkainContextResult {
  readonly query: string;
  readonly files: readonly KarkainContextFile[];
  readonly moduleOrder: readonly string[];
  readonly summaryText: string;
  readonly truncated: boolean;
}

export interface KarkainContextOptions {
  readonly maxFiles?: number;
}

function normalizePath(path: string): string {
  return normalizeWorkspacePath(path);
}

/** True for `.kark` source files. */
export function isKarkainPath(path: string): boolean {
  const normalized = normalizePath(path);
  const name = normalized.split('/').pop() ?? normalized;
  const dot = name.lastIndexOf('.');
  return dot > 0 && name.slice(dot + 1).toLowerCase() === KARKAIN_FILE_EXTENSION;
}

/** True when the workspace contains `.kark` sources or a `karkain.toml` manifest. */
export function isKarkainProject(
  entries: readonly WorkspaceEntry[],
  configContents: Readonly<Record<string, string>> = {},
): boolean {
  if (Object.keys(configContents).some((path) => configBaseName(path) === KARKAIN_MANIFEST_FILE)) {
    return true;
  }
  return entries.some((entry) => isKarkainPath(entry.path));
}

function configBaseName(path: string): string {
  return normalizePath(path).split('/').pop() ?? '';
}

/** Module identity follows the compiler: the file basename without `.kark`. */
export function karkainModuleName(path: string): string {
  const normalized = normalizePath(path);
  const name = normalized.split('/').pop() ?? normalized;
  return name.slice(0, name.length - `.${KARKAIN_FILE_EXTENSION}`.length);
}

function directoryOf(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '' : normalized.slice(0, index);
}

function symbolsOf(analysis: FileAnalysis): KarkainSymbolDetail[] {
  return analysis.symbols.map((symbol) => ({
    name: symbol.name,
    kind: symbol.kind,
    line: symbol.line,
    exported: symbol.exported,
    confidence: symbol.confidence,
  }));
}

function exportedOf(analysis: FileAnalysis): string[] {
  const names = new Set<string>();
  for (const item of analysis.exports) {
    if (item.name !== 'default' && item.name !== 'module.exports') {
      names.add(item.name);
    }
  }
  for (const symbol of analysis.symbols) {
    if (symbol.exported) {
      names.add(symbol.name);
    }
  }
  return [...names].sort();
}

interface ResolvedImport {
  readonly targets: readonly string[];
  readonly confidence: Confidence;
  readonly evidence: string;
}

/**
 * Mirrors the compiler's module resolver (pkg/module/module.go): a `std.*`
 * import resolves under `stdlib/`, any other name resolves to a sibling
 * `<name>.kark` file or a sibling `<name>/` directory of `.kark` sources.
 */
export function resolveKarkainImport(
  name: string,
  fromPath: string,
  knownPaths: readonly string[],
): ResolvedImport | undefined {
  if (name.length === 0 || name.includes('/')) {
    return undefined;
  }
  const known = new Set(knownPaths.map(normalizePath));
  const fromDir = directoryOf(fromPath);

  if (name.startsWith(KARKAIN_STDLIB_PREFIX)) {
    const sub = name.slice(KARKAIN_STDLIB_PREFIX.length);
    const matches = [...known]
      .filter((path) => {
        const relative = path.replace(/\\/g, '/');
        return (
          relative === `stdlib/${sub}.kark` ||
          relative.endsWith(`/stdlib/${sub}.kark`) ||
          relative.startsWith(`stdlib/${sub}/`) ||
          relative.includes(`/stdlib/${sub}/`)
        );
      })
      .sort((left, right) => left.localeCompare(right));
    if (matches.length > 0) {
      return {
        targets: matches.slice(0, 12),
        confidence: 'confirmed',
        evidence: `standard-library module ${name}`,
      };
    }
    return {
      targets: [],
      confidence: 'heuristic',
      evidence: `standard-library module ${name} was not found`,
    };
  }

  const siblingFile = joinPath(fromDir, `${name}.kark`);
  if (known.has(siblingFile)) {
    return {
      targets: [siblingFile],
      confidence: 'confirmed',
      evidence: `sibling module ${name}.kark`,
    };
  }
  const siblingDir = joinPath(fromDir, name);
  const directoryFiles = [...known]
    .filter((path) => path.startsWith(`${siblingDir}/`) && path.endsWith('.kark'))
    .sort((left, right) => left.localeCompare(right));
  if (directoryFiles.length > 0) {
    return {
      targets: directoryFiles.slice(0, 12),
      confidence: 'confirmed',
      evidence: `sibling module directory ${name}/`,
    };
  }
  if (known.has(`${name}.kark`)) {
    return {
      targets: [`${name}.kark`],
      confidence: 'confirmed',
      evidence: `module ${name}.kark`,
    };
  }

  const suffix = [...known]
    .filter((path) => path === `${name}.kark` || path.endsWith(`/${name}.kark`))
    .sort((left, right) => left.length - right.length || left.localeCompare(right))[0];
  if (suffix !== undefined) {
    return {
      targets: [suffix],
      confidence: 'heuristic',
      evidence: `suffix match for module ${name}`,
    };
  }
  return {
    targets: [],
    confidence: 'heuristic',
    evidence: `module ${name} has no matching file`,
  };
}

function joinPath(base: string, relative: string): string {
  const segments = `${base}/${relative}`.split('/');
  const result: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (result.length === 0) {
        return '';
      }
      result.pop();
    } else {
      result.push(segment);
    }
  }
  return result.join('/');
}

interface TopoResult {
  readonly order: readonly string[];
  readonly cycles: readonly (readonly string[])[];
}

function topoOrder(
  nodes: readonly string[],
  edges: readonly { readonly from: string; readonly to: string }[],
  maxCycles = 8,
): TopoResult {
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const node of nodes) {
    adjacency.set(node, []);
    indegree.set(node, 0);
  }
  for (const edge of edges) {
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) {
      continue;
    }
    adjacency.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const queue = nodes.filter((node) => (indegree.get(node) ?? 0) === 0).sort();
  const order: string[] = [];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    order.push(current);
    for (const next of adjacency.get(current) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if ((indegree.get(next) ?? 0) === 0) {
        queue.push(next);
      }
    }
    queue.sort();
  }
  if (visited.size === nodes.length) {
    return { order, cycles: [] };
  }

  const cycles: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];
  const visit = (node: string): void => {
    if (cycles.length >= maxCycles) {
      return;
    }
    const current = state.get(node) ?? 0;
    if (current === 2) {
      return;
    }
    if (current === 1) {
      const start = path.indexOf(node);
      cycles.push([...path.slice(start), node]);
      return;
    }
    state.set(node, 1);
    path.push(node);
    for (const next of [...(adjacency.get(node) ?? [])].sort()) {
      visit(next);
    }
    path.pop();
    state.set(node, 2);
  };
  for (const node of [...nodes].sort()) {
    visit(node);
  }
  return { order, cycles };
}

/**
 * Builds the Karkain module graph from analyzed `.kark` files. Nodes are source
 * files, edges are resolved `import` declarations, and the order is the
 * compiler's dependency-first topological order with cycle reporting.
 */
export function buildKarkainModuleGraph(
  analyses: readonly FileAnalysis[],
  options: { readonly rootName?: string; readonly maxFiles?: number } = {},
): KarkainModuleGraph {
  const bounded = analyses.filter((analysis) => analysis.error === undefined);
  const truncated = bounded.length > (options.maxFiles ?? 400);
  const files = bounded.slice(0, options.maxFiles ?? 400);
  const knownPaths = files.map((analysis) => normalizePath(analysis.path));
  const known = new Set(knownPaths);
  const pathByModule = new Map<string, string>();
  for (const path of knownPaths) {
    pathByModule.set(karkainModuleName(path), path);
  }

  const edges: KarkainModuleEdge[] = [];
  const unresolved: KarkainUnresolved[] = [];
  const dependencyNames = new Map<string, Set<string>>();

  for (const analysis of files) {
    const fromPath = normalizePath(analysis.path);
    const fromModule = karkainModuleName(fromPath);
    const dependencies = new Set<string>();
    for (const reference of analysis.imports) {
      const resolved = resolveKarkainImport(reference.specifier, fromPath, knownPaths);
      if (resolved === undefined) {
        continue;
      }
      if (resolved.targets.length === 0) {
        unresolved.push({
          from: fromModule,
          fromPath,
          name: reference.specifier,
          line: reference.line,
          reason: resolved.evidence,
        });
        continue;
      }
      for (const target of resolved.targets) {
        if (!known.has(target)) {
          continue;
        }
        const toModule = karkainModuleName(target);
        dependencies.add(toModule);
        edges.push({
          from: fromModule,
          fromPath,
          to: toModule,
          toPath: target,
          line: reference.line,
        });
      }
    }
    dependencyNames.set(fromPath, dependencies);
  }

  const modules: KarkainModuleNode[] = files.map((analysis) => {
    const path = normalizePath(analysis.path);
    return {
      name: karkainModuleName(path),
      path,
      symbols: symbolsOf(analysis),
      exported: exportedOf(analysis),
      dependencies: [...(dependencyNames.get(path) ?? new Set<string>())].sort(),
    };
  });

  const topo = topoOrder(knownPaths, edges.map((edge) => ({ from: edge.fromPath, to: edge.toPath })));
  const rootPath = knownPaths.find((path) => /(^|\/)main\.kark$/.test(path)) ?? knownPaths[0];
  // Kahn's queue emits importers first; the compiler consumes dependencies
  // first, so reverse to match module.go's assembly order.
  const order = topo.cycles.length > 0 ? [] : [...topo.order].reverse();
  const root = rootPath === undefined ? undefined : karkainModuleName(rootPath);

  return {
    root,
    modules,
    edges,
    order,
    cycles: topo.cycles,
    unresolved,
    truncated,
  };
}

/** Summarizes a Karkain project from its module graph and analyses. */
export function summarizeKarkainProject(
  rootName: string,
  analyses: readonly FileAnalysis[],
  graph: KarkainModuleGraph,
): KarkainProjectSummary {
  const files = analyses.filter((analysis) => analysis.error === undefined);
  const entryPoints = files
    .map((analysis) => normalizePath(analysis.path))
    .filter((path) => /(^|\/)main\.kark$/.test(path));
  const testFiles = files
    .map((analysis) => normalizePath(analysis.path))
    .filter((path) => /(^|\/)(tests?|specs?)\//i.test(path) || /(^|\/)test_[^/]+\.kark$/i.test(path));
  const types: KarkainTypeSummary[] = [];
  for (const analysis of files) {
    for (const symbol of analysis.symbols) {
      if (symbol.kind === 'struct' || symbol.kind === 'enum' || symbol.kind === 'type') {
        types.push({
          name: symbol.name,
          kind: symbol.kind,
          path: normalizePath(analysis.path),
          exported: symbol.exported,
        });
      }
    }
  }
  types.sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));

  const technologies = ['Karkain'];
  if (graph.cycles.length > 0) {
    technologies.push('import cycles detected');
  }

  const lines = [
    `Karkain project ${rootName}: ${files.length} source file(s), ${graph.modules.length} module(s).`,
    `Modules: ${graph.modules
      .slice(0, 12)
      .map((module) => module.name)
      .join(', ')}.`,
    `Types: ${types
      .slice(0, 12)
      .map((type) => `${type.name} (${type.kind})`)
      .join(', ') || 'none detected'}.`,
    entryPoints.length > 0 ? `Entry points: ${entryPoints.join(', ')}.` : '',
    `Imports: ${graph.edges.length} resolved, ${graph.unresolved.length} unresolved.`,
    graph.cycles.length > 0 ? `Cycles: ${graph.cycles.map((cycle) => cycle.join(' -> ')).join('; ')}.` : '',
  ].filter((line) => line.length > 0);

  return {
    isKarkainProject: files.length > 0,
    rootName,
    fileCount: files.length,
    moduleCount: graph.modules.length,
    entryPoints,
    testFiles,
    types: types.slice(0, 40),
    technologies,
    summaryText: lines.join('\n'),
  };
}

function tokenizeQuery(query: string): string[] {
  const matches = query.match(/[A-Za-z0-9_$.-]{2,}/g) ?? [];
  const tokens = new Set<string>();
  for (const match of matches) {
    tokens.add(match.toLowerCase());
  }
  return [...tokens].slice(0, 24);
}

/**
 * Collects relevant Karkain files for a query and expands along module
 * dependencies and dependents, so the agent receives the multi-file context a
 * Karkain change actually needs.
 */
export function collectKarkainContext(
  query: string,
  analyses: readonly FileAnalysis[],
  options: KarkainContextOptions = {},
): KarkainContextResult {
  const tokens = tokenizeQuery(query);
  const files = analyses.filter((analysis) => analysis.error === undefined);
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 8, 40));

  const scored = files
    .map((analysis) => {
      const path = normalizePath(analysis.path);
      const name = karkainModuleName(path).toLowerCase();
      const symbolNames = analysis.symbols.map((symbol) => symbol.name.toLowerCase());
      let score = 0;
      for (const token of tokens) {
        if (name.includes(token)) {
          score += 6;
        } else if (path.toLowerCase().includes(token)) {
          score += 3;
        }
        if (symbolNames.some((symbol) => symbol.includes(token))) {
          score += 4;
        }
      }
      return { path, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

  const selected = new Set<string>();
  for (const item of scored) {
    if (selected.size >= Math.min(2, maxFiles)) {
      break;
    }
    selected.add(item.path);
  }

  const graph = buildKarkainModuleGraph(files, { maxFiles: 400 });
  const adjacency = new Map<string, Set<string>>();
  for (const module of graph.modules) {
    adjacency.set(module.path, new Set(module.dependencies.map((name) => pathOfModule(graph, name))));
  }
  const reverse = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const set = reverse.get(edge.toPath) ?? new Set<string>();
    set.add(edge.fromPath);
    reverse.set(edge.toPath, set);
  }

  const queue = [...selected];
  while (queue.length > 0 && selected.size < maxFiles) {
    const current = queue.shift() as string;
    for (const next of [...(adjacency.get(current) ?? []), ...(reverse.get(current) ?? [])]) {
      if (!selected.has(next) && selected.size < maxFiles) {
        selected.add(next);
        queue.push(next);
      }
    }
  }

  const byPath = new Map(files.map((analysis) => [normalizePath(analysis.path), analysis]));
  const resultFiles: KarkainContextFile[] = [];
  const orderedPaths = graph.order.filter((path) => selected.has(path));
  for (const path of orderedPaths) {
    const analysis = byPath.get(path);
    if (analysis === undefined) {
      continue;
    }
    resultFiles.push({
      path,
      module: karkainModuleName(path),
      symbols: analysis.symbols.map((symbol) => symbol.name).slice(0, 40),
    });
  }

  const lines = [
    `Karkain context for "${query}": ${resultFiles.length} file(s).`,
    resultFiles
      .map((file) => `${file.path} [${file.module}] symbols: ${file.symbols.slice(0, 8).join(', ') || 'none'}`)
      .join('\n'),
  ];
  return {
    query,
    files: resultFiles,
    moduleOrder: orderedPaths,
    summaryText: lines.join('\n'),
    truncated: false,
  };
}

function pathOfModule(graph: KarkainModuleGraph, module: string): string {
  return graph.modules.find((node) => node.name === module)?.path ?? module;
}

export interface AnalyzeKarkainProjectInput {
  readonly rootName: string;
  readonly entries: readonly WorkspaceEntry[];
  readonly files: readonly KarkainSourceFile[];
  readonly configContents?: Readonly<Record<string, string>>;
}

export interface AnalyzeKarkainProjectResult {
  readonly summary: KarkainProjectSummary;
  readonly graph: KarkainModuleGraph;
  readonly analyses: readonly FileAnalysis[];
}

/** Analyzes `.kark` sources with the shared source analyzer and builds the graph. */
export function analyzeKarkainProject(
  input: AnalyzeKarkainProjectInput,
): AnalyzeKarkainProjectResult {
  const analyses = input.files.slice(0, 400).map((file) =>
    analyzeSourceFile(normalizePath(file.path), file.content, { maxFileChars: 160_000 }),
  );
  const graph = buildKarkainModuleGraph(analyses, { rootName: input.rootName });
  const summary = summarizeKarkainProject(input.rootName, analyses, graph);
  return { summary, graph, analyses };
}

export function karkainProjectFromEntries(
  rootName: string,
  entries: readonly WorkspaceEntry[],
  readText: (path: string) => Promise<string | undefined>,
  configContents: Readonly<Record<string, string>> = {},
): Promise<AnalyzeKarkainProjectResult> {
  const files: KarkainSourceFile[] = [];
  return (async () => {
    for (const entry of entries) {
      if (!isKarkainPath(entry.path)) {
        continue;
      }
      const normalized = normalizePath(entry.path);
      const content = await readText(normalized);
      if (content !== undefined && !content.includes('\u0000')) {
        files.push({ path: normalized, content });
      }
      if (files.length >= 400) {
        break;
      }
    }
    return analyzeKarkainProject({ rootName, entries, files, configContents });
  })();
}
