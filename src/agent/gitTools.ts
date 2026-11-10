import {
  repoInfo,
  status,
  diff,
  listBranches,
  listRemotes,
  log,
  stage,
  unstage,
  commit,
  headSha,
  createBranch,
  switchBranch,
  deleteBranch,
  inProgressState,
} from '../git/gitService';
import { CheckpointService, type FileCheckpoint } from '../git/checkpointService';
import type { GitHubService, GitHubIssue, GitHubPullRequest } from '../github/githubService';
import type { AgentTool, AgentToolResult } from './codingAgent';
import type { LiveValue } from './commandTools';
import { resolveLive } from './commandTools';

export interface GitToolApprovalRequest {
  readonly operation: string;
  readonly detail: string;
  readonly files?: readonly string[];
}

export interface GitToolEnvironment {
  readonly workspaceRoot: LiveValue<string>;
  readonly trusted: LiveValue<boolean>;
  readonly approval: (request: GitToolApprovalRequest) => Promise<boolean>;
  readonly github?: GitHubService;
  readonly githubRemoteName?: LiveValue<string>;
  readonly checkpointService?: CheckpointService;
}

interface WorkspaceSnapshot {
  readonly root: string;
  readonly trusted: boolean;
}

function fail(tool: string, error: string): AgentToolResult {
  return { ok: false, tool, error, durationMs: 0 };
}

function ok(tool: string, output: string): AgentToolResult {
  return { ok: true, tool, output, durationMs: 0 };
}



/**
 * Agent-facing Git tools. Read operations execute without prompting; any
 * mutating operation is gated by the same approval model as file changes,
 * with destructive operations (branch deletion, commit) always requiring it.
 */
export class GitTools {
  constructor(private readonly env: GitToolEnvironment) {}

  private snapshot(): WorkspaceSnapshot {
    return {
      root: resolveLive(this.env.workspaceRoot),
      trusted: resolveLive(this.env.trusted),
    };
  }

