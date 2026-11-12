import type { FileChange } from '../changes/model';
import { isPathExcluded } from '../context/filters';
import { isTestPath, normalizeWorkspacePath, type WorkspaceEntry } from '../workspace/analyze';
import {
  discoverRepository,
  isIgnoredRepositoryPath,
  type RepositoryOverview,
} from './discovery';
import {
  DependencyGraphBuilder,
  type DependencyGraph,
} from './graph';
import {
  analyzeChangeImpact,
  type ChangeImpact,
} from './impact';
import {
  analyzeSourceFile,
  isSupportedSourcePath,
  languageForPath,
  type FileAnalysis,
} from './symbols';
import {
  selectRepositoryContext,
  type ContextSelectionOptions,
  type RepositoryContextSelection,
} from './contextSelection';
import { findLanguageRelations } from '../languages/relationships';
import {
  analyzeArchitecture,
  type ArchitectureAnalysis,
} from '../project/architecture';
import {
  buildKarkainModuleGraph,
  collectKarkainContext,
  summarizeKarkainProject,
  type KarkainContextOptions,
  type KarkainContextResult,
  type KarkainModuleGraph,
  type KarkainProjectSummary,
} from '../project/karkain';

export interface RepositoryWorkspaceSource {
  readonly rootName: () => string;
  listEntries(): Promise<readonly WorkspaceEntry[]>;
  readText(path: string): Promise<string | undefined>;
  readonly excludeGlobs?: () => readonly string[];
}

export interface RepositoryIntelligenceOptions {
  readonly maxAnalyzedFiles?: number;
  readonly maxFileChars?: number;
  readonly maxTotalAnalysisChars?: number;
  readonly maxConfigFiles?: number;
  readonly maxConfigChars?: number;
  readonly maxGraphNodes?: number;
  readonly maxGraphEdges?: number;
  readonly maxCycles?: number;
  readonly maxTraversalDepth?: number;
  readonly maxTraversalFiles?: number;
}

export const DEFAULT_REPOSITORY_INTELLIGENCE_LIMITS = Object.freeze({
  maxAnalyzedFiles: 800,
  maxFileChars: 160_000,
  maxTotalAnalysisChars: 4_000_000,
  maxConfigFiles: 24,
  maxConfigChars: 200_000,
  maxGraphNodes: 800,
  maxGraphEdges: 4_000,
  maxCycles: 20,
  maxTraversalDepth: 2,
  maxTraversalFiles: 80,
});

export interface RepositoryIntelligenceLimits {
  readonly maxAnalyzedFiles: number;
  readonly maxFileChars: number;
  readonly maxTotalAnalysisChars: number;
  readonly maxGraphNodes: number;
  readonly maxGraphEdges: number;
}

function configBaseName(path: string): string {
  return normalizeWorkspacePath(path).split('/').pop() ?? '';
}

function isConfigPath(path: string): boolean {
  return /^(?:package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|pnpm-workspace\.ya?ml|tsconfig(?:\.[^/]+)?\.json|jsconfig\.json|pyproject\.toml|requirements[^/]*\.txt|setup\.py|setup\.cfg|Pipfile|poetry\.lock|go\.mod|go\.sum|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|Cargo\.toml|Cargo\.lock|CMakeLists\.txt|Makefile|Gemfile|composer\.json|Dockerfile|docker-compose\.ya?ml|karkain\.toml)$/i.test(
    configBaseName(path),
  ) || /\.(?:csproj|sln)$/i.test(path) || /\.sql$/i.test(path);
}

function manifestModuleName(path: string, content: string | undefined): string | undefined {
  if (content === undefined) {
    return undefined;
  }
  if (configBaseName(path) === 'package.json') {
    try {
      const parsed: unknown = JSON.parse(content.slice(0, 200_000));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const name = (parsed as Record<string, unknown>).name;
        return typeof name === 'string' && /^[@A-Za-z0-9._/-]{1,200}$/.test(name) ? name : undefined;
      }
    } catch {
      return undefined;
    }
  }
  if (configBaseName(path) === 'go.mod') {
    const match = /^\s*module\s+(\S+)\s*$/m.exec(content.slice(0, 20_000));
    return match?.[1];
  }
  if (configBaseName(path) === 'karkain.toml') {
    const match = /^\s*name\s*=\s*"([^"]{1,120})"/m.exec(content.slice(0, 20_000));
    return match?.[1];
  }
  return undefined;
}

