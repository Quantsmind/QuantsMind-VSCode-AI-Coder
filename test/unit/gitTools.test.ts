import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitTools } from '../../src/agent/gitTools';
import { CheckpointService } from '../../src/git/checkpointService';

const tempRoots: string[] = [];

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantsmind-gittools-test-'));
  tempRoots.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

suiteTeardown(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface Harness {
  readonly tools: GitTools;
  readonly approvals: { operation: string }[];
}

function harness(
  dir: string,
  approval: { readonly stage?: boolean; readonly commit?: boolean; readonly restore?: boolean } = {},
): Harness {
  const approvals: { operation: string }[] = [];
  const tools = new GitTools({
    workspaceRoot: dir,
    trusted: () => true,
    approval: async (request) => {
      approvals.push(request);
      if (request.operation === 'stage') {
        return approval.stage !== false;
      }
      if (request.operation === 'unstage') {
        return approval.stage !== false;
      }
      if (request.operation === 'commit') {
        return approval.commit !== false;
      }
      if (request.operation === 'restore checkpoint') {
        return approval.restore !== false;
      }
      return true;
    },
    checkpointService: new CheckpointService(),
  });
  return { tools, approvals };
}

suite('agent git tools', () => {
  test('git_status on a fresh repository reports clean', async () => {
    const dir = makeRepo();
    const { tools } = harness(dir);

    const result = await tools.gitStatus();

    expect(result.ok).to.equal(true);
    const parsed = JSON.parse(result.output ?? '{}') as { clean: boolean; branch: string };
    expect(parsed.clean).to.equal(true);
    expect(parsed.branch).to.be.a('string');
  });

  test('git_commit refuses to run without approval', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    const { tools, approvals } = harness(dir, { stage: true, commit: false });

    await tools.stageFiles({ files: ['a.txt'] });
    const result = await tools.commitStaged({ message: 'test' });

    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('approval');
    expect(approvals.map((request) => request.operation)).to.deep.equal(['stage', 'commit']);
  });

  test('explicit file list required for staging; broad patterns refused', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    const { tools } = harness(dir);

    const result = await tools.stageFiles({ files: ['.'] });

    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('Refusing');
  });

  test('checkpoint create and restore roundtrip through agent tools', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
    const { tools } = harness(dir);

    const created = await tools.createCheckpoint({ files: ['a.txt'], taskId: 'task-x', label: 'snap' });
    expect(created.ok).to.equal(true);
    const createdParsed = JSON.parse(created.output ?? '{}') as { id: string; files: string[] };

    fs.rmSync(path.join(dir, 'a.txt'));
    const restored = await tools.restoreCheckpoint({ id: createdParsed.id });

    expect(restored.ok).to.equal(true);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).to.equal('v1\n');
  });

  test('restore_checkpoint requires approval', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
    const { tools, approvals } = harness(dir, { restore: false });

    const created = await tools.createCheckpoint({ files: ['a.txt'], taskId: 'task-x' });
    expect(created.ok).to.equal(true);
    const id = (JSON.parse(created.output ?? '{}') as { id: string }).id;

    const restored = await tools.restoreCheckpoint({ id });

    expect(restored.ok).to.equal(false);
    expect(restored.error).to.contain('approval');
    expect(approvals.map((request) => request.operation)).to.deep.equal(['restore checkpoint']);
  });
});
