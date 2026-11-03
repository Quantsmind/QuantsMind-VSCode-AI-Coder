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

  private resolve(relativePath: string): vscode.Uri {
    const normalized = normalizeChangePath(relativePath);
    if (normalized === undefined) {
      throw new Error('Unsafe workspace path.');
    }
    const uri = vscode.Uri.joinPath(this.root, normalized);
    const relative = path.relative(this.root.fsPath, uri.fsPath);
    if (
      relative.length === 0 ||
      relative.startsWith('..') ||
      path.isAbsolute(relative)
    ) {
      throw new Error('Path escapes the workspace.');
    }
    return uri;
  }

  async readText(relativePath: string): Promise<string | undefined> {
    const uri = this.resolve(relativePath);
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
    const uri = this.resolve(relativePath);
    const parent = vscode.Uri.joinPath(uri, '..');
    await vscode.workspace.fs.createDirectory(parent);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  }

  async deleteFile(relativePath: string): Promise<void> {
    await vscode.workspace.fs.delete(this.resolve(relativePath), {
      recursive: false,
      useTrash: false,
    });
  }

  async move(from: string, to: string): Promise<void> {
    const source = this.resolve(from);
    const target = this.resolve(to);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
    await vscode.workspace.fs.rename(source, target, { overwrite: false });
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(this.resolve(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  private backupUri(name: string): vscode.Uri {
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
