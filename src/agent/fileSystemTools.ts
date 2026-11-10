import type { AgentTool, AgentToolResult } from './codingAgent';
import type { ChangeApprovalService } from './changeTools';
import type { ChangePlan } from '../changes/model';
import { resolveWorkspacePath } from './pathSafety';

export interface WorkspaceStat {
  readonly type: 'file' | 'directory';
  readonly size: number;
}

/**
 * Absolute-path filesystem operations. Every path is resolved and contained by
 * {@link FileSystemTools} before it reaches this interface, so implementations
 * can stay thin and do not repeat the boundary policy.
 */
export interface AgentPathFs {
  createDirectory(absolutePath: string): Promise<void>;
  deletePath(absolutePath: string, recursive: boolean): Promise<void>;
  renamePath(fromAbsolute: string, toAbsolute: string): Promise<void>;
  statPath(absolutePath: string): Promise<WorkspaceStat | undefined>;
  exists(absolutePath: string): Promise<boolean>;
}

export type FileSystemOperation =
  | 'write-file'
  | 'create-folder'
  | 'delete-file'
  | 'delete-folder'
  | 'rename-file'
  | 'rename-folder';

export interface FileSystemApprovalRequest {
  readonly operation: FileSystemOperation;
  readonly path: string;
  readonly details: string;
}

export type FileSystemApproval = (request: FileSystemApprovalRequest) => Promise<boolean>;

export interface FileSystemToolsOptions {
  readonly rootPath: string | (() => string);
  readonly pathFs: AgentPathFs;
  readonly changes: ChangeApprovalService;
  readonly approval: FileSystemApproval;
  readonly trusted?: () => boolean;
  readonly taskId?: () => string;
}

interface ReviewLike {
  readonly kind: string;
  readonly path: string;
  readonly fromPath?: string;
  readonly diff: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown filesystem error.';
}

function fail(tool: string, error: string): AgentToolResult {
  return { ok: false, tool, error, durationMs: 0 };
}

function ok(tool: string, output: string): AgentToolResult {
  return { ok: true, tool, output, durationMs: 0 };
}

/**
 * Workspace mutations that are not content changes: folder creation, path
 * rename/move and deletion, plus a single-file write convenience that reuses
 * the change service so every file mutation keeps its backup and undo entry.
 *
 * File writes, file deletes and file renames go through the change service so
 * they inherit baseline hashing, conflict detection, backups and undo. Folder
 * operations have no content baseline and are performed directly after an
 * explicit approval.
 */
export class FileSystemTools {
  private readonly rootPath: string | (() => string);
  private readonly pathFs: AgentPathFs;
  private readonly changes: ChangeApprovalService;
  private readonly approval: FileSystemApproval;
  private readonly trusted: () => boolean;
  private readonly taskId: () => string;
  private sequence = 0;

  constructor(options: FileSystemToolsOptions) {
    this.rootPath = options.rootPath;
    this.pathFs = options.pathFs;
    this.changes = options.changes;
    this.approval = options.approval;
    this.trusted = options.trusted ?? (() => true);
    this.taskId = options.taskId ?? (() => `agent-fs-${Date.now().toString(36)}-${++this.sequence}`);
  }

  private root(): string {
    return typeof this.rootPath === 'function' ? this.rootPath() : this.rootPath;
  }

  private async resolve(relativePath: string) {
    return resolveWorkspacePath(this.root(), relativePath);
  }