/**
 * Coordinates bounded source analysis over the existing workspace index. It
 * never talks to a provider; callers decide whether a snapshot is used for
 * planning, impact review or context selection.
 */
export class RepositoryIntelligenceService {
  private readonly limits: Required<RepositoryIntelligenceOptions>;
  private entries: WorkspaceEntry[] | undefined;
  private configContents: Readonly<Record<string, string>> | undefined;
  private analyses = new Map<string, FileAnalysis>();
  private builder = new DependencyGraphBuilder();
  private overviewCache: RepositoryOverview | undefined;
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private moduleNames: readonly string[] = [];

  constructor(
    private readonly source: RepositoryWorkspaceSource,
    options: RepositoryIntelligenceOptions = {},
  ) {
    this.limits = {
      maxAnalyzedFiles: options.maxAnalyzedFiles ?? DEFAULT_REPOSITORY_INTELLIGENCE_LIMITS.maxAnalyzedFiles,
      maxFileChars: options.maxFileChars ?? DEFAULT_REPOSITORY_INTELLIGENCE_LIMITS.maxFileChars,
      maxTotalAnalysisChars:
        options.maxTotalAnalysisChars ?? DEFAULT_REPOSITORY_INTELLIGENCE_LIMITS.maxTotalAnalysisChars,
      maxConfigFiles: options.maxConfigFiles ?? DEFAULT_REPOSITORY_INTELLIGENCE_LIMITS.maxConfigFiles,
      maxConfigChars: options.maxConfigChars ?? DEFAULT_REPOSITORY_INTELLIGENCE_LIMITS.maxConfigChars,
      maxGraphNodes: options.maxGraphNodes ?? DEFAULT_REPOSITORY_INTELLIGENCE_LIMITS.maxGraphNodes,
      maxGraphEdges: options.maxGraphEdges ?? DEFAULT_REPOSITORY_INTELLIGENCE_LIMITS.maxGraphEdges,
      maxCycles: options.maxCycles ?? DEFAULT_REPOSITORY_INTELLIGENCE_LIMITS.maxCycles,
      maxTraversalDepth:
        options.maxTraversalDepth ?? DEFAULT_REPOSITORY_INTELLIGENCE_LIMITS.maxTraversalDepth,
      maxTraversalFiles:
        options.maxTraversalFiles ?? DEFAULT_REPOSITORY_INTELLIGENCE_LIMITS.maxTraversalFiles,
    };
  }

  limitsSnapshot(): RepositoryIntelligenceLimits {
    return {
      maxAnalyzedFiles: this.limits.maxAnalyzedFiles,
      maxFileChars: this.limits.maxFileChars,
      maxTotalAnalysisChars: this.limits.maxTotalAnalysisChars,
      maxGraphNodes: this.limits.maxGraphNodes,
      maxGraphEdges: this.limits.maxGraphEdges,
    };
  }

  invalidate(): void {
    this.entries = undefined;
    this.configContents = undefined;
    this.analyses = new Map<string, FileAnalysis>();
    this.builder = new DependencyGraphBuilder({
      maxNodes: this.limits.maxGraphNodes,
      maxEdges: this.limits.maxGraphEdges,
      maxCycles: this.limits.maxCycles,
      moduleNames: this.moduleNames,
    });
    this.overviewCache = undefined;
    this.loaded = false;
    this.loadPromise = undefined;
  }

  /** Re-analyzes one changed file without rebuilding the rest of the graph. */
  async updateFile(path: string): Promise<void> {
    if (!this.loaded) {
      return;
    }
    const normalized = normalizeWorkspacePath(path);
    if (normalized.length === 0) {
      return;
    }
    if (isConfigPath(normalized)) {
      this.invalidate();
      return;
    }
    if (!isSupportedSourcePath(normalized) || isIgnoredRepositoryPath(normalized)) {
      this.removeFile(normalized);
      return;
    }
    const excluded = isPathExcluded(normalized, this.source.excludeGlobs?.() ?? []);
    if (excluded) {
      this.removeFile(normalized);
      return;
    }
    const content = await this.source.readText(normalized);
    if (content === undefined) {
      this.removeFile(normalized);
      return;
    }
    if (!this.analyses.has(normalized) && this.analyses.size >= this.limits.maxAnalyzedFiles) {
      this.builder.markTruncated();
      return;
    }
    const analysis = analyzeSourceFile(normalized, content, {
      maxFileChars: this.limits.maxFileChars,
    });
    if (analysis.error !== undefined) {
      this.removeFile(normalized);
      return;
    }
    this.analyses.set(normalized, analysis);
    this.builder.upsert(analysis);
    this.overviewCache = undefined;
  }

