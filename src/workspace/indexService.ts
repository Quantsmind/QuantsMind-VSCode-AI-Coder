import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SettingsService } from '../config/settings';
import { buildContext, isPathExcluded, type RedactedContextItem } from '../context/filters';
import type { Logger } from '../security/logger';
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

  constructor(
    private readonly settings: SettingsService,
    private readonly logger: Logger,
  ) {}

  invalidate(): void {
    this.entries = undefined;
  }

  private scoreRoot(folder: vscode.WorkspaceFolder): number {
    const fsPath = folder.uri.fsPath;
    let score = 0;
    try {
            if (fs.existsSync(path.join(fsPath, 'package.json'))) score += 5;
      if (fs.existsSync(path.join(fsPath, 'src'))) score += 3;
      if (fs.existsSync(path.join(fsPath, 'docs'))) score += 2;
      if (fs.existsSync(path.join(fsPath, '.git'))) score += 2;
      if (fs.existsSync(path.join(fsPath, 'README.md'))) score += 1;
    } catch {
      // Ignore filesystem scoring errors.
    }
    return score;
  }

  private getRoot(): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }
    if (folders.length === 1) {
      return folders[0];
    }
    let best = folders[0];
    let bestScore = this.scoreRoot(best);
    for (let index = 1; index < folders.length; index += 1) {
      const candidate = folders[index];
      const score = this.scoreRoot(candidate);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
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

    const uris = await vscode.workspace.findFiles(
      '**/*',
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
    const root = this.getRoot();
    const rootKey = root === undefined ? '' : root.uri.toString();
    if (this.entries !== undefined && this.rootKey !== rootKey) {
      this.entries = undefined;
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
    const candidates = [];
    let totalChars = 0;
    let truncated = false;

    for (const item of ranked) {
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
