import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FileSystemTools,
  type AgentPathFs,
  type FileSystemApprovalRequest,
  type WorkspaceStat,
} from '../../src/agent/fileSystemTools';
import { ChangeTools, type ChangeApprovalService } from '../../src/agent/changeTools';
import { WorkspaceTools, normalizeWorkspacePath, type AgentFileSystem, type WorkspaceDirectoryEntry } from '../../src/agent/workspaceTools';
import { runCodingAgent, type AgentToolResult } from '../../src/agent/codingAgent';
import { buildReviewChanges } from '../../src/changes/review';
import { hashContent, withExpectedHash, type ChangePlan, type FileChange } from '../../src/changes/model';
import type { HistoryEntry } from '../../src/changes/history';
import type { PreparedPlan, ApplyReport } from '../../src/changes/changeService';
import type { AppliedFile } from '../../src/changes/apply';

const tempRoots: string[] = [];

/**
 * In-memory absolute-path filesystem shared by the workspace tools and the
 * change-service fake. It is intentionally small: the tests exercise the tool
 * boundary policy, not the filesystem.
 */
class MemoryPathFs implements AgentPathFs, AgentFileSystem {
  readonly root: string;
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();

  constructor(root: string) {
    this.root = root.replace(/\\/g, '/');
    this.dirs.add(this.root);
  }

  private normalize(absolutePath: string): string {
    return absolutePath.replace(/\\/g, '/');
  }

  absolute(relativePath: string): string {
    return `${this.root}/${this.normalize(relativePath)}`;
  }

  /** Test helper: absolute path for a workspace-relative string. */
  path(relativePath: string): string {
    return this.absolute(relativePath);
  }

  async createDirectory(absolutePath: string): Promise<void> {
    const normalized = this.normalize(absolutePath).replace(/\/+$/, '');
    const isPosix = normalized.startsWith('/');
    const parts = normalized.split('/').filter((part) => part.length > 0);
    if (parts.length === 0) {
      return;
    }
    let current = '';
    for (const part of parts) {
      current = isPosix ? `${current}/${part}` : current.length === 0 ? part : `${current}/${part}`;
      this.dirs.add(current);
    }
  }

  async deletePath(absolutePath: string, recursive: boolean): Promise<void> {
    const normalized = this.normalize(absolutePath);
    if (this.dirs.has(normalized)) {
      const prefix = `${normalized}/`;
      const children = [...this.dirs, ...this.files.keys()].filter((path) => path.startsWith(prefix));
      if (children.length > 0 && !recursive) {
        throw new Error('The directory is not empty.');
      }
      for (const child of children) {
        this.dirs.delete(child);
        this.files.delete(child);
      }
      this.dirs.delete(normalized);
      return;
    }
    if (this.files.has(normalized)) {
      this.files.delete(normalized);
      return;
    }
    throw new Error('The path does not exist.');
  }

  async renamePath(fromAbsolute: string, toAbsolute: string): Promise<void> {
    const from = this.normalize(fromAbsolute);
    const to = this.normalize(toAbsolute);
    if (this.dirs.has(from)) {
      const prefix = `${from}/`;
      const children = [...this.dirs, ...this.files.keys()].filter((path) => path.startsWith(prefix));
      this.dirs.delete(from);
      this.dirs.add(to);
      for (const child of children) {
        const mapped = `${to}${child.slice(from.length)}`;
        if (this.dirs.has(child)) {
          this.dirs.delete(child);
          this.dirs.add(mapped);
        }
        const content = this.files.get(child);
        if (content !== undefined) {
          this.files.set(mapped, content);
          this.files.delete(child);
        }
      }
      return;
    }
    const content = this.files.get(from);
    if (content !== undefined) {
      this.files.set(to, content);
      this.files.delete(from);
      return;
    }
    throw new Error('The path does not exist.');
  }

  async statPath(absolutePath: string): Promise<WorkspaceStat | undefined> {
    const normalized = this.normalize(absolutePath);
    if (this.dirs.has(normalized)) {
      return { type: 'directory', size: 0 };
    }
    const content = this.files.get(normalized);
    if (content !== undefined) {
      return { type: 'file', size: content.length };
    }
    return undefined;
  }

  async exists(absolutePath: string): Promise<boolean> {
    const normalized = this.normalize(absolutePath);
    return this.dirs.has(normalized) || this.files.has(normalized);
  }