  removeFile(path: string): void {
    const normalized = normalizeWorkspacePath(path);
    if (normalized.length === 0) {
      return;
    }
    this.analyses.delete(normalized);
    this.builder.remove(normalized);
    this.entries = this.entries?.filter((entry) => entry.path !== normalized);
    this.overviewCache = undefined;
  }

  private async ensureEntries(): Promise<WorkspaceEntry[]> {
    if (this.entries !== undefined) {
      return this.entries;
    }
    const raw = await this.source.listEntries();
    this.entries = raw.map((entry) => ({
      path: normalizeWorkspacePath(entry.path),
      size: entry.size,
    }));
    return this.entries;
  }

  private async loadConfigContents(entries: readonly WorkspaceEntry[]): Promise<Readonly<Record<string, string>>> {
    if (this.configContents !== undefined) {
      return this.configContents;
    }
    const contents: Record<string, string> = {};
    const candidates = entries
      .map((entry) => entry.path)
      .filter((path) => isConfigPath(path))
      .slice(0, this.limits.maxConfigFiles);
    for (const path of candidates) {
      try {
        const content = await this.source.readText(path);
        if (content !== undefined && content.length <= this.limits.maxConfigChars && !content.includes('\u0000')) {
          contents[path] = content;
        }
      } catch {
        // A missing or unreadable manifest contributes its path only.
      }
    }
    this.configContents = contents;
    return contents;
  }

  private analysisCandidates(entries: readonly WorkspaceEntry[]): WorkspaceEntry[] {
    const excluded = this.source.excludeGlobs?.() ?? [];
    return entries
      .filter((entry) => isSupportedSourcePath(entry.path))
      .filter((entry) => !isIgnoredRepositoryPath(entry.path))
      .filter((entry) => !isPathExcluded(entry.path, excluded))
      .filter((entry) => entry.size === undefined || entry.size <= this.limits.maxFileChars * 8)
      .sort((left, right) => {
        const leftTest = isTestPath(left.path) ? 1 : 0;
        const rightTest = isTestPath(right.path) ? 1 : 0;
        return leftTest - rightTest || left.path.localeCompare(right.path);
      });
  }

  private async load(): Promise<void> {
    this.loadPromise = (async () => {
      const entries = await this.ensureEntries();
      const configContents = await this.loadConfigContents(entries);
      const modules = Object.entries(configContents)
        .map(([path, content]) => manifestModuleName(path, content))
        .filter((name): name is string => name !== undefined);
      this.moduleNames = [...new Set(modules)].slice(0, 20);
      this.builder = new DependencyGraphBuilder({
        maxNodes: this.limits.maxGraphNodes,
        maxEdges: this.limits.maxGraphEdges,
        maxCycles: this.limits.maxCycles,
        moduleNames: this.moduleNames,
      });
      this.analyses = new Map<string, FileAnalysis>();
      let totalChars = 0;
      let analyzed = 0;
      for (const entry of this.analysisCandidates(entries)) {
        if (analyzed >= this.limits.maxAnalyzedFiles) {
          this.builder.markTruncated();
          break;
        }
        if (totalChars >= this.limits.maxTotalAnalysisChars) {
          this.builder.markTruncated();
          break;
        }
        let content: string | undefined;
        try {
          content = await this.source.readText(entry.path);
        } catch {
          content = undefined;
        }
        if (content === undefined || content.includes('\u0000')) {
          continue;
        }
        const bounded = content.slice(0, this.limits.maxFileChars);
        totalChars += bounded.length;
        const analysis = analyzeSourceFile(entry.path, bounded, {
          maxFileChars: this.limits.maxFileChars,
        });
        if (analysis.error !== undefined) {
          continue;
        }
        this.analyses.set(entry.path, analysis);
        this.builder.upsert(analysis);
        analyzed += 1;
      }
      this.loaded = true;
    })();
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = undefined;
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    if (this.loadPromise !== undefined) {
      await this.loadPromise;
      return;
    }
    await this.load();
  }

