import * as vscode from 'vscode';
import type { SettingsService } from '../config/settings';
import {
  buildContext,
  isPathExcluded,
  type BuildContextResult,
  type ContextCandidate,
} from './filters';

export interface ContextReadFailure {
  readonly path: string;
  readonly message: string;
}

export interface ContextReadResult {
  readonly candidates: ContextCandidate[];
  readonly failures: ContextReadFailure[];
}

export class ContextService {
  constructor(private readonly settings: SettingsService) {}

  displayPath(uri: vscode.Uri): string {
    if (uri.scheme === 'untitled') {
      return uri.path.length > 0 ? uri.path : 'untitled';
    }
    return vscode.workspace.asRelativePath(uri, false);
  }

  fromSelection(editor: vscode.TextEditor): ContextCandidate | undefined {
    const selection = editor.selection;
    if (selection.isEmpty) {
      return undefined;
    }
    const content = editor.document.getText(selection);
    if (content.trim().length === 0) {
      return undefined;
    }
    return {
      path: this.displayPath(editor.document.uri),
      content,
      languageId: editor.document.languageId,
      isSelection: true,
      startLine: selection.start.line + 1,
      endLine: selection.end.line + 1,
    };
  }

  fromActiveFile(editor: vscode.TextEditor): ContextCandidate | undefined {
    const content = editor.document.getText();
    if (content.trim().length === 0) {
      return undefined;
    }
    return {
      path: this.displayPath(editor.document.uri),
      content,
      languageId: editor.document.languageId,
      isSelection: false,
    };
  }

  async readUris(uris: readonly vscode.Uri[]): Promise<ContextReadResult> {
    const candidates: ContextCandidate[] = [];
    const failures: ContextReadFailure[] = [];
    const { maxFileSizeBytes } = this.settings.getContextSettings();

    for (const uri of uris) {
      const displayPath = this.displayPath(uri);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (typeof stat.size === 'number' && stat.size > maxFileSizeBytes) {
          failures.push({
            path: displayPath,
            message: 'File is larger than the configured context size limit.',
          });
          continue;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        candidates.push({
          path: displayPath,
          content: Buffer.from(bytes).toString('utf8'),
          languageId: undefined,
        });
      } catch (error) {
        failures.push({
          path: displayPath,
          message: error instanceof Error ? error.message : 'Unable to read file.',
        });
      }
    }

    return { candidates, failures };
  }

  async listAttachableFiles(limit = 2000): Promise<vscode.Uri[]> {
    const files = await vscode.workspace.findFiles('**/*', undefined, limit);
    const { excludeGlobs } = this.settings.getContextSettings();
    return files
      .filter((uri) => !isPathExcluded(this.displayPath(uri), excludeGlobs))
      .sort((left, right) =>
        this.displayPath(left).localeCompare(this.displayPath(right), undefined, {
          sensitivity: 'base',
        }),
      );
  }

  async build(
    candidates: readonly ContextCandidate[],
    secret?: string,
  ): Promise<BuildContextResult> {
    return buildContext(candidates, this.settings.getContextSettings(), secret);
  }
}