  async readFile(relativePath: string): Promise<string> {
    const content = this.files.get(this.absolute(relativePath));
    if (content === undefined) {
      throw new Error('The file does not exist.');
    }
    return content;
  }

  async listDirectory(relativePath: string): Promise<readonly WorkspaceDirectoryEntry[]> {
    const base = relativePath.length === 0 ? this.root : this.absolute(relativePath);
    const prefix = base === this.root ? `${this.root}/` : `${base}/`;
    const entries: WorkspaceDirectoryEntry[] = [];
    const seen = new Set<string>();
    for (const dir of this.dirs) {
      if (dir === base || !dir.startsWith(prefix)) {
        continue;
      }
      const name = dir.slice(prefix.length).split('/')[0];
      if (name.length > 0 && !seen.has(name)) {
        seen.add(name);
        entries.push({ name, type: 'directory' });
      }
    }
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) {
        continue;
      }
      const name = file.slice(prefix.length).split('/')[0];
      if (name.length > 0 && !seen.has(name)) {
        seen.add(name);
        entries.push({ name, type: 'file' });
      }
    }
    return entries;
  }
}

/** Minimal change service that performs mutations and records history. */
class FakeChangeService implements ChangeApprovalService {
  readonly history: HistoryEntry[] = [];
  readonly prepared: ChangePlan[] = [];
  readonly applied: Array<{ plan: ChangePlan; approvedIds: readonly string[]; taskId: string; summary: string }> = [];
  private sequence = 0;

  constructor(private readonly fs: MemoryPathFs) {}

  async prepare(plan: ChangePlan, _taskId: string): Promise<PreparedPlan> {
    this.prepared.push(plan);
    const errors: string[] = [];
    const warnings: string[] = [];
    const beforeByPath = new Map<string, string | undefined>();
    const prepared: FileChange[] = [];

    for (const change of plan.changes) {
      const sourcePath = change.kind === 'rename' ? change.fromPath : change.path;
      if (sourcePath === undefined) {
        errors.push(`${change.path} has no source path.`);
        continue;
      }
      const before = this.fs.files.get(this.fs.absolute(sourcePath));
      if (change.kind === 'create') {
        if (before !== undefined) {
          warnings.push(`${change.path} already exists.`);
        }
        prepared.push(change);
        beforeByPath.set(change.path, before);
        continue;
      }
      if (before === undefined) {
        errors.push(`${sourcePath} does not exist.`);
        continue;
      }
      prepared.push(withExpectedHash(change, hashContent(before)));
      beforeByPath.set(change.path, before);
    }

    if (errors.length > 0) {
      return { plan: { ...plan, changes: [] }, beforeByPath, review: [], errors, warnings };
    }
    const preparedPlan: ChangePlan = { ...plan, changes: prepared };
    return {
      plan: preparedPlan,
      beforeByPath,
      review: buildReviewChanges(preparedPlan.changes, beforeByPath),
      errors,
      warnings,
    };
  }

  async apply(
    plan: ChangePlan,
    approvedIds: readonly string[],
    taskId: string,
    summary: string,
  ): Promise<ApplyReport> {
    this.applied.push({ plan, approvedIds, taskId, summary });
    const applied: AppliedFile[] = [];
    const results: Array<{ changeId: string; path: string; kind: FileChange['kind']; status: 'applied' }> = [];

    for (const change of plan.changes) {
      if (!approvedIds.includes(change.id)) {
        continue;
      }
      const absolute = this.fs.absolute(change.path);
      if (change.kind === 'create' || change.kind === 'modify') {
        this.fs.files.set(absolute, change.content ?? '');
      } else if (change.kind === 'delete') {
        this.fs.files.delete(absolute);
      } else if (change.kind === 'rename' && change.fromPath !== undefined) {
        const from = this.fs.absolute(change.fromPath);
        const content = this.fs.files.get(from);
        if (content !== undefined) {
          this.fs.files.set(absolute, content);
          this.fs.files.delete(from);
        }
      }
      applied.push({
        changeId: change.id,
        kind: change.kind,
        path: change.path,
        fromPath: change.fromPath,
        backupName: `${change.id}.json`,
      });
      results.push({ changeId: change.id, path: change.path, kind: change.kind, status: 'applied' });
    }

    const entry: HistoryEntry = {
      applyId: `${taskId}-apply-${++this.sequence}`,
      taskId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      summary,
      status: applied.length > 0 ? 'applied' : 'rejected',
      files: applied.map((file) => ({
        changeId: file.changeId,
        kind: file.kind,
        path: file.path,
        fromPath: file.fromPath,
        status: 'applied',
        backupName: file.backupName,
      })),
      undoable: applied.length > 0,
    };
    this.history.push(entry);
    return {
      outcome: { results, applied, conflicts: [], failed: [] },
      entry,
    };
  }

