import * as vscode from 'vscode';
import type { SettingsService } from '../config/settings';
import {
  buildContext,
  isPathExcluded,
  type ContextCandidate,
  type RedactedContextItem,
} from '../context/filters';
import type { Logger } from '../security/logger';
import { isTrusted, type TrustCheck } from '../security/workspaceTrust';
import type { FileChange } from '../changes/model';
import type {
  ContextSelectionOptions,
  RepositoryContextSelection,
} from '../repository/contextSelection';
import type { RepositoryOverview } from '../repository/discovery';
import type { DependencyGraph } from '../repository/graph';
import type { ChangeImpact } from '../repository/impact';
import type { ArchitectureAnalysis } from '../project/architecture';
import type {
  KarkainContextOptions,
  KarkainContextResult,
  KarkainModuleGraph,
  KarkainProjectSummary,
} from '../project/karkain';
import { RepositoryIntelligenceService } from '../repository/repositoryIntelligence';
import {
  buildWorkspaceSummary,
  entryPointsOf,
  isTestPath,
  normalizeWorkspacePath,
  rankRelevantFiles,
  type WorkspaceEntry,
  type WorkspaceSummary,
} from './analyze';
import { createIgnoreMatcher } from './ignore';
import { selectWorkspaceRoot } from './rootPolicy';

export interface RetrievalResult {
  readonly summary: WorkspaceSummary;
  readonly items: readonly RedactedContextItem[];
  readonly reasons: Readonly<Record<string, string>>;
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  readonly truncated: boolean;
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  jsx: 'javascriptreact',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  swift: 'swift',
  sh: 'shellscript',
  ps1: 'powershell',
  sql: 'sql',
  md: 'markdown',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  css: 'css',
  html: 'html',
};

function languageIdForPath(path: string): string | undefined {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
}

/**
 * Builds a local, in-memory index of workspace paths on demand. Nothing is
 * transmitted anywhere: callers decide when to place retrieved files into a
 * provider request.
 */
export class WorkspaceIndexService {
  private entries: WorkspaceEntry[] | undefined;
  private rootName = 'workspace';
  private rootKey = '';
  private warnedUntrusted = false;
  private repositoryService: RepositoryIntelligenceService | undefined;

  constructor(
    private readonly settings: SettingsService,
    private readonly logger: Logger,
    private readonly trustCheck: TrustCheck | undefined = () => vscode.workspace.isTrusted,
  ) {}

  /**
   * Every index read passes through here. A revoked trust grant must not keep
   * serving the previously built cache, so the check runs before the cache is
   * consulted, not only while building it.
   */
  private isTrusted(): boolean {
    if (isTrusted(this.trustCheck)) {
      return true;
    }
    if (!this.warnedUntrusted) {
      this.warnedUntrusted = true;
      this.logger.info('workspace index is disabled while the workspace is in Restricted Mode');
    }
    return false;
  }

  invalidate(): void {
    this.entries = undefined;
    this.repositoryService?.invalidate();
  }

  /**
   * The repository-intelligence service is owned here so its snapshots reuse
   * the same trust check, exclusions, and workspace entry list as retrieval.
   */
  repositoryIntelligence(): RepositoryIntelligenceService {
    if (this.repositoryService === undefined) {
      this.repositoryService = new RepositoryIntelligenceService({
        rootName: () => this.rootName,
        listEntries: () => this.getEntries(),
        readText: (pathToRead) => this.readOptional(pathToRead),
        excludeGlobs: () => this.settings.getContextSettings().excludeGlobs,
      });
    }
    return this.repositoryService;
  }

  async repositoryOverview(): Promise<RepositoryOverview | undefined> {
    if (!this.isTrusted()) {
      return undefined;
    }
    try {
      return await this.repositoryIntelligence().overview();
    } catch (error) {
      this.logger.warn(`repository overview failed: ${String(error)}`);
      return undefined;
    }
  }

  async dependencyGraph(): Promise<DependencyGraph | undefined> {
    if (!this.isTrusted()) {
      return undefined;
    }
    try {
      return await this.repositoryIntelligence().graph();
    } catch (error) {
      this.logger.warn(`dependency graph failed: ${String(error)}`);
      return undefined;
    }
  }

  async selectRepositoryContext(
    query: string,
    options: ContextSelectionOptions,
  ): Promise<RepositoryContextSelection | undefined> {
    if (!this.isTrusted()) {
      return undefined;
    }
    try {
      return await this.repositoryIntelligence().selectContext(query, options);
    } catch (error) {
      this.logger.warn(`repository context selection failed: ${String(error)}`);
      return undefined;
    }
  }

