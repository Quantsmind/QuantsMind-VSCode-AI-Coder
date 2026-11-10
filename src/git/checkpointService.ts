import { hashContent } from '../changes/model';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface FileSnapshot {
  readonly path: string;
  readonly content: string;
  readonly hash: string;
  readonly size: number;
}

export interface FileCheckpoint {
  readonly id: string;
  readonly taskId: string;
  readonly label?: string;
  readonly createdAt: string;
  readonly files: readonly FileSnapshot[];
}

export interface CheckpointRestoreResult {
  readonly restored: readonly string[];
  readonly alreadyIntact: readonly string[];
  readonly conflicts: readonly { readonly path: string; readonly reason: string }[];
  readonly missingFiles: readonly string[];
}

export interface CheckpointServiceOptions {
  readonly maxEntries?: number;
  readonly maxFileChars?: number;
  readonly maxFilesPerCheckpoint?: number;
}

const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_FILE_CHARS = 4_000_000;
const DEFAULT_MAX_FILES = 100;

function sequenceId(): string {
  return `ckpt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Content snapshots bound to a task. Checkpoints capture file bytes and a
 * hash before substantive agent edits and restore them later without ever
 * overwriting changes the user made since the checkpoint.
 *
 * Restore policy:
 *  - file missing now        -> write it back (restored)
 *  - file equals snapshot    -> nothing to do (already intact)
 *  - file differs            -> conflict; the user's version is kept (never overwritten)
 */
export class CheckpointService {
  private readonly maxEntries: number;
  private readonly maxFileChars: number;
  private readonly maxFilesPerCheckpoint: number;
  private checkpoints: FileCheckpoint[] = [];
  private sequence = 0;

  constructor(options: CheckpointServiceOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxFileChars = Math.max(1_000, options.maxFileChars ?? DEFAULT_MAX_FILE_CHARS);
    this.maxFilesPerCheckpoint = Math.max(1, options.maxFilesPerCheckpoint ?? DEFAULT_MAX_FILES);
  }

  private trim(): void {
    while (this.checkpoints.length > this.maxEntries) {
      this.checkpoints.shift();
    }
  }

  /** Creates a checkpoint from already-read file contents. */
  create(taskId: string, files: readonly { readonly path: string; readonly content: string }[], label?: string): FileCheckpoint {
    const bounded = files.slice(0, this.maxFilesPerCheckpoint);
    const snapshots: FileSnapshot[] = [];
    for (const file of bounded) {
      const content = String(file.content).slice(0, this.maxFileChars);
      snapshots.push({
        path: file.path,
        content,
        hash: hashContent(content),
        size: content.length,
      });
    }
    const checkpoint: FileCheckpoint = {
      id: `ckpt-${(++this.sequence).toString(36)}-${sequenceId()}`,
      taskId,
      ...(label !== undefined && label.trim().length > 0 ? { label: label.trim().slice(0, 200) } : {}),
      createdAt: new Date().toISOString(),
      files: snapshots,
    };
    this.checkpoints.push(checkpoint);
    this.trim();
    return checkpoint;
  }

  /** Creates a checkpoint from files on disk, resolving relative paths against root. */
  async createFromFs(
    taskId: string,
    paths: readonly string[],
    root: string,
    label?: string,
  ): Promise<FileCheckpoint> {
    const files: { path: string; content: string }[] = [];
    for (const rawPath of paths.slice(0, this.maxFilesPerCheckpoint)) {
      const normalized = rawPath.replace(/\\/g, '/');
      if (normalized.includes('\0') || path.isAbsolute(normalized)) {
        continue;
      }
      const resolved = path.resolve(root, normalized);
      const relative = path.relative(root, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        continue;
      }
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isFile() || stat.size > this.maxFileChars) {
          continue;
        }
        const content = await fs.readFile(resolved, 'utf8');
        files.push({ path: normalized, content });
      } catch {
        // Missing or unreadable files are skipped; other errors must not abort the checkpoint.
      }
    }
    return this.create(taskId, files, label);
  }

  list(taskId?: string): readonly FileCheckpoint[] {
    return this.checkpoints
      .filter((checkpoint) => taskId === undefined || checkpoint.taskId === taskId)
      .slice()
      .reverse();
  }

  get(id: string): FileCheckpoint | undefined {
    return this.checkpoints.find((checkpoint) => checkpoint.id === id);
  }

  clearTask(taskId: string): void {
    this.checkpoints = this.checkpoints.filter((checkpoint) => checkpoint.taskId !== taskId);
  }

  clear(): void {
    this.checkpoints = [];
  }

  /** Restores files from a checkpoint. Never overwrites diverging user edits. */
  async restore(id: string, root: string): Promise<CheckpointRestoreResult | undefined> {
    const checkpoint = this.get(id);
    if (checkpoint === undefined) {
      return undefined;
    }
    const restored: string[] = [];
    const alreadyIntact: string[] = [];
    const conflicts: { path: string; reason: string }[] = [];
    const missingFiles: string[] = [];
    for (const file of checkpoint.files) {
      const resolved = path.resolve(root, file.path);
      const relative = path.relative(root, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        conflicts.push({ path: file.path, reason: 'The checkpoint path resolves outside the workspace.' });
        continue;
      }
      let current: string | undefined;
      try {
        current = await fs.readFile(resolved, 'utf8');
      } catch {
        current = undefined;
      }
      if (current === undefined) {
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, file.content, 'utf8');
        missingFiles.push(file.path);
        restored.push(file.path);
        continue;
      }
      if (hashContent(current) === file.hash) {
        alreadyIntact.push(file.path);
        continue;
      }
      conflicts.push({ path: file.path, reason: 'The file changed since the checkpoint was taken.' });
    }
    return { restored, alreadyIntact, conflicts, missingFiles };
  }
}