  async overview(): Promise<RepositoryOverview> {
    if (this.overviewCache !== undefined) {
      return this.overviewCache;
    }
    const entries = await this.ensureEntries();
    const configContents = await this.loadConfigContents(entries);
    this.overviewCache = discoverRepository({
      rootName: this.source.rootName(),
      entries,
      configContents,
      excludeGlobs: this.source.excludeGlobs?.() ?? [],
      maxEntries: this.limits.maxGraphNodes * 4,
    });
    return this.overviewCache;
  }

  async graph(): Promise<DependencyGraph> {
    await this.ensureLoaded();
    return this.builder.snapshot();
  }

  async selectContext(
    query: string,
    options: ContextSelectionOptions,
  ): Promise<RepositoryContextSelection> {
    await this.ensureLoaded();
    const entries = this.entries ?? [];
    const analyses = [...this.analyses.values()];
    const relations = findLanguageRelations(entries, analyses, {
      ...(this.configContents !== undefined ? { fileContents: this.configContents } : {}),
    });
    return selectRepositoryContext(query, entries, analyses, this.builder.snapshot(), { ...options, relations });
  }

  async findSymbols(
    query: string,
    limit = 50,
  ): Promise<readonly { readonly path: string; readonly name: string; readonly kind: string; readonly line: number; readonly exported: boolean; readonly confidence: string }[]> {
    await this.ensureLoaded();
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
      return [];
    }
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    const results: { path: string; name: string; kind: string; line: number; exported: boolean; confidence: string }[] = [];
    for (const analysis of this.analyses.values()) {
      for (const symbol of analysis.symbols) {
        if (symbol.name.toLowerCase().includes(needle)) {
          results.push({
            path: analysis.path,
            name: symbol.name,
            kind: symbol.kind,
            line: symbol.line,
            exported: symbol.exported,
            confidence: symbol.confidence,
          });
          if (results.length >= boundedLimit) {
            return results;
          }
        }
      }
    }
    return results;
  }

  async analyzeChanges(
    changes: readonly FileChange[],
    validationCommands: readonly string[] = [],
  ): Promise<ChangeImpact> {
    await this.ensureLoaded();
    const overview = await this.overview();
    return analyzeChangeImpact(
      changes,
      [...this.analyses.values()],
      this.builder.snapshot(),
      overview,
      {
        maxDepth: this.limits.maxTraversalDepth,
        maxFiles: this.limits.maxTraversalFiles,
        validationCommands,
      },
    );
  }

  /** Source-based architecture view: layers, roles and relationships. */
  async architecture(): Promise<ArchitectureAnalysis> {
    await this.ensureLoaded();
    const overview = await this.overview();
    const graph = this.builder.snapshot();
    return analyzeArchitecture([...this.analyses.values()], overview, graph);
  }

  /** Karkain module graph for the analyzed `.kark` files. */
  async karkainGraph(): Promise<KarkainModuleGraph> {
    await this.ensureLoaded();
    return buildKarkainModuleGraph(this.karkainAnalyses());
  }

  /** Karkain project summary, or undefined when no `.kark` source was analyzed. */
  async karkainProject(): Promise<KarkainProjectSummary | undefined> {
    await this.ensureLoaded();
    const analyses = this.karkainAnalyses();
    if (analyses.length === 0) {
      return undefined;
    }
    return summarizeKarkainProject(this.source.rootName(), analyses, buildKarkainModuleGraph(analyses));
  }

  /** Relevant multi-file Karkain context for a task query. */
  async karkainContext(
    query: string,
    options: KarkainContextOptions = {},
  ): Promise<KarkainContextResult> {
    await this.ensureLoaded();
    return collectKarkainContext(query, this.karkainAnalyses(), options);
  }

  private karkainAnalyses(): FileAnalysis[] {
    return [...this.analyses.values()].filter((analysis) => analysis.language === 'karkain');
  }

  /** Test/diagnostic access to analyzed languages without exposing content. */
  analyzedLanguages(): readonly string[] {
    return [...new Set([...this.analyses.keys()].map((path) => languageForPath(path) ?? 'unknown'))].sort();
  }
}
