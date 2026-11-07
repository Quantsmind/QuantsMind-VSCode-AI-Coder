import {
  languageForPath,
  type Confidence,
  type FileAnalysis,
  type ImportKind,
  type ImportReference,
  type SupportedLanguage,
} from './symbols';

export interface DependencyGraphOptions {
  readonly maxNodes?: number;
  readonly maxEdges?: number;
  readonly maxCycles?: number;
  readonly maxCycleNodes?: number;
  /** Local package/module prefixes, for example a go.mod module path. */
  readonly moduleNames?: readonly string[];
}

export interface DependencyNode {
  readonly path: string;
  readonly language: SupportedLanguage;
  readonly publicApi: boolean;
  readonly symbolCount: number;
  readonly exportedSymbols: readonly string[];
  readonly externalImports: readonly string[];
  readonly truncated: boolean;
}

export interface DependencyEdge {
  readonly from: string;
  readonly to: string;
  readonly specifier: string;
  readonly kind: ImportKind;
  /** `confirmed` means an exact workspace path matched; otherwise inferred. */
  readonly confidence: Confidence;
  readonly evidence: string;
}

export interface UnresolvedReference {
  readonly from: string;
  readonly specifier: string;
  readonly kind: ImportKind;
  readonly reason: 'missing-local-module' | 'ambiguous' | 'outside-workspace';
  readonly confidence: Confidence;
}

export interface DependencyGraph {
  readonly nodes: readonly DependencyNode[];
  readonly edges: readonly DependencyEdge[];
  readonly unresolved: readonly UnresolvedReference[];
  readonly cycles: readonly (readonly string[])[];
  readonly stats: {
    readonly analyzedFiles: number;
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly heuristicEdges: number;
    readonly unresolvedCount: number;
    readonly cycleCount: number;
    readonly truncated: boolean;
  };
}

export interface TraversedFile {
  readonly path: string;
  readonly distance: number;
  readonly direction: 'dependency' | 'dependent';
  readonly via: string;
  readonly confidence: Confidence;
}

export interface TraversalResult {
  readonly files: readonly TraversedFile[];
  readonly truncated: boolean;
}

export interface TraversalOptions {
  readonly depth?: number;
  readonly maxNodes?: number;
  readonly direction?: 'dependencies' | 'dependents' | 'both';
}

const DEFAULT_GRAPH_LIMITS = Object.freeze({
  maxNodes: 1_200,
  maxEdges: 4_000,
  maxCycles: 20,
  maxCycleNodes: 20,
});

const SCRIPT_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];

const SOURCE_EXTENSIONS: readonly string[] = [
  '.py',
  '.java',
  '.go',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hh',
  '.hpp',
  '.hxx',
  '.cs',
  '.rb',
];

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/{2,}/g, '/');
}