  /** Creates a folder and any missing parents. Idempotent for existing folders. */
  async createFolder(relativePath: unknown): Promise<AgentToolResult> {
    if (typeof relativePath !== 'string') {
      return fail('create_folder', 'A folder path is required.');
    }
    if (!this.trusted()) {
      return fail('create_folder', 'Workspace trust is required to create folders.');
    }
    let resolved;
    try {
      resolved = await this.resolve(relativePath);
    } catch (error) {
      return fail('create_folder', messageOf(error));
    }
    if (resolved.relative.length === 0) {
      return fail('create_folder', 'A folder path is required.');
    }
    try {
      const stat = await this.pathFs.statPath(resolved.absolute);
      if (stat?.type === 'directory') {
        return ok('create_folder', JSON.stringify({ path: resolved.relative, created: false, reason: 'Already exists.' }, null, 2));
      }
      if (stat?.type === 'file') {
        return fail('create_folder', `"${resolved.relative}" is a file, not a folder.`);
      }
      await this.pathFs.createDirectory(resolved.absolute);
      return ok('create_folder', JSON.stringify({ path: resolved.relative, created: true }, null, 2));
    } catch (error) {
      return fail('create_folder', messageOf(error));
    }
  }

  /** Creates or replaces one file through the change service (backup + undo). */
  async writeFile(
    relativePath: unknown,
    content: unknown,
    summary?: unknown,
  ): Promise<AgentToolResult> {
    if (typeof relativePath !== 'string') {
      return fail('write_file', 'A file path is required.');
    }
    if (typeof content !== 'string') {
      return fail('write_file', 'File content must be text.');
    }
    if (!this.trusted()) {
      return fail('write_file', 'Workspace trust is required to write files.');
    }
    let resolved;
    try {
      resolved = await this.resolve(relativePath);
    } catch (error) {
      return fail('write_file', messageOf(error));
    }
    if (resolved.relative.length === 0) {
      return fail('write_file', 'A file path is required.');
    }

    let stat;
    try {
      stat = await this.pathFs.statPath(resolved.absolute);
    } catch (error) {
      return fail('write_file', messageOf(error));
    }
    if (stat?.type === 'directory') {
      return fail('write_file', `"${resolved.relative}" is a directory.`);
    }

    const taskId = this.taskId();
    const kind = stat === undefined ? 'create' : 'modify';
    const planSummary =
      typeof summary === 'string' && summary.trim().length > 0
        ? summary.trim().slice(0, 500)
        : `${kind === 'create' ? 'Create' : 'Modify'} ${resolved.relative}`;
    const plan: ChangePlan = {
      id: taskId,
      summary: planSummary,
      changes: [
        {
          id: 'change-1',
          kind,
          path: resolved.relative,
          content,
          summary: resolved.relative,
        },
      ],
    };

    let prepared;
    try {
      prepared = await this.changes.prepare(plan, taskId);
    } catch (error) {
      return fail('write_file', messageOf(error));
    }
    if (prepared.errors.length > 0) {
      return fail('write_file', prepared.errors.join(' '));
    }

    const approved = await this.approval({
      operation: 'write-file',
      path: resolved.relative,
      details: describeReview(prepared.review),
    });
    if (!approved) {
      return fail('write_file', 'File write requires explicit approval.');
    }

    try {
      const report = await this.changes.apply(prepared.plan, ['change-1'], taskId, planSummary);
      const applied = report.outcome.applied.map((file) => file.path);
      const conflicts = report.outcome.conflicts.map((file) => file.path);
      const failed = report.outcome.failed.map((file) => file.path);
      return {
        ok: applied.length > 0,
        tool: 'write_file',
        output: JSON.stringify({ taskId, path: resolved.relative, kind, applied, conflicts, failed }, null, 2),
        error: applied.length === 0 ? 'The file was not written.' : undefined,
        durationMs: 0,
      };
    } catch (error) {
      return fail('write_file', messageOf(error));
    }
  }