  private async readRoot(): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
    const { root, trusted } = this.snapshot();
    if (!trusted) {
      return { ok: false, error: 'Workspace trust is required for Git operations.' };
    }
    const info = await repoInfo(root);
    if (!info.isRepository) {
      return { ok: false, error: 'This workspace is not a Git repository.' };
    }
    return { ok: true, root };
  }

  async gitStatus(): Promise<AgentToolResult> {
    try {
      const root = await this.readRoot();
      if (!root.ok) {
        return fail('git_status', root.error);
      }
      const [entries, info, state] = await Promise.all([
        status(root.root),
        repoInfo(root.root),
        inProgressState(root.root),
      ]);
      const staged = entries.filter((entry) => entry.staged).length;
      const modified = entries.filter((entry) => entry.unstaged).length;
      const untracked = entries.filter((entry) => entry.untracked).length;
      const deleted = entries.filter((entry) => entry.deleted).length;
      const conflicts = entries.filter((entry) => entry.conflict).length;
      return ok('git_status', JSON.stringify({
        root: info.root,
        branch: info.branch ?? '(detached HEAD)',
        head: info.headSha,
        remote: info.defaultRemote ?? null,
        staged,
        modified,
        untracked,
        deleted,
        conflicts,
        clean: staged === 0 && modified === 0 && untracked === 0,
        mergeInProgress: state.merge,
        rebaseInProgress: state.rebase,
        entries: entries.map((entry) => ({ path: entry.path, state: entry.state })),
      }, null, 2));
    } catch (error) {
      return fail('git_status', error instanceof Error ? error.message : 'Git status failed.');
    }
  }

  async gitDiff(args: { staged?: unknown; path?: unknown; summary?: unknown }): Promise<AgentToolResult> {
    const root = await this.readRoot();
    if (!root.ok) {
      return fail('git_diff', root.error);
    }
    const staged = args.staged === true;
    const pathspec = typeof args.path === 'string' && args.path.trim().length > 0 ? args.path.trim() : undefined;
    const result = await diff(root.root, { cached: staged, ...(pathspec !== undefined ? { pathspec } : {}) });
    const output = result.text.length > 0 ? result.text : '(no changes)';
    return ok('git_diff', JSON.stringify({
      staged,
      truncated: result.truncated,
      binaryFiles: result.binaryFiles,
      diff: output.slice(0, 120_000),
    }, null, 2));
  }

  async gitLog(args: { limit?: unknown }): Promise<AgentToolResult> {
    const root = await this.readRoot();
    if (!root.ok) {
      return fail('git_log', root.error);
    }
    const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
    const entries = await log(root.root, limit);
    return ok('git_log', JSON.stringify({ entries }, null, 2));
  }

  async gitBranchList(): Promise<AgentToolResult> {
    const root = await this.readRoot();
    if (!root.ok) {
      return fail('git_branch_list', root.error);
    }
    const branches = await listBranches(root.root);
    return ok('git_branch_list', JSON.stringify({ branches }, null, 2));
  }

  async gitRemotes(): Promise<AgentToolResult> {
    const root = await this.readRoot();
    if (!root.ok) {
      return fail('git_remotes', root.error);
    }
    const remotes = await listRemotes(root.root);
    return ok('git_remotes', JSON.stringify({ remotes }, null, 2));
  }

  async stageFiles(args: { files?: unknown }): Promise<AgentToolResult> {
    const root = await this.readRoot();
    if (!root.ok) {
      return fail('git_stage', root.error);
    }
    const files = parseFiles(args.files);
    if (files === undefined) {
      return fail('git_stage', 'Provide an explicit list of files to stage. Broad patterns are refused.');
    }
    const approved = await this.env.approval({
      operation: 'stage',
      detail: `Stage ${files.length} file(s): ${files.slice(0, 10).join(', ')}${files.length > 10 ? ' …' : ''}`,
      files,
    });
    if (!approved) {
      return fail('git_stage', 'Staging requires explicit approval.');
    }
    const result = await stage(root.root, files);
    return result.ok
      ? ok('git_stage', JSON.stringify({ staged: files }, null, 2))
      : fail('git_stage', result.stderr || 'git add failed.');
  }

  async unstageFiles(args: { files?: unknown }): Promise<AgentToolResult> {
    const root = await this.readRoot();
    if (!root.ok) {
      return fail('git_unstage', root.error);
    }
    const files = parseFiles(args.files);
    if (files === undefined) {
      return fail('git_unstage', 'Provide an explicit list of files to unstage.');
    }
    const approved = await this.env.approval({
      operation: 'unstage',
      detail: `Unstage ${files.length} file(s): ${files.slice(0, 10).join(', ')}${files.length > 10 ? ' …' : ''}`,
      files,
    });
    if (!approved) {
      return fail('git_unstage', 'Unstaging requires explicit approval.');
    }
    const result = await unstage(root.root, files);
    return result.ok
      ? ok('git_unstage', JSON.stringify({ unstaged: files }, null, 2))
      : fail('git_unstage', result.stderr || 'git restore --staged failed.');
  }

  async commitStaged(args: { message?: unknown }): Promise<AgentToolResult> {
    const root = await this.readRoot();
    if (!root.ok) {
      return fail('git_commit', root.error);
    }
    const message = typeof args.message === 'string' ? args.message.trim() : '';
    if (message.length === 0) {
      return fail('git_commit', 'A commit message is required.');
    }
    const statusEntries = await status(root.root);
    const stagedFiles = statusEntries.filter((entry) => entry.staged).map((entry) => entry.path);
    if (stagedFiles.length === 0) {
      return fail('git_commit', 'Nothing is staged. Stage files explicitly before committing.');
    }
    const approved = await this.env.approval({
      operation: 'commit',
      detail: `Commit ${stagedFiles.length} file(s) with message:\n${message}`,
      files: stagedFiles,
    });
    if (!approved) {
      return fail('git_commit', 'Committing requires explicit approval.');
    }
    const result = await commit(root.root, message);
    if (!result.ok) {
      return fail('git_commit', result.stderr || 'git commit failed.');
    }
    const sha = await headSha(root.root);
    return ok('git_commit', JSON.stringify({ committed: sha ?? '(unknown)', files: stagedFiles, message }, null, 2));
  }

  async createBranchTool(args: { name?: unknown; checkout?: unknown; startPoint?: unknown }): Promise<AgentToolResult> {
    const root = await this.readRoot();
    if (!root.ok) {
      return fail('git_create_branch', root.error);
    }
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (name.length === 0 || name.length > 200 || name.startsWith('-') || name.includes('..') || name.includes(' ')) {
      return fail('git_create_branch', 'A valid branch name is required.');
    }
    const checkout = args.checkout === true;
    const startPoint = typeof args.startPoint === 'string' && args.startPoint.trim().length > 0 ? args.startPoint.trim() : undefined;
    const approved = await this.env.approval({
      operation: checkout ? 'create and switch to branch' : 'create branch',
      detail: `${checkout ? 'Create and switch to' : 'Create'} branch "${name}"${startPoint !== undefined ? ` from ${startPoint}` : ''}.`,
    });
    if (!approved) {
      return fail('git_create_branch', 'Creating a branch requires explicit approval.');
    }
    const result = await createBranch(root.root, name, { checkout, ...(startPoint !== undefined ? { startPoint } : {}) });
    return result.ok
      ? ok('git_create_branch', JSON.stringify({ branch: name, checkedOut: checkout }, null, 2))
      : fail('git_create_branch', result.stderr || 'git branch failed.');
  }

  async switchBranchTool(args: { name?: unknown }): Promise<AgentToolResult> {
    const root = await this.readRoot();
    if (!root.ok) {
      return fail('git_switch_branch', root.error);
    }
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (name.length === 0 || name.startsWith('-')) {
      return fail('git_switch_branch', 'A branch name is required.');
    }
    // Refuse to silently abandon work; `git switch` itself refuses on conflicts.
    const dirty = (await status(root.root)).length > 0;
    const approved = await this.env.approval({
      operation: 'switch branch',
      detail: `Switch to branch "${name}".${dirty ? ' The working tree has uncommitted changes that will be carried over when possible.' : ''}`,
    });
    if (!approved) {
      return fail('git_switch_branch', 'Switching branches requires explicit approval.');
    }
    const result = await switchBranch(root.root, name);
    return result.ok
      ? ok('git_switch_branch', JSON.stringify({ branch: name }, null, 2))
      : fail('git_switch_branch', result.stderr || 'git switch failed (uncommitted changes conflict).');
  }

  async deleteBranchTool(args: { name?: unknown; force?: unknown }): Promise<AgentToolResult> {
    const root = await this.readRoot();
    if (!root.ok) {
      return fail('git_delete_branch', root.error);
    }
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (name.length === 0 || name.startsWith('-')) {
      return fail('git_delete_branch', 'A branch name is required.');
    }
    const force = args.force === true;
    const approved = await this.env.approval({
      operation: force ? 'force-delete branch' : 'delete branch',
      detail: force
        ? `Force-delete branch "${name}". This discards unmerged work on that branch.`
        : `Delete branch "${name}" (only if it is fully merged).`,
    });
    if (!approved) {
      return fail('git_delete_branch', 'Deleting a branch requires explicit approval.');
    }
    const result = await deleteBranch(root.root, name, { force });
    return result.ok
      ? ok('git_delete_branch', JSON.stringify({ deleted: name, forced: force }, null, 2))
      : fail('git_delete_branch', result.stderr || 'git branch -d failed.');
  }

  async createCheckpoint(args: { files?: unknown; taskId?: unknown; label?: unknown }): Promise<AgentToolResult> {
    const root = await this.readRoot();
    if (!root.ok) {
      return fail('create_checkpoint', root.error);
    }
    const service = this.env.checkpointService;
    if (service === undefined) {
      return fail('create_checkpoint', 'Checkpoint storage is unavailable.');
    }
    const taskId = typeof args.taskId === 'string' && args.taskId.trim().length > 0 ? args.taskId.trim() : 'agent';
    const label = typeof args.label === 'string' ? args.label : undefined;
    const files = parseFiles(args.files);
    if (files === undefined) {
      return fail('create_checkpoint', 'Provide an explicit list of files to checkpoint.');
    }
    const checkpoint = await service.createFromFs(taskId, files, root.root, label);
    return ok('create_checkpoint', JSON.stringify({
      id: checkpoint.id,
      taskId: checkpoint.taskId,
      files: checkpoint.files.map((file) => file.path),
      createdAt: checkpoint.createdAt,
    }, null, 2));
  }

  async restoreCheckpoint(args: { id?: unknown }): Promise<AgentToolResult> {
    const root = await this.readRoot();
    if (!root.ok) {
      return fail('restore_checkpoint', root.error);
    }
    const service = this.env.checkpointService;
    if (service === undefined) {
      return fail('restore_checkpoint', 'Checkpoint storage is unavailable.');
    }
    const id = typeof args.id === 'string' ? args.id.trim() : undefined;
    if (id === undefined) {
      return fail('restore_checkpoint', 'A checkpoint ID is required.');
    }
    const checkpoint = service.get(id);
    if (checkpoint === undefined) {
      return fail('restore_checkpoint', 'Unknown checkpoint.');
    }
    const approved = await this.env.approval({
      operation: 'restore checkpoint',
      detail: `Restore checkpoint "${id}": ${checkpoint.files.length} file(s). Files that changed since the checkpoint will not be overwritten.`,
      files: checkpoint.files.map((file) => file.path),
    });
    if (!approved) {
      return fail('restore_checkpoint', 'Restoring a checkpoint requires explicit approval.');
    }
    const result = await service.restore(id, root.root);
    if (result === undefined) {
      return fail('restore_checkpoint', 'Unknown checkpoint.');
    }
    return ok('restore_checkpoint', JSON.stringify({
      id,
      restored: result.restored,
      alreadyIntact: result.alreadyIntact,
      conflicts: result.conflicts,
      missing: result.missingFiles,
    }, null, 2));
  }

  async listCheckpoints(args: { taskId?: unknown }): Promise<AgentToolResult> {
    const service = this.env.checkpointService;
    if (service === undefined) {
      return fail('list_checkpoints', 'Checkpoint storage is unavailable.');
    }
    const taskId = typeof args.taskId === 'string' && args.taskId.trim().length > 0 ? args.taskId.trim() : undefined;
    const checkpoints = service.list(taskId).map((checkpoint: FileCheckpoint) => ({
      id: checkpoint.id,
      taskId: checkpoint.taskId,
      label: checkpoint.label,
      createdAt: checkpoint.createdAt,
      fileCount: checkpoint.files.length,
    }));
    return ok('list_checkpoints', JSON.stringify({ checkpoints }, null, 2));
  }

  async githubListIssues(args: { state?: unknown; limit?: unknown }): Promise<AgentToolResult> {
    const remote = await this.githubContext();
    if (!remote.ok) {
      return fail('github_list_issues', remote.error);
    }
    const state = args.state === 'closed' || args.state === 'all' ? args.state : 'open';
    const limit = Math.max(1, Math.min(Number(args.limit) || 20, 50));
    const result = await remote.github.listIssues(remote.owner, remote.repo, state, limit);
    return result.ok
      ? ok('github_list_issues', JSON.stringify({ issues: serializeIssues(result.data) }, null, 2))
      : fail('github_list_issues', result.error.message);
  }

  async githubCreateIssue(args: { title?: unknown; body?: unknown }): Promise<AgentToolResult> {
    const remote = await this.githubContext();
    if (!remote.ok) {
      return fail('github_create_issue', remote.error);
    }
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const body = typeof args.body === 'string' ? args.body : '';
    if (title.length === 0) {
      return fail('github_create_issue', 'An issue title is required.');
    }
    const approved = await this.env.approval({
      operation: 'create GitHub issue',
      detail: `Create issue in ${remote.owner}/${remote.repo}: "${title.slice(0, 120)}"`,
    });
    if (!approved) {
      return fail('github_create_issue', 'Creating a GitHub issue requires explicit approval.');
    }
    const result = await remote.github.createIssue(remote.owner, remote.repo, title, body);
    return result.ok
      ? ok('github_create_issue', JSON.stringify({ issue: result.data }, null, 2))
      : fail('github_create_issue', result.error.message);
  }

  async githubListPullRequests(args: { state?: unknown; limit?: unknown }): Promise<AgentToolResult> {
    const remote = await this.githubContext();
    if (!remote.ok) {
      return fail('github_list_pull_requests', remote.error);
    }
    const state = args.state === 'closed' || args.state === 'all' ? args.state : 'open';
    const limit = Math.max(1, Math.min(Number(args.limit) || 20, 50));
    const result = await remote.github.listPullRequests(remote.owner, remote.repo, state, limit);
    return result.ok
      ? ok('github_list_pull_requests', JSON.stringify({ pullRequests: serializePullRequests(result.data) }, null, 2))
      : fail('github_list_pull_requests', result.error.message);
  }

  async githubCreatePullRequest(args: { title?: unknown; body?: unknown; head?: unknown; base?: unknown }): Promise<AgentToolResult> {
    const remote = await this.githubContext();
    if (!remote.ok) {
      return fail('github_create_pull_request', remote.error);
    }
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const body = typeof args.body === 'string' ? args.body : '';
    const head = typeof args.head === 'string' ? args.head.trim() : '';
    const base = typeof args.base === 'string' ? args.base.trim() : '';
    if (title.length === 0 || head.length === 0 || base.length === 0) {
      return fail('github_create_pull_request', 'title, head and base are required.');
    }
    const approved = await this.env.approval({
      operation: 'create GitHub pull request',
      detail: `Create PR ${head} -> ${base} in ${remote.owner}/${remote.repo}: "${title.slice(0, 120)}"`,
    });
    if (!approved) {
      return fail('github_create_pull_request', 'Creating a pull request requires explicit approval.');
    }
    const result = await remote.github.createPullRequest(remote.owner, remote.repo, title, body, head, base);
    return result.ok
      ? ok('github_create_pull_request', JSON.stringify({ pullRequest: result.data }, null, 2))
      : fail('github_create_pull_request', result.error.message);
  }

  private async githubContext(): Promise<

    | { ok: true; github: GitHubService; owner: string; repo: string }
    | { ok: false; error: string }
  > {
    const github = this.env.github;
    if (github === undefined) {
      return { ok: false, error: 'GitHub is not configured for this workspace. Connect a GitHub account to use the GitHub tools.' };
    }
    const root = await this.readRoot();
    if (!root.ok) {
      return { ok: false, error: root.error };
    }
    const remotes = await listRemotes(root.root);
    const remoteName = resolveLive(this.env.githubRemoteName ?? (() => 'origin'));
    const remote = remotes.find((candidate) => candidate.name === remoteName) ?? remotes[0];
    if (remote === undefined) {
      return { ok: false, error: 'No git remote is configured for this repository.' };
    }
    const parsed = (() => {
      const url = remote.url;
      const httpsMatch = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/*$/.exec(url);
      if (httpsMatch !== null) {
        return { owner: httpsMatch[1] ?? '', repo: httpsMatch[2] ?? '' };
      }
      const sshMatch = /^(?:ssh:\/\/)?(?:[^@]+@)?[^/:]+[:/]([^/]+)\/([^/]+?)(?:\.git)?\/*$/.exec(url);
      return sshMatch !== null ? { owner: sshMatch[1] ?? '', repo: sshMatch[2] ?? '' } : undefined;
    })();
    if (parsed === undefined || parsed.owner.length === 0 || parsed.repo.length === 0) {
      return { ok: false, error: `The remote "${remote.name}" is not a recognized GitHub URL.` };
    }
    return { ok: true, github, owner: parsed.owner, repo: parsed.repo };
  }

  toAgentTools(): readonly AgentTool[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return [
      {
        name: 'git_status',
        description: 'Inspect repository status: branch, HEAD, staged/unstaged/untracked/deleted files, conflicts. Read-only.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return self.gitStatus();
        },
      },
      {
        name: 'git_diff',
        description: 'Show a diff of working-tree or staged changes (optionally for one path). Read-only.',
        parameters: {
          type: 'object',
          properties: {
            staged: { type: 'boolean' },
            path: { type: 'string' },
          },
        },
        async execute(args) {
          return self.gitDiff({ staged: args.staged, path: args.path });
        },
      },
      {
        name: 'git_log',
        description: 'Show recent commit history. Read-only.',
        parameters: { type: 'object', properties: { limit: { type: 'number' } } },
        async execute(args) {
          return self.gitLog({ limit: args.limit });
        },
      },
      {
        name: 'git_branch_list',
        description: 'List local branches with current, upstream and ahead/behind info. Read-only.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return self.gitBranchList();
        },
      },
      {
        name: 'git_remotes',
        description: 'List configured remotes (credential-free URLs). Read-only.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return self.gitRemotes();
        },
      },
      {
        name: 'git_stage',
        description: 'Stage an explicit list of files. Requires approval. Broad patterns are refused.',
        parameters: {
          type: 'object',
          properties: { files: { type: 'array', items: { type: 'string' } } },
          required: ['files'],
        },
        async execute(args) {
          return self.stageFiles({ files: args.files });
        },
      },
      {
        name: 'git_unstage',
        description: 'Unstage an explicit list of files. Requires approval.',
        parameters: {
          type: 'object',
          properties: { files: { type: 'array', items: { type: 'string' } } },
          required: ['files'],
        },
        async execute(args) {
          return self.unstageFiles({ files: args.files });
        },
      },
      {
        name: 'git_commit',
        description: 'Commit staged changes with an explicit message. Requires approval.',
        parameters: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
        async execute(args) {
          return self.commitStaged({ message: args.message });
        },
      },
      {
        name: 'git_create_branch',
        description: 'Create a branch (optionally check it out). Requires approval.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            checkout: { type: 'boolean' },
            startPoint: { type: 'string' },
          },
          required: ['name'],
        },
        async execute(args) {
          return self.createBranchTool({ name: args.name, checkout: args.checkout, startPoint: args.startPoint });
        },
      },
      {
        name: 'git_switch_branch',
        description: 'Switch to a branch. Requires approval; dirty working trees are carried when Git allows it.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        async execute(args) {
          return self.switchBranchTool({ name: args.name });
        },
      },
      {
        name: 'git_delete_branch',
        description: 'Delete a branch (-d; force requires force=true). Requires approval.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            force: { type: 'boolean' },
          },
          required: ['name'],
        },
        async execute(args) {
          return self.deleteBranchTool({ name: args.name, force: args.force });
        },
      },
      {
        name: 'create_checkpoint',
        description: 'Snapshot file contents for a task so they can be restored later. Provide explicit files.',
        parameters: {
          type: 'object',
          properties: {
            files: { type: 'array', items: { type: 'string' } },
            taskId: { type: 'string' },
            label: { type: 'string' },
          },
          required: ['files'],
        },
        async execute(args) {
          return self.createCheckpoint({ files: args.files, taskId: args.taskId, label: args.label });
        },
      },
      {
        name: 'restore_checkpoint',
        description: 'Restore files from a checkpoint. Requires approval; diverging user edits are kept.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        async execute(args) {
          return self.restoreCheckpoint({ id: args.id });
        },
      },
      {
        name: 'list_checkpoints',
        description: 'List checkpoints (optionally filtered by task). Read-only.',
        parameters: { type: 'object', properties: { taskId: { type: 'string' } } },
        async execute(args) {
          return self.listCheckpoints({ taskId: args.taskId });
        },
      },
      {
        name: 'github_list_issues',
        description: 'List GitHub issues for the remote repository. Read-only.',
        parameters: {
          type: 'object',
          properties: {
            state: { type: 'string', enum: ['open', 'closed', 'all'] },
            limit: { type: 'number' },
          },
        },
        async execute(args) {
          return self.githubListIssues({ state: args.state, limit: args.limit });
        },
      },
      {
        name: 'github_create_issue',
        description: 'Create a GitHub issue. Requires approval.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['title'],
        },
        async execute(args) {
          return self.githubCreateIssue({ title: args.title, body: args.body });
        },
      },
      {
        name: 'github_list_pull_requests',
        description: 'List pull requests for the remote repository. Read-only.',
        parameters: {
          type: 'object',
          properties: {
            state: { type: 'string', enum: ['open', 'closed', 'all'] },
            limit: { type: 'number' },
          },
        },
        async execute(args) {
          return self.githubListPullRequests({ state: args.state, limit: args.limit });
        },
      },
      {
        name: 'github_create_pull_request',
        description: 'Create a GitHub pull request. Requires approval.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            head: { type: 'string' },
            base: { type: 'string' },
          },
          required: ['title', 'head', 'base'],
        },
        async execute(args) {
          return self.githubCreatePullRequest({ title: args.title, body: args.body, head: args.head, base: args.base });
        },
      },
    ];
  }
}

function parseFiles(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const files = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 500);
  return files.length > 0 ? files : undefined;
}

function serializeIssues(issues: readonly GitHubIssue[]): unknown {
  return issues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.url,
    author: issue.author,
    createdAt: issue.createdAt,
    comments: issue.comments,
  }));
}

function serializePullRequests(pulls: readonly GitHubPullRequest[]): unknown {
  return pulls.map((pull) => ({
    number: pull.number,
    title: pull.title,
    state: pull.state,
    url: pull.url,
    author: pull.author,
    head: pull.head,
    base: pull.base,
    draft: pull.draft,
    createdAt: pull.createdAt,
  }));
}