  async undo(taskId: string): Promise<{ restored: number; conflicts: number } | undefined> {
    const entries = this.history.filter((entry) => entry.taskId === taskId && entry.undoable);
    if (entries.length === 0) {
      return undefined;
    }
    return { restored: entries.length, conflicts: 0 };
  }

  listHistory(): readonly HistoryEntry[] {
    return this.history;
  }
}

interface Harness {
  readonly fs: MemoryPathFs;
  readonly changes: FakeChangeService;
  readonly tools: FileSystemTools;
  readonly approvals: FileSystemApprovalRequest[];
}

function createHarness(options: { approved?: boolean } = {}): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quantsmind-agent-test-'));
  tempRoots.push(root);
  const fileSystem = new MemoryPathFs(root);
  const changes = new FakeChangeService(fileSystem);
  const approvals: FileSystemApprovalRequest[] = [];
  const tools = new FileSystemTools({
    rootPath: root,
    pathFs: fileSystem,
    changes,
    approval: async (request) => {
      approvals.push(request);
      return options.approved !== false;
    },
  });
  return { fs: fileSystem, changes, tools, approvals };
}

function createWorkspaceTools(fs: MemoryPathFs): WorkspaceTools {
  return new WorkspaceTools(fs.root, fs);
}

suiteTeardown(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

suite('agent workspace discovery and reading', () => {
  test('listing a directory returns files and folders', async () => {
    const { fs } = createHarness();
    await fs.createDirectory(fs.path('src'));
    fs.files.set(fs.path('src/a.ts'), 'export const a = 1;');
    fs.files.set(fs.path('README.md'), '# hello');

    const result = await createWorkspaceTools(fs).listFiles('');

    expect(result.ok).to.equal(true);
    expect(result.output).to.contain('README.md');
    expect(result.output).to.contain('src/a.ts');
  });

  test('searching files returns matching lines', async () => {
    const { fs } = createHarness();
    fs.files.set(fs.path('a.ts'), 'const needle = 1;');
    fs.files.set(fs.path('b.ts'), 'const other = 2;');

    const result = await createWorkspaceTools(fs).searchFiles('needle');

    expect(result.ok).to.equal(true);
    expect(result.output).to.contain('a.ts:1');
  });

  test('reading a file returns its contents', async () => {
    const { fs } = createHarness();
    fs.files.set(fs.path('a.txt'), 'hello');

    const result = await createWorkspaceTools(fs).readFile('a.txt');

    expect(result.ok).to.equal(true);
    expect(result.output).to.equal('hello');
  });

  test('reading a missing file reports a failure', async () => {
    const { fs } = createHarness();

    const result = await createWorkspaceTools(fs).readFile('missing.txt');

    expect(result.ok).to.equal(false);
    expect(result.error).to.be.a('string');
  });
});

suite('agent file creation and modification', () => {
  test('writing a new file creates it and records history', async () => {
    const { fs, tools, changes } = createHarness();

    const result = await tools.writeFile('new.txt', 'hello');

    expect(result.ok).to.equal(true);
    expect(fs.files.get(fs.path('new.txt'))).to.equal('hello');
    expect(changes.applied).to.have.length(1);
    expect(changes.applied[0].plan.changes[0].kind).to.equal('create');
  });

  test('writing an existing file modifies it and records history', async () => {
    const { fs, tools, changes } = createHarness();
    fs.files.set(fs.path('a.txt'), 'old');

    const result = await tools.writeFile('a.txt', 'new');

    expect(result.ok).to.equal(true);
    expect(fs.files.get(fs.path('a.txt'))).to.equal('new');
    expect(changes.applied[0].plan.changes[0].kind).to.equal('modify');
  });

  test('rejecting a write leaves the file untouched', async () => {
    const { fs, tools } = createHarness({ approved: false });

    const result = await tools.writeFile('a.txt', 'hello');

    expect(result.ok).to.equal(false);
    expect(fs.files.has(fs.path('a.txt'))).to.equal(false);
  });

  test('writing to a directory path is rejected', async () => {
    const { fs, tools } = createHarness();
    await fs.createDirectory(fs.path('src'));

    const result = await tools.writeFile('src', 'hello');

    expect(result.ok).to.equal(false);
  });

  test('a multi-file change set is prepared and applied with approval', async () => {
    const { fs, changes } = createHarness();
    fs.files.set(fs.path('a.txt'), 'a');
    fs.files.set(fs.path('b.txt'), 'b');
    const changeTools = new ChangeTools(changes, async () => ['change-1', 'change-2']);

    const prepared = await changeTools.prepareFileChange({
      changes: [
        { kind: 'modify', path: 'a.txt', content: 'a2' },
        { kind: 'create', path: 'c.txt', content: 'c' },
      ],
    });
    expect(prepared.ok).to.equal(true);

    const applied = await changeTools.applyPendingChange();

    expect(applied.ok).to.equal(true);
    expect(fs.files.get(fs.path('a.txt'))).to.equal('a2');
    expect(fs.files.get(fs.path('c.txt'))).to.equal('c');
  });

  test('preparing a change returns a unified diff', async () => {
    const { fs, changes } = createHarness();
    fs.files.set(fs.path('a.txt'), 'line1\nline2\n');
    const changeTools = new ChangeTools(changes, async () => ['change-1']);

    const result = await changeTools.prepareFileChange({
      changes: [{ kind: 'modify', path: 'a.txt', content: 'line1\nline3\n' }],
    });

    expect(result.ok).to.equal(true);
    const parsed = JSON.parse(result.output as string) as { files: Array<{ diff: string }> };
    expect(parsed.files[0].diff).to.contain('+line3');
    expect(parsed.files[0].diff).to.contain('-line2');
  });
});

suite('agent folder operations', () => {
  test('creating a folder creates missing parents', async () => {
    const { fs, tools } = createHarness();

    const result = await tools.createFolder('a/b/c');

    expect(result.ok).to.equal(true);
    expect(fs.dirs.has(fs.path('a/b/c'))).to.equal(true);
  });

  test('creating an existing folder is idempotent', async () => {
    const { fs, tools } = createHarness();
    await fs.createDirectory(fs.path('a'));

    const result = await tools.createFolder('a');

    expect(result.ok).to.equal(true);
  });

  test('renaming a folder moves its children', async () => {
    const { fs, tools } = createHarness();
    await fs.createDirectory(fs.path('src'));
    fs.files.set(fs.path('src/a.ts'), 'x');

    const result = await tools.renamePath('src', 'lib');

    expect(result.ok).to.equal(true);
    expect(fs.dirs.has(fs.path('lib'))).to.equal(true);
    expect(fs.files.get(fs.path('lib/a.ts'))).to.equal('x');
  });

  test('deleting a folder recursively removes its children', async () => {
    const { fs, tools, approvals } = createHarness();
    await fs.createDirectory(fs.path('src'));
    fs.files.set(fs.path('src/a.ts'), 'x');

    const result = await tools.deletePath('src', true);

    expect(result.ok).to.equal(true);
    expect(fs.dirs.has(fs.path('src'))).to.equal(false);
    expect(fs.files.has(fs.path('src/a.ts'))).to.equal(false);
    expect(approvals[0].operation).to.equal('delete-folder');
  });

  test('deleting a non-empty folder without recursive fails', async () => {
    const { fs, tools } = createHarness();
    await fs.createDirectory(fs.path('src'));
    fs.files.set(fs.path('src/a.ts'), 'x');

    const result = await tools.deletePath('src', false);

    expect(result.ok).to.equal(false);
    expect(fs.dirs.has(fs.path('src'))).to.equal(true);
  });
});

suite('agent rename and deletion', () => {
  test('renaming a file moves it and records history', async () => {
    const { fs, tools, changes } = createHarness();
    fs.files.set(fs.path('a.txt'), 'content');

    const result = await tools.renamePath('a.txt', 'b.txt');

    expect(result.ok).to.equal(true);
    expect(fs.files.has(fs.path('a.txt'))).to.equal(false);
    expect(fs.files.get(fs.path('b.txt'))).to.equal('content');
    expect(changes.history).to.have.length(1);
  });

  test('renaming to an existing path is rejected', async () => {
    const { fs, tools } = createHarness();
    fs.files.set(fs.path('a.txt'), 'a');
    fs.files.set(fs.path('b.txt'), 'b');

    const result = await tools.renamePath('a.txt', 'b.txt');

    expect(result.ok).to.equal(false);
    expect(fs.files.get(fs.path('a.txt'))).to.equal('a');
  });

  test('deleting a file requires approval and records history', async () => {
    const { fs, tools, changes, approvals } = createHarness();
    fs.files.set(fs.path('a.txt'), 'content');

    const result = await tools.deletePath('a.txt');

    expect(result.ok).to.equal(true);
    expect(fs.files.has(fs.path('a.txt'))).to.equal(false);
    expect(changes.history).to.have.length(1);
    expect(approvals[0].operation).to.equal('delete-file');
  });

  test('rejecting a deletion leaves the file untouched', async () => {
    const { fs, tools } = createHarness({ approved: false });
    fs.files.set(fs.path('a.txt'), 'content');

    const result = await tools.deletePath('a.txt');

    expect(result.ok).to.equal(false);
    expect(fs.files.has(fs.path('a.txt'))).to.equal(true);
  });
});

suite('workspace boundary protection', () => {
  test('paths that escape the workspace are rejected', async () => {
    const { tools } = createHarness();

    expect((await tools.writeFile('../outside.txt', 'x')).ok).to.equal(false);
    expect((await tools.writeFile('/etc/passwd', 'x')).ok).to.equal(false);
    expect((await tools.createFolder('../../etc')).ok).to.equal(false);
    expect((await tools.deletePath('..')).ok).to.equal(false);
    expect((await tools.renamePath('a.txt', '../b.txt')).ok).to.equal(false);
  });

  test('the workspace root cannot be deleted or renamed', async () => {
    const { tools } = createHarness();

    expect((await tools.deletePath('')).ok).to.equal(false);
    expect((await tools.renamePath('', 'a.txt')).ok).to.equal(false);
  });

  test('an unsafe path is rejected by the shared normalizer', () => {
    expect(normalizeWorkspacePath('..')).to.equal(undefined);
    expect(normalizeWorkspacePath('/absolute')).to.equal(undefined);
    expect(normalizeWorkspacePath('a/../b')).to.equal(undefined);
    expect(normalizeWorkspacePath('a/b')).to.equal('a/b');
  });
});

suite('agent execution reliability', () => {
  test('a failed tool execution is reported to the model and the loop continues', async () => {
    let calls = 0;
    const model = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          return { text: '{"tool_calls":[{"name":"delete_path","arguments":{"path":"missing.txt"}}]}' };
        }
        return { text: '{"final":"recovered"}' };
      },
    };
    const { tools } = createHarness();

    const result = await runCodingAgent({
      task: 'delete a missing file',
      model,
      tools: tools.toAgentTools(),
      maxIterations: 4,
    });

    expect(result.status).to.equal('completed');
    expect(result.toolResults).to.have.length(1);
    expect(result.toolResults[0].ok).to.equal(false);
    expect(result.finalText).to.equal('recovered');
  });

  test('cancelling the run stops tool execution', async () => {
    const controller = new AbortController();
    const model = {
      async complete() {
        return { text: '{"tool_calls":[{"name":"create_folder","arguments":{"path":"a"}}]}' };
      },
    };
    const { tools } = createHarness();

    const pending = runCodingAgent({
      task: 'create a folder',
      model,
      tools: tools.toAgentTools(),
      maxIterations: 4,
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;

    expect(result.status).to.equal('cancelled');
  });

  test('a tool timeout is reported as a failed tool result', async () => {
    let calls = 0;
    const model = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          return { text: '{"tool_calls":[{"name":"hang","arguments":{}}]}' };
        }
        return { text: '{"final":"handled timeout"}' };
      },
    };
    const tools = [
      {
        name: 'hang',
        description: 'never returns',
        parameters: { type: 'object', properties: {} },
        async execute(): Promise<AgentToolResult> {
          return await new Promise(() => undefined);
        },
      },
    ];

    const result = await runCodingAgent({
      task: 'hang',
      model,
      tools,
      toolTimeoutMs: 1_000,
      maxIterations: 4,
    });

    expect(result.status).to.equal('completed');
    expect(result.toolResults[0].ok).to.equal(false);
    expect(result.toolResults[0].error).to.contain('timed out');
  });
});