  /** Deletes a file or folder. Files keep a backup; folders require approval. */
  async deletePath(relativePath: unknown, recursive?: unknown): Promise<AgentToolResult> {
    if (typeof relativePath !== 'string') {
      return fail('delete_path', 'A path is required.');
    }
    if (!this.trusted()) {
      return fail('delete_path', 'Workspace trust is required to delete paths.');
    }
    const isRecursive = recursive === true;
    let resolved;
    try {
      resolved = await this.resolve(relativePath);
    } catch (error) {
      return fail('delete_path', messageOf(error));
    }
    if (resolved.relative.length === 0) {
      return fail('delete_path', 'The workspace root cannot be deleted.');
    }

    let stat;
    try {
      stat = await this.pathFs.statPath(resolved.absolute);
    } catch (error) {
      return fail('delete_path', messageOf(error));
    }
    if (stat === undefined) {
      return fail('delete_path', `"${resolved.relative}" does not exist.`);
    }

    if (stat.type === 'directory') {
      const approved = await this.approval({
        operation: 'delete-folder',
        path: resolved.relative,
        details: `Delete folder "${resolved.relative}"${isRecursive ? ' recursively' : ''}.`,
      });
      if (!approved) {
        return fail('delete_path', 'Folder deletion requires explicit approval.');
      }
      try {
        await this.pathFs.deletePath(resolved.absolute, isRecursive);
        return ok(
          'delete_path',
          JSON.stringify({ path: resolved.relative, kind: 'directory', recursive: isRecursive }, null, 2),
        );
      } catch (error) {
        return fail('delete_path', messageOf(error));
      }
    }

    const taskId = this.taskId();
    const planSummary = `Delete ${resolved.relative}`;
    const plan: ChangePlan = {
      id: taskId,
      summary: planSummary,
      changes: [{ id: 'change-1', kind: 'delete', path: resolved.relative, summary: resolved.relative }],
    };
    let prepared;
    try {
      prepared = await this.changes.prepare(plan, taskId);
    } catch (error) {
      return fail('delete_path', messageOf(error));
    }
    if (prepared.errors.length > 0) {
      return fail('delete_path', prepared.errors.join(' '));
    }
    const approved = await this.approval({
      operation: 'delete-file',
      path: resolved.relative,
      details: `Delete file "${resolved.relative}".`,
    });
    if (!approved) {
      return fail('delete_path', 'File deletion requires explicit approval.');
    }
    try {
      const report = await this.changes.apply(prepared.plan, ['change-1'], taskId, planSummary);
      const applied = report.outcome.applied.map((file) => file.path);
      return {
        ok: applied.length > 0,
        tool: 'delete_path',
        output: JSON.stringify({ taskId, path: resolved.relative, kind: 'file', applied }, null, 2),
        error: applied.length === 0 ? 'The file was not deleted.' : undefined,
        durationMs: 0,
      };
    } catch (error) {
      return fail('delete_path', messageOf(error));
    }
  }

