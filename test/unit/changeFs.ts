import type { ChangeFs } from '../../src/changes/fs';

export class MemoryChangeFs implements ChangeFs {
  readonly files = new Map<string, string>();
  readonly backups = new Map<string, string>();
  readonly calls: string[] = [];

  constructor(initial: Readonly<Record<string, string>> = {}) {
    for (const [path, content] of Object.entries(initial)) {
      this.files.set(path, content);
    }
  }

  async readText(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async writeText(path: string, content: string): Promise<void> {
    this.calls.push(`write:${path}`);
    this.files.set(path, content);
  }

  async deleteFile(path: string): Promise<void> {
    this.calls.push(`delete:${path}`);
    this.files.delete(path);
  }

  async move(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    if (content === undefined) {
      throw new Error('The source file does not exist.');
    }
    this.calls.push(`move:${from}->${to}`);
    this.files.delete(from);
    this.files.set(to, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async writeBackup(name: string, content: string): Promise<void> {
    this.backups.set(name, content);
  }

  async readBackup(name: string): Promise<string | undefined> {
    return this.backups.get(name);
  }

  async removeBackup(name: string): Promise<void> {
    this.backups.delete(name);
  }
}