  async analyzeChangeImpact(
    changes: readonly FileChange[],
    validationCommands: readonly string[] = [],
  ): Promise<ChangeImpact | undefined> {
    if (!this.isTrusted()) {
      return undefined;
    }
    try {
      return await this.repositoryIntelligence().analyzeChanges(changes, validationCommands);
    } catch (error) {
      this.logger.warn(`change impact analysis failed: ${String(error)}`);
      return undefined;
    }
  }

  async architectureAnalysis(): Promise<ArchitectureAnalysis | undefined> {
    if (!this.isTrusted()) {
      return undefined;
    }
    try {
      return await this.repositoryIntelligence().architecture();
    } catch (error) {
      this.logger.warn(`architecture analysis failed: ${String(error)}`);
      return undefined;
    }
  }

  async karkainProject(): Promise<KarkainProjectSummary | undefined> {
    if (!this.isTrusted()) {
      return undefined;
    }
    try {
      return await this.repositoryIntelligence().karkainProject();
    } catch (error) {
      this.logger.warn(`Karkain project analysis failed: ${String(error)}`);
      return undefined;
    }
  }

  async karkainGraph(): Promise<KarkainModuleGraph | undefined> {
    if (!this.isTrusted()) {
      return undefined;
    }
    try {
      return await this.repositoryIntelligence().karkainGraph();
    } catch (error) {
      this.logger.warn(`Karkain module graph failed: ${String(error)}`);
      return undefined;
    }
  }

  async karkainContext(
    query: string,
    options: KarkainContextOptions = {},
  ): Promise<KarkainContextResult | undefined> {
    if (!this.isTrusted()) {
      return undefined;
    }
    try {
      return await this.repositoryIntelligence().karkainContext(query, options);
    } catch (error) {
      this.logger.warn(`Karkain context analysis failed: ${String(error)}`);
      return undefined;
    }
  }

  /** Incrementally re-analyzes a single changed source file. */
  async updateIndexedFile(filePath: string): Promise<void> {
    if (!this.isTrusted()) {
      return;
    }
    try {
      await this.repositoryIntelligence().updateFile(filePath);
    } catch (error) {
      this.logger.warn(`incremental repository update failed: ${String(error)}`);
    }
  }

  removeIndexedFile(filePath: string): void {
    this.repositoryService?.removeFile(filePath);
  }

  private getRoot(): vscode.WorkspaceFolder | undefined {
    return selectWorkspaceRoot(vscode.workspace.workspaceFolders);
  }

  listRoots(): readonly vscode.WorkspaceFolder[] {
    return vscode.workspace.workspaceFolders ?? [];
  }