  /** Renames or moves a file or folder. Files keep a backup; folders require approval. */
  async renamePath(fromRelative: unknown, toRelative: unknown): Promise<AgentToolResult> {
    if (typeof fromRelative !== 'string' || typeof toRelative !== 'string') {
      return fail('rename_path', 'Both a source and a target path are required.');
    }
    if (!this.trusted()) {
      return fail('rename_path', 'Workspace trust is required to rename paths.');
    }
    let from;
    let to;
    try {
      [from, to] = await Promise.all([this.resolve(fromRelative), this.resolve(toRelative)]);
    } catch (error) {
      return fail('rename_path', messageOf(error));
    }
    if (from.relative.length === 0) {
      return fail('rename_path', 'The workspace root cannot be renamed.');
    }
    if (to.relative.length === 0) {
      return fail('rename_path', 'The workspace root cannot be a rename target.');
    }

    let stat;
    try {
      stat = await this.pathFs.statPath(from.absolute);
    } catch (error) {
      return fail('rename_path', messageOf(error));
    }
    if (stat === undefined) {
      return fail('rename_path', `"${from.relative}" does not exist.`);
    }
    const targetExists = await this.pathFs.exists(to.absolute);
    if (targetExists) {
      return fail('rename_path', `"${to.relative}" already exists.`);
    }

    if (stat.type === 'directory') {
      const approved = await this.approval({
        operation: 'rename-folder',
        path: from.relative,
        details: `Rename folder "${from.relative}" to "${to.relative}".`,
      });
      if (!approved) {
        return fail('rename_path', 'Folder rename requires explicit approval.');
      }
      try {
        await this.pathFs.renamePath(from.absolute, to.absolute);
        return ok(
          'rename_path',
          JSON.stringify({ fromPath: from.relative, toPath: to.relative, kind: 'directory' }, null, 2),
        );
      } catch (error) {
        return fail('rename_path', messageOf(error));
      }
    }

    const taskId = this.taskId();
    const planSummary = `Rename ${from.relative} to ${to.relative}`;
    const plan: ChangePlan = {
      id: taskId,
      summary: planSummary,
      changes: [
        {
          id: 'change-1',
          kind: 'rename',
          path: to.relative,
          fromPath: from.relative,
          summary: `${from.relative} -> ${to.relative}`,
        },
      ],
    };
    let prepared;
    try {
      prepared = await this.changes.prepare(plan, taskId);
    } catch (error) {
      return fail('rename_path', messageOf(error));
    }
    if (prepared.errors.length > 0) {
      return fail('rename_path', prepared.errors.join(' '));
    }
    const approved = await this.approval({
      operation: 'rename-file',
      path: from.relative,
      details: `Rename file "${from.relative}" to "${to.relative}".`,
    });
    if (!approved) {
      return fail('rename_path', 'File rename requires explicit approval.');
    }
    try {
      const report = await this.changes.apply(prepared.plan, ['change-1'], taskId, planSummary);
      const applied = report.outcome.applied.map((file) => file.path);
      return {
        ok: applied.length > 0,
        tool: 'rename_path',
        output: JSON.stringify({ taskId, fromPath: from.relative, toPath: to.relative, kind: 'file', applied }, null, 2),
        error: applied.length === 0 ? 'The file was not renamed.' : undefined,
        durationMs: 0,
      };
    } catch (error) {
      return fail('rename_path', messageOf(error));
    }
  }

  toAgentTools(): readonly AgentTool[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return [
      {
        name: 'write_file',
        description:
          'Create or replace a single workspace file with full content. The write is applied only after explicit approval and can be undone.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
            summary: { type: 'string' },
          },
          required: ['path', 'content'],
        },
        async execute(args) {
          return self.writeFile(args.path, args.content, args.summary);
        },
      },
      {
        name: 'create_folder',
        description: 'Create a workspace folder and any missing parent folders. Does not require approval.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        async execute(args) {
          return self.createFolder(args.path);
        },
      },
      {
        name: 'delete_path',
        description:
          'Delete a workspace file or folder. Files keep a backup for undo; folders are removed directly. Requires explicit approval.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            recursive: { type: 'boolean' },
          },
          required: ['path'],
        },
        async execute(args) {
          return self.deletePath(args.path, args.recursive);
        },
      },
      {
        name: 'rename_path',
        description:
          'Rename or move a workspace file or folder. Files keep a backup for undo; folders are moved directly. Requires explicit approval.',
        parameters: {
          type: 'object',
          properties: {
            fromPath: { type: 'string' },
            toPath: { type: 'string' },
          },
          required: ['fromPath', 'toPath'],
        },
        async execute(args) {
          return self.renamePath(args.fromPath, args.toPath);
        },
      },
    ];
  }
}

function describeReview(review: readonly ReviewLike[]): string {
  if (review.length === 0) {
    return '(no changes)';
  }
  return review
    .map((change) => {
      const header =
        change.kind === 'rename'
          ? `rename ${change.fromPath ?? '?'} -> ${change.path}`
          : `${change.kind} ${change.path}`;
      const diff = change.diff.length > 1_200 ? `${change.diff.slice(0, 1_200)}\n...[truncated]` : change.diff;
      return `${header}\n${diff}`;
    })
    .join('\n\n');
}
