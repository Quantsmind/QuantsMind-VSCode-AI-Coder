import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { normalizeChangePath } from './model';

export interface ChangeFs {
  readText(path: string): Promise<string | undefined>;
  writeText(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  writeBackup(name: string, content: string): Promise<void>;
  readBackup(name: string): Promise<string | undefined>;
  removeBackup(name: string): Promise<void>;
}

export class WorkspaceChangeFs implements ChangeFs {
  constructor(
    private readonly root: vscode.Uri,
    private readonly backupRoot: vscode.Uri,
  ) {}

  private ensureFileScheme(uri: vscode.Uri, label: string): void {
    if (uri.scheme !== 'file') {
      throw new Error(`${label} uses an unsupported filesystem scheme.`);
    }
  }

  private async canonicalRoot(): Promise<string> {
    this.ensureFileScheme(this.root, 'Workspace root');
    try {
      return await fsp.realpath(this.root.fsPath);
    } catch {
      throw new Error('The workspace root could not be resolved.');
    }
  }

  private async resolve(relativePath: string): Promise<vscode.Uri> {
    this.ensureFileScheme(this.root, 'Workspace root');
    const normalized = normalizeChangePath(relativePath);
    if (normalized === undefined) {
      throw new Error('Unsafe workspace path.');
    }

    const rootReal = await this.canonicalRoot();
    const targetAbs = path.resolve(this.root.fsPath, normalized);

    const lexical = path.relative(this.root.fsPath, targetAbs);
    if (lexical !== '' && (lexical.startsWith('..') || path.isAbsolute(lexical))) {
      throw new Error('Path escapes the workspace.');
    }

    let ancestor = targetAbs;
    while (true) {
      try {
        await fsp.lstat(ancestor);
        break;
      } catch {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          break;
        }
        ancestor = parent;
      }
    }
    if (!ancestor.startsWith(this.root.fsPath)) {
      ancestor = this.root.fsPath;
    }

    let realAncestor: string;
    try {
      realAncestor = await fsp.realpath(ancestor);
    } catch {
      throw new Error('The target path could not be resolved.');
    }
    const ancestorRelative = path.relative(rootReal, realAncestor);
    if (ancestorRelative.startsWith('..') || path.isAbsolute(ancestorRelative)) {
      throw new Error('Path escapes the workspace through a link.');
    }

    try {
      const realTarget = await fsp.realpath(targetAbs);
      const targetRelative = path.relative(rootReal, realTarget);
      if (targetRelative.startsWith('..') || path.isAbsolute(targetRelative)) {
        throw new Error('Path escapes the workspace through a link.');
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (error instanceof Error && error.message.includes('escapes the workspace')) {
        throw error;
      }
      if (code !== 'ENOENT' && code !== undefined) {
        throw error;
      }
    }

    const parts = normalized.split('/');
    let current = this.root.fsPath;
    for (const part of parts) {
      current = path.join(current, part);
      if (current === targetAbs) {
        break;
      }
      try {
        const stat = await fsp.lstat(current);
        if (stat.isSymbolicLink()) {
          const real = await fsp.realpath(current);
          const rel = path.relative(rootReal, real);
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error('Path escapes the workspace through a link.');
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('escapes the workspace')) {
          throw error;
        }
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT' && code !== undefined) {
          throw error;
        }
      }
    }

    return vscode.Uri.file(targetAbs);
  }

  async readText(relativePath: string): Promise<string | undefined> {
    const uri = await this.resolve(relativePath);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.Directory) !== 0) {
        throw new Error('The path is a directory.');
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString('utf8');
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        return undefined;
      }
      throw error;
    }
  }

  async writeText(relativePath: string, content: string): Promise<void> {
    const uri = await this.resolve(relativePath);
    const parent = vscode.Uri.joinPath(uri, '..');
    await vscode.workspace.fs.createDirectory(parent);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  }

  async deleteFile(relativePath: string): Promise<void> {
    await vscode.workspace.fs.delete(await this.resolve(relativePath), {
      recursive: false,
      useTrash: false,
    });
  }

  async move(from: string, to: string): Promise<void> {
    const source = await this.resolve(from);
    const target = await this.resolve(to);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
    await vscode.workspace.fs.rename(source, target, { overwrite: false });
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(await this.resolve(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  private backupUri(name: string): vscode.Uri {
    this.ensureFileScheme(this.backupRoot, 'Backup root');
    const safeName = path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
    if (safeName.length === 0) {
      throw new Error('Invalid backup name.');
    }
    return vscode.Uri.joinPath(this.backupRoot, safeName);
  }

  async writeBackup(name: string, content: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.backupRoot);
    await vscode.workspace.fs.writeFile(this.backupUri(name), Buffer.from(content, 'utf8'));
  }

  async readBackup(name: string): Promise<string | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.backupUri(name));
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return undefined;
    }
  }

  async removeBackup(name: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.backupUri(name), { recursive: false, useTrash: false });
    } catch {
      // A missing backup is already the desired end state.
    }
  }
}