  private async readOptional(path: string): Promise<string | undefined> {
    const root = this.getRoot();
    if (root === undefined) {
      return undefined;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root.uri, path));
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return undefined;
    }
  }

  private async buildIndex(): Promise<WorkspaceEntry[]> {
    const root = this.getRoot();
    if (root === undefined) {
      return [];
    }

    this.rootName = root.name;
    const workspaceSettings = this.settings.getWorkspaceSettings();
    const contextSettings = this.settings.getContextSettings();
    const [gitignore, gitExclude] = await Promise.all([
      this.readOptional('.gitignore'),
      this.readOptional('.git/info/exclude'),
    ]);
    const ignored = createIgnoreMatcher([gitignore, gitExclude]);

    // Scope the glob to the selected root. An unscoped '**/*' searches every
    // workspace folder, and asRelativePath then collapses files from different
    // roots into colliding relative paths under a single root name.
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(root, '**/*'),
      undefined,
      workspaceSettings.maxIndexedFiles * 2,
    );

    const entries: WorkspaceEntry[] = [];
    for (const uri of uris) {
      const path = normalizeWorkspacePath(vscode.workspace.asRelativePath(uri, false));
      if (path.length === 0) {
        continue;
      }
      if (isPathExcluded(path, contextSettings.excludeGlobs)) {
        continue;
      }
      if (ignored(path, false)) {
        continue;
      }
      entries.push({ path });
      if (entries.length >= workspaceSettings.maxIndexedFiles) {
        break;
      }
    }

    entries.sort((left, right) => left.path.localeCompare(right.path));
    this.logger.info(`workspace index built: files=${entries.length}`);
    return entries;
  }

  async getEntries(): Promise<readonly WorkspaceEntry[]> {
    if (!this.isTrusted()) {
      return [];
    }
    const root = this.getRoot();
    const rootKey = root === undefined ? '' : root.uri.toString();
    if (this.entries !== undefined && this.rootKey !== rootKey) {
      this.entries = undefined;
      this.repositoryService?.invalidate();
    }
    this.rootKey = rootKey;
    if (this.entries === undefined) {
      this.entries = await this.buildIndex();
    }
    return this.entries;
  }

  async summarize(): Promise<WorkspaceSummary> {
    const entries = await this.getEntries();
    return buildWorkspaceSummary(this.rootName, entries);
  }

  async retrieve(query: string, secret?: string): Promise<RetrievalResult> {
    const entries = await this.getEntries();
    const summary = buildWorkspaceSummary(this.rootName, entries);
    if (!this.isTrusted()) {
      return { summary, items: [], reasons: {}, skipped: [], truncated: false };
    }
    const workspaceSettings = this.settings.getWorkspaceSettings();
    const contextSettings = this.settings.getContextSettings();
    const root = this.getRoot();
    const budget = Math.min(workspaceSettings.retrievalMaxChars, contextSettings.maxTotalChars);

    if (root === undefined || entries.length === 0) {
      return {
        summary,
        items: [],
        reasons: {},
        skipped: [],
        truncated: false,
      };
    }

    const ranked = rankRelevantFiles(query, entries, {
      maxFiles: workspaceSettings.maxRetrievedFiles,
    });
    const reasons: Record<string, string> = {};
    const skipped: { path: string; reason: string }[] = [];
    const candidates: ContextCandidate[] = [];
    let totalChars = 0;
    let truncated = false;

    // Symbol and dependency evidence expands the query ranking, but the
    // existing workspace provenance, redaction, and budget gates still apply
    // to every file before it can reach the provider.
    const selected = await this.selectRepositoryContext(query, {
      maxFiles: workspaceSettings.maxRetrievedFiles,
      maxChars: budget,
    });
    const ordered: { readonly path: string; readonly reason: string }[] = [];
    const seenPaths = new Set<string>();
    for (const selection of selected?.selections ?? []) {
      if (seenPaths.has(selection.path)) {
        continue;
      }
      seenPaths.add(selection.path);
      ordered.push({
        path: selection.path,
        reason: `repository context: ${selection.reason} (${selection.confidence})`,
      });
    }
    for (const item of ranked) {
      if (seenPaths.has(item.path)) {
        continue;
      }
      seenPaths.add(item.path);
      ordered.push({ path: item.path, reason: item.reason });
    }
    if (selected?.truncated === true) {
      truncated = true;
    }

    for (const item of ordered) {
      const uri = vscode.Uri.joinPath(root.uri, item.path);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (typeof stat.size === 'number' && stat.size > contextSettings.maxFileSizeBytes) {
          skipped.push({ path: item.path, reason: 'file too large' });
          continue;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(bytes).toString('utf8');
        if (content.length === 0) {
          skipped.push({ path: item.path, reason: 'empty content' });
          continue;
        }
        if (content.includes('\u0000')) {
          skipped.push({ path: item.path, reason: 'binary content' });
          continue;
        }
        if (totalChars + content.length > budget) {
          truncated = true;
          skipped.push({ path: item.path, reason: 'context budget reached' });
          continue;
        }
        candidates.push({
          path: item.path,
          content,
          languageId: languageIdForPath(item.path),
          origin: 'workspace',
        });
        reasons[item.path] = item.reason;
        totalChars += content.length;
      } catch (error) {
        this.logger.warn(`workspace retrieval could not read a file: ${item.path}`);
        skipped.push({ path: item.path, reason: 'unreadable' });
        void error;
      }
    }

    const built = buildContext(candidates, {
      ...contextSettings,
      maxFiles: workspaceSettings.maxRetrievedFiles,
      maxTotalChars: budget,
    }, secret);

    return {
      summary,
      items: built.items,
      reasons,
      skipped: [
        ...skipped,
        ...built.skipped.map((item) => ({ path: item.path, reason: item.reason })),
      ],
      truncated,
    };
  }

  entryPoints(): Promise<readonly string[]> {
    return this.getEntries().then((entries) => entryPointsOf(entries));
  }

  async isTestOnly(path: string): Promise<boolean> {
    return isTestPath(normalizeWorkspacePath(path));
  }
}