function dirName(path: string): string {
  const normalized = normalize(path);
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '' : normalized.slice(0, index);
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

function extensionCandidates(specifier: string): string[] {
  const withoutQuery = specifier.split(/[?#]/)[0] ?? specifier;
  const extra = withoutQuery
    .replace(/\.(?:js|jsx|mjs|cjs)$/i, '')
    .replace(/\.(?:ts|tsx|mts|cts)$/i, '');
  return [...new Set([withoutQuery, extra])].filter((value) => value.length > 0);
}

function exactCandidate(
  base: string,
  knownPaths: ReadonlySet<string>,
  language: SupportedLanguage | undefined,
): string | undefined {
  if (base.length === 0) {
    return undefined;
  }
  if (knownPaths.has(base)) {
    return base;
  }
  const extensions =
    language === 'typescript' || language === 'javascript' || language === undefined
      ? [...SCRIPT_EXTENSIONS, ...SOURCE_EXTENSIONS]
      : language === 'python'
        ? ['.py']
        : language === 'java'
          ? ['.java']
          : language === 'go'
            ? ['.go']
            : [...SOURCE_EXTENSIONS];
  for (const extension of extensions) {
    const candidate = `${base}${extension}`;
    if (knownPaths.has(candidate)) {
      return candidate;
    }
  }
  const indexNames =
    language === 'python'
      ? ['__init__.py']
      : language === 'java'
        ? []
        : language === 'go'
          ? []
          : ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs', 'index.cjs'];
  for (const indexName of indexNames) {
    const candidate = `${base}/${indexName}`;
    if (knownPaths.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function suffixCandidate(
  specifierPath: string,
  knownPaths: ReadonlySet<string>,
  extensions: readonly string[],
): string | undefined {
  const suffix = specifierPath.replace(/^\/+/, '');
  if (suffix.length === 0) {
    return undefined;
  }
  const matches = [...knownPaths]
    .filter((path) => path === suffix || path.endsWith(`/${suffix}`))
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  const direct = matches.find((path) => path.endsWith(suffix) && extensions.some((extension) => path.endsWith(extension)) && path === suffix);
  if (direct !== undefined) {
    return direct;
  }
  return matches.find((path) => extensions.some((extension) => path.endsWith(extension))) ?? matches[0];
}

interface ResolvedReference {
  readonly targets: readonly string[];
  readonly confidence: Confidence;
  readonly evidence: string;
  readonly localLooking: boolean;
  readonly ambiguous: boolean;
}

interface ResolutionContext {
  readonly from: string;
  readonly specifier: string;
  readonly kind: ImportKind;
  readonly language: SupportedLanguage;
  readonly knownPaths: ReadonlySet<string>;
  readonly topLevelDirectories: ReadonlySet<string>;
  readonly moduleNames: readonly string[];
  readonly local?: boolean;
}

function resolveScriptReference(context: ResolutionContext): ResolvedReference | undefined {
  const raw = context.specifier.split(/[?#]/)[0] ?? context.specifier;
  if (raw.length === 0) {
    return undefined;
  }
  const isRelative = raw.startsWith('.');
  const isAlias = /^(?:@\/|~\/|src\/|lib\/|app\/)/.test(raw) || (!isRelative && raw.includes('/'));
  if (!isRelative && !isAlias) {
    return undefined;
  }
  const firstSegment = raw.split('/')[0] ?? '';
  if (!isRelative && !/^(?:@|~|src|lib|app)$/.test(firstSegment) && !context.topLevelDirectories.has(firstSegment)) {
    return undefined;
  }
  const baseRoot = isRelative ? joinPath(dirName(context.from), raw) : raw;
  if (baseRoot.length === 0) {
    return undefined;
  }
  const candidates = isRelative
    ? extensionCandidates(baseRoot)
    : [
        ...extensionCandidates(baseRoot),
        ...extensionCandidates(`src/${raw.replace(/^(?:@|~)\//, '')}`),
        ...extensionCandidates(raw.replace(/^(?:@|~)\//, '')),
      ];
  for (const base of [...new Set(candidates)]) {
    const resolved = exactCandidate(base, context.knownPaths, context.language);
    if (resolved !== undefined) {
      return {
        targets: [resolved],
        confidence: isRelative ? 'confirmed' : 'heuristic',
        evidence: isRelative ? `relative import ${raw}` : `workspace alias ${raw}`,
        localLooking: true,
        ambiguous: false,
      };
    }
  }
  const trimmed = raw.replace(/^(?:@|~)\//, '');
  const heuristic = suffixCandidate(trimmed, context.knownPaths, [...SCRIPT_EXTENSIONS, ...SOURCE_EXTENSIONS]);
  if (heuristic !== undefined) {
    return {
      targets: [heuristic],
      confidence: 'heuristic',
      evidence: `suffix match for ${raw}`,
      localLooking: true,
      ambiguous: false,
    };
  }
  return {
    targets: [],
    confidence: 'heuristic',
    evidence: `local import ${raw} has no matching workspace file`,
    localLooking: true,
    ambiguous: false,
  };
}

function resolvePythonReference(context: ResolutionContext): ResolvedReference | undefined {
  const raw = context.specifier;
  if (raw.length === 0) {
    return undefined;
  }
  const relative = /^\.+/.test(raw);
  if (relative) {
    const dots = /^\.+/.exec(raw)?.[0].length ?? 1;
    const module = raw.slice(dots).replace(/\./g, '/');
    let base = dirName(context.from);
    for (let index = 1; index < dots; index += 1) {
      base = dirName(base);
    }
    const target = joinPath(base, module);
    const resolved =
      exactCandidate(target, context.knownPaths, 'python') ??
      exactCandidate(`${target}/__init__`, context.knownPaths, 'python');
    return resolved !== undefined
      ? {
          targets: [resolved],
          confidence: 'confirmed',
          evidence: `relative Python import ${raw}`,
          localLooking: true,
          ambiguous: false,
        }
      : {
          targets: [],
          confidence: 'heuristic',
          evidence: `relative Python import ${raw} has no matching file`,
          localLooking: true,
          ambiguous: false,
        };
  }
  const modulePath = raw.replace(/\./g, '/');
  const first = raw.split('.')[0] ?? raw;
  const localLooking =
    context.topLevelDirectories.has(first) ||
    context.moduleNames.some((name) => raw === name || raw.startsWith(`${name}.`));
  if (!localLooking) {
    return undefined;
  }
  const direct =
    exactCandidate(modulePath, context.knownPaths, 'python') ??
    exactCandidate(`${modulePath}/__init__`, context.knownPaths, 'python');
  if (direct !== undefined) {
    return {
      targets: [direct],
      confidence: 'confirmed',
      evidence: `Python module ${raw}`,
      localLooking: true,
      ambiguous: false,
    };
  }
  const heuristic = suffixCandidate(modulePath, context.knownPaths, ['.py']);
  return {
    targets: heuristic === undefined ? [] : [heuristic],
    confidence: 'heuristic',
    evidence:
      heuristic === undefined
        ? `Python module ${raw} has no matching file`
        : `suffix match for Python module ${raw}`,
    localLooking: true,
    ambiguous: false,
  };
}

function resolveJavaReference(context: ResolutionContext): ResolvedReference | undefined {
  const raw = context.specifier;
  if (raw.length === 0 || raw.startsWith('java.') || raw.startsWith('javax.')) {
    return undefined;
  }
  const clean = raw.replace(/\.\*$/, '');
  const path = clean.replace(/\./g, '/');
  const first = clean.split('.')[0] ?? clean;
  const localLooking =
    context.topLevelDirectories.has(first) ||
    [...context.knownPaths].some((candidate) => candidate.endsWith(`/${path}.java`));
  if (!localLooking) {
    return undefined;
  }
  if (raw.endsWith('.*')) {
    const directoryMatches = [...context.knownPaths]
      .filter((candidate) => {
        const directory = dirName(candidate);
        return (
          candidate.endsWith('.java') &&
          (directory === path || directory.endsWith(`/${path}`))
        );
      })
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 12);
    return {
      targets: directoryMatches,
      confidence: 'heuristic',
      evidence: `Java package wildcard ${raw}`,
      localLooking: true,
      ambiguous: directoryMatches.length > 1,
    };
  }
  const direct = context.knownPaths.has(`${path}.java`) ? `${path}.java` : undefined;
  if (direct !== undefined) {
    return {
      targets: [direct],
      confidence: 'confirmed',
      evidence: `Java import ${raw}`,
      localLooking: true,
      ambiguous: false,
    };
  }
  const suffix = suffixCandidate(`${path}.java`, context.knownPaths, ['.java']);
  return {
    targets: suffix === undefined ? [] : [suffix],
    confidence: 'heuristic',
    evidence:
      suffix === undefined ? `Java import ${raw} has no matching file` : `suffix match for Java import ${raw}`,
    localLooking: true,
    ambiguous: false,
  };
}

function resolveGoReference(context: ResolutionContext): ResolvedReference | undefined {
  const raw = context.specifier;
  if (raw.length === 0) {
    return undefined;
  }
  const moduleMatch = context.moduleNames.some(
    (name) => raw === name || raw.startsWith(`${name}/`),
  );
  const lastSegment = raw.split('/').pop() ?? raw;
  const directoryMatches = [...context.knownPaths]
    .filter((candidate) => candidate.endsWith('.go'))
    .filter((candidate) => {
      const directory = dirName(candidate);
      return directory === raw || directory.endsWith(`/${raw}`) || (directory.endsWith(`/${lastSegment}`) && moduleMatch);
    })
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 12);
  if (!moduleMatch && directoryMatches.length === 0) {
    return undefined;
  }
  return {
    targets: directoryMatches,
    confidence: moduleMatch ? 'heuristic' : 'confirmed',
    evidence:
      directoryMatches.length === 0
        ? `module ${raw} has no analyzed Go files`
        : moduleMatch
          ? `Go module prefix ${raw}`
          : `Go package directory ${raw}`,
    localLooking: true,
    ambiguous: directoryMatches.length > 1,
  };
}

function resolveIncludeReference(context: ResolutionContext): ResolvedReference | undefined {
  const raw = context.specifier;
  if (raw.length === 0) {
    return undefined;
  }
  const relative = joinPath(dirName(context.from), raw);
  const direct =
    context.knownPaths.has(relative) ? relative : context.knownPaths.has(raw) ? raw : undefined;
  if (direct !== undefined) {
    return {
      targets: [direct],
      confidence: 'confirmed',
      evidence: `include ${raw}`,
      localLooking: true,
      ambiguous: false,
    };
  }
  const suffix = suffixCandidate(raw, context.knownPaths, ['.h', '.hh', '.hpp', '.hxx', '.c', '.cc', '.cpp', '.cxx']);
  if (suffix === undefined) {
    return context.local === true
      ? {
          targets: [],
          confidence: 'heuristic',
          evidence: `quoted include ${raw} has no matching header`,
          localLooking: true,
          ambiguous: false,
        }
      : undefined;
  }
  return {
    targets: [suffix],
    confidence: 'heuristic',
    evidence: `suffix match for include ${raw}`,
    localLooking: true,
    ambiguous: false,
  };
}

function resolveReference(context: ResolutionContext): ResolvedReference | undefined {
  switch (context.language) {
    case 'typescript':
    case 'javascript':
      return resolveScriptReference(context);
    case 'python':
      return resolvePythonReference(context);
    case 'java':
      return resolveJavaReference(context);
    case 'go':
      return resolveGoReference(context);
    case 'c':
    case 'cpp':
      return resolveIncludeReference(context);
  }
}

function sortUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/**
 * Incremental graph store. Upserting one file only re-resolves that file's
 * outgoing imports; when the set of known paths changes, previously unresolved
 * local imports are retried so a newly created file becomes reachable.
 */
export class DependencyGraphBuilder {
  private readonly analyses = new Map<string, FileAnalysis>();
  private readonly importsByPath = new Map<string, readonly ImportReference[]>();
  private readonly edgesByFrom = new Map<string, DependencyEdge[]>();
  private readonly unresolvedByFrom = new Map<string, UnresolvedReference[]>();
  private readonly externalByPath = new Map<string, string[]>();
  private readonly moduleNames: readonly string[];
  private readonly limits: Required<Omit<DependencyGraphOptions, 'moduleNames'>>;
  private dirty = true;
  private capped = false;
  private cached: DependencyGraph | undefined;

  constructor(options: DependencyGraphOptions = {}) {
    this.moduleNames = [...(options.moduleNames ?? [])].filter((name) => name.length > 0).slice(0, 20);
    this.limits = {
      maxNodes: options.maxNodes ?? DEFAULT_GRAPH_LIMITS.maxNodes,
      maxEdges: options.maxEdges ?? DEFAULT_GRAPH_LIMITS.maxEdges,
      maxCycles: options.maxCycles ?? DEFAULT_GRAPH_LIMITS.maxCycles,
      maxCycleNodes: options.maxCycleNodes ?? DEFAULT_GRAPH_LIMITS.maxCycleNodes,
    };
  }

  get size(): number {
    return this.analyses.size;
  }

  has(path: string): boolean {
    return this.analyses.has(normalize(path));
  }

  get(path: string): FileAnalysis | undefined {
    return this.analyses.get(normalize(path));
  }

  markTruncated(): void {
    this.capped = true;
    this.dirty = true;
  }

  analysisMap(): ReadonlyMap<string, FileAnalysis> {
    return this.analyses;
  }

  upsert(analysis: FileAnalysis): void {
    const path = normalize(analysis.path);
    if (analysis.error !== undefined) {
      this.remove(path);
      return;
    }
    const existed = this.analyses.has(path);
    if (!existed && this.analyses.size >= this.limits.maxNodes) {
      this.markTruncated();
      return;
    }
    this.analyses.set(path, { ...analysis, path });
    this.importsByPath.set(path, analysis.imports);
    this.dirty = true;
    if (!existed) {
      this.reResolveAll();
    } else {
      this.resolveFrom(path);
    }
  }

  remove(path: string): void {
    const normalized = normalize(path);
    if (!this.analyses.delete(normalized)) {
      return;
    }
    this.importsByPath.delete(normalized);
    this.edgesByFrom.delete(normalized);
    this.unresolvedByFrom.delete(normalized);
    this.externalByPath.delete(normalized);
    this.dirty = true;
    this.reResolveAll();
  }

  private reResolveAll(): void {
    this.edgesByFrom.clear();
    this.unresolvedByFrom.clear();
    this.externalByPath.clear();
    const topLevelDirectories = new Set(
      [...this.analyses.keys()]
        .map((path) => path.split('/')[0] ?? path)
        .filter((segment) => segment.length > 0),
    );
    const knownPaths = new Set(this.analyses.keys());
    for (const [path, analysis] of this.analyses) {
      this.resolveImports(path, analysis.imports, knownPaths, topLevelDirectories);
    }
  }

  private resolveFrom(path: string): void {
    const analysis = this.analyses.get(path);
    if (analysis === undefined) {
      return;
    }
    const topLevelDirectories = new Set(
      [...this.analyses.keys()]
        .map((candidate) => candidate.split('/')[0] ?? candidate)
        .filter((segment) => segment.length > 0),
    );
    this.resolveImports(path, analysis.imports, new Set(this.analyses.keys()), topLevelDirectories);
  }

  private resolveImports(
    path: string,
    imports: readonly ImportReference[],
    knownPaths: ReadonlySet<string>,
    topLevelDirectories: ReadonlySet<string>,
  ): void {
    const language = languageForPath(path) ?? this.analyses.get(path)?.language ?? 'typescript';
    const edges: DependencyEdge[] = [];
    const unresolved: UnresolvedReference[] = [];
    const external: string[] = [];
    const importKeys = new Set<string>();
    for (const reference of imports) {
      const key = `${reference.kind}:${reference.specifier}`;
      if (importKeys.has(key)) {
        continue;
      }
      importKeys.add(key);
      const resolved = resolveReference({
        from: path,
        specifier: reference.specifier,
        kind: reference.kind,
        language,
        knownPaths,
        topLevelDirectories,
        moduleNames: this.moduleNames,
        local: reference.local,
      });
      if (resolved === undefined) {
        external.push(reference.specifier);
        continue;
      }
      if (resolved.targets.length === 0) {
        unresolved.push({
          from: path,
          specifier: reference.specifier,
          kind: reference.kind,
          reason: 'missing-local-module',
          confidence: 'heuristic',
        });
        continue;
      }
      if (resolved.ambiguous) {
        unresolved.push({
          from: path,
          specifier: reference.specifier,
          kind: reference.kind,
          reason: 'ambiguous',
          confidence: 'heuristic',
        });
      }
      for (const target of resolved.targets) {
        if (target !== path) {
          edges.push({
            from: path,
            to: target,
            specifier: reference.specifier,
            kind: reference.kind,
            confidence: resolved.confidence,
            evidence: resolved.evidence,
          });
        }
      }
    }
    this.edgesByFrom.set(path, edges);
    this.unresolvedByFrom.set(path, unresolved);
    this.externalByPath.set(path, sortUnique(external).slice(0, 100));
  }

  private allEdges(): DependencyEdge[] {
    const edges: DependencyEdge[] = [];
    const sources = [...this.edgesByFrom.keys()].sort((left, right) => left.localeCompare(right));
    for (const source of sources) {
      for (const edge of this.edgesByFrom.get(source) ?? []) {
        edges.push(edge);
        if (edges.length >= this.limits.maxEdges) {
          return edges;
        }
      }
    }
    return edges;
  }

  snapshot(): DependencyGraph {
    if (!this.dirty && this.cached !== undefined) {
      return this.cached;
    }
    const paths = [...this.analyses.keys()].sort((left, right) => left.localeCompare(right));
    const nodes: DependencyNode[] = paths.map((path) => {
      const analysis = this.analyses.get(path);
      return {
        path,
        language: analysis?.language ?? languageForPath(path) ?? 'typescript',
        publicApi: analysis?.publicApi ?? false,
        symbolCount: analysis?.symbols.length ?? 0,
        exportedSymbols: (analysis?.exports ?? []).map((item) => item.name).slice(0, 50),
        externalImports: this.externalByPath.get(path) ?? [],
        truncated: analysis?.truncated ?? false,
      };
    });
    const edges = this.allEdges();
    const unresolved = [...this.unresolvedByFrom.values()]
      .flat()
      .sort((left, right) => left.from.localeCompare(right.from) || left.specifier.localeCompare(right.specifier))
      .slice(0, 200);
    const cycles = this.findCycles(paths, edges);
    const heuristicEdges = edges.filter((edge) => edge.confidence === 'heuristic').length;
    this.cached = {
      nodes,
      edges,
      unresolved,
      cycles,
      stats: {
        analyzedFiles: paths.length,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        heuristicEdges,
        unresolvedCount: unresolved.length,
        cycleCount: cycles.length,
        truncated: this.capped || paths.length >= this.limits.maxNodes || edges.length >= this.limits.maxEdges,
      },
    };
    this.dirty = false;
    return this.cached;
  }

  private findCycles(paths: readonly string[], edges: readonly DependencyEdge[]): string[][] {
    const adjacency = new Map<string, string[]>();
    for (const path of paths) {
      adjacency.set(path, []);
    }
    for (const edge of edges) {
      const list = adjacency.get(edge.from);
      if (list !== undefined && adjacency.has(edge.to)) {
        list.push(edge.to);
      }
    }
    for (const list of adjacency.values()) {
      list.sort((left, right) => left.localeCompare(right));
    }

    const indexOf = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const components: string[][] = [];
    let nextIndex = 0;
    const strongConnect = (node: string): void => {
      indexOf.set(node, nextIndex);
      low.set(node, nextIndex);
      nextIndex += 1;
      stack.push(node);
      onStack.add(node);
      for (const target of adjacency.get(node) ?? []) {
        if (!indexOf.has(target)) {
          strongConnect(target);
          low.set(node, Math.min(low.get(node) ?? 0, low.get(target) ?? 0));
        } else if (onStack.has(target)) {
          low.set(node, Math.min(low.get(node) ?? 0, indexOf.get(target) ?? 0));
        }
      }
      if (low.get(node) === indexOf.get(node)) {
        const component: string[] = [];
        let current: string | undefined;
        do {
          current = stack.pop();
          if (current !== undefined) {
            onStack.delete(current);
            component.push(current);
          }
        } while (current !== undefined && current !== node);
        component.sort((left, right) => left.localeCompare(right));
        if (component.length > 1) {
          components.push(component.slice(0, this.limits.maxCycleNodes));
        } else if (component.length === 1) {
          const only = component[0] ?? '';
          if ((adjacency.get(only) ?? []).includes(only)) {
            components.push(component);
          }
        }
      }
    };
    for (const path of paths) {
      if (!indexOf.has(path)) {
        strongConnect(path);
      }
    }
    return components
      .sort((left, right) => (left[0] ?? '').localeCompare(right[0] ?? '') || left.length - right.length)
      .slice(0, this.limits.maxCycles);
  }
}

export function buildDependencyGraph(
  analyses: readonly FileAnalysis[],
  options: DependencyGraphOptions = {},
): DependencyGraph {
  const builder = new DependencyGraphBuilder(options);
  for (const analysis of analyses.slice(0, options.maxNodes ?? DEFAULT_GRAPH_LIMITS.maxNodes)) {
    builder.upsert(analysis);
  }
  return builder.snapshot();
}

export function directDependencies(graph: DependencyGraph, path: string): DependencyEdge[] {
  const normalized = normalize(path);
  return graph.edges.filter((edge) => edge.from === normalized);
}

export function directDependents(graph: DependencyGraph, path: string): DependencyEdge[] {
  const normalized = normalize(path);
  return graph.edges.filter((edge) => edge.to === normalized);
}

export function traverseDependencies(
  graph: DependencyGraph,
  startPaths: readonly string[],
  options: TraversalOptions = {},
): TraversalResult {
  const depth = Math.max(0, Math.min(options.depth ?? 2, 4));
  const maxNodes = Math.max(1, Math.min(options.maxNodes ?? 80, 200));
  const direction = options.direction ?? 'both';
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const forwardList = forward.get(edge.from) ?? [];
    forwardList.push(edge.to);
    forward.set(edge.from, forwardList);
    const reverseList = reverse.get(edge.to) ?? [];
    reverseList.push(edge.from);
    reverse.set(edge.to, reverseList);
  }
  for (const list of forward.values()) {
    list.sort((left, right) => left.localeCompare(right));
  }
  for (const list of reverse.values()) {
    list.sort((left, right) => left.localeCompare(right));
  }

  const expanded = new Map<string, TraversedFile>();
  const starts = new Set(startPaths.map(normalize));
  const queue: { readonly path: string; readonly distance: number; readonly direction: 'dependency' | 'dependent'; readonly via: string }[] = [];
  for (const start of starts) {
    if (direction !== 'dependencies') {
      for (const dependent of reverse.get(start) ?? []) {
        queue.push({ path: dependent, distance: 1, direction: 'dependent', via: start });
      }
    }
    if (direction !== 'dependents') {
      for (const dependency of forward.get(start) ?? []) {
        queue.push({ path: dependency, distance: 1, direction: 'dependency', via: start });
      }
    }
  }

  let truncated = false;
  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) {
      break;
    }
    if (starts.has(item.path)) {
      continue;
    }
    const previous = expanded.get(item.path);
    if (previous !== undefined && previous.distance <= item.distance) {
      continue;
    }
    if (expanded.size >= maxNodes) {
      truncated = true;
      break;
    }
    expanded.set(item.path, {
      path: item.path,
      distance: item.distance,
      direction: item.direction,
      via: item.via,
      confidence:
        graph.edges.find(
          (edge) =>
            (edge.from === item.via && edge.to === item.path) ||
            (edge.from === item.path && edge.to === item.via),
        )?.confidence ?? 'heuristic',
    });
    if (item.distance >= depth) {
      continue;
    }
    const nextPaths =
      item.direction === 'dependent' ? reverse.get(item.path) ?? [] : forward.get(item.path) ?? [];
    for (const next of nextPaths) {
      if (!expanded.has(next) && !starts.has(next)) {
        queue.push({
          path: next,
          distance: item.distance + 1,
          direction: item.direction,
          via: item.path,
        });
      }
    }
  }

  return {
    files: [...expanded.values()].sort(
      (left, right) => left.distance - right.distance || left.path.localeCompare(right.path),
    ),
    truncated,
  };
}

export function graphLimits(options: DependencyGraphOptions = {}): Required<Omit<DependencyGraphOptions, 'moduleNames'>> {
  return {
    maxNodes: options.maxNodes ?? DEFAULT_GRAPH_LIMITS.maxNodes,
    maxEdges: options.maxEdges ?? DEFAULT_GRAPH_LIMITS.maxEdges,
    maxCycles: options.maxCycles ?? DEFAULT_GRAPH_LIMITS.maxCycles,
    maxCycleNodes: options.maxCycleNodes ?? DEFAULT_GRAPH_LIMITS.maxCycleNodes,
  };
}
