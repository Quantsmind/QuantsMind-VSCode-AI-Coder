import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  repoInfo,
  status,
  diff,
  diffStat,
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
  isClean,
  inProgressState,
  parsePorcelainV1,
  runGit,
} from '../../src/git/gitService';

const tempRoots: string[] = [];

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantsmind-git-test-'));
  tempRoots.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

suiteTeardown(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

suite('git service detection', () => {
  test('detects a non-repository directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantsmind-notrepo-'));
    tempRoots.push(dir);

    const info = await repoInfo(dir);

    expect(info.isRepository).to.equal(false);
    expect(info.root).to.equal(undefined);
  });

  test('detects repository root, branch, and HEAD', async () => {
    const dir = makeRepo();

    const info = await repoInfo(dir);

    expect(info.isRepository).to.equal(true);
    // Git and os.tmpdir() may report the same directory through different
    // Windows short (8.3) vs long path forms; compare realpaths instead.
    const realpath = (value: string): string => {
      try {
        return fs.realpathSync.native(value).replace(/\\/g, '/').toLowerCase();
      } catch {
        return value.replace(/\\/g, '/').toLowerCase();
      }
    };
    expect(realpath(info.root as string)).to.equal(realpath(dir));
    expect(info.branch).to.be.a('string');
    expect(info.headSha).to.equal(undefined); // no commits yet
  });

  test('reads staged, modified, untracked and deleted files', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'gone\n');
    execFileSync('git', ['add', 'a.txt', 'gone.txt'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir, stdio: 'pipe' });

    fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n'); // untracked
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n'); // modified, unstaged
    fs.rmSync(path.join(dir, 'gone.txt')); // deleted, unstaged

    const seen = await status(dir);
    const b = seen.find((entry) => entry.path === 'b.txt');
    const a = seen.find((entry) => entry.path === 'a.txt');
    const gone = seen.find((entry) => entry.path === 'gone.txt');

    expect(b?.untracked).to.equal(true);
    expect(a?.state).to.equal('modified');
    expect(a?.unstaged).to.equal(true);
    expect(gone?.deleted).to.equal(true);
    expect(gone?.state).to.equal('deleted');
  });
});

suite('git status parsing', () => {
  test('parses staged, modified, untracked, renamed and conflict entries', () => {
    const raw = [
      'M  src/a.ts',
      ' M src/b.ts',
      'A  src/c.ts',
      'R  src/new.ts',
      'src/old.ts',
      'UU src/conflict.ts',
      '?? docs/readme.md',
      'MM src/mixed.ts',
    ].join('\0');

    const entries = parsePorcelainV1(raw);
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));

    expect(byPath.get('src/a.ts')?.staged).to.equal(true);
    expect(byPath.get('src/b.ts')?.unstaged).to.equal(true);
    expect(byPath.get('src/c.ts')?.state).to.equal('added');
    expect(byPath.get('src/new.ts')?.state).to.equal('renamed');
    expect(byPath.get('src/new.ts')?.renamedFrom).to.equal('src/old.ts');
    expect(byPath.get('src/conflict.ts')?.conflict).to.equal(true);
    expect(byPath.get('docs/readme.md')?.untracked).to.equal(true);
    expect(byPath.get('src/mixed.ts')?.staged).to.equal(true);
    expect(byPath.get('src/mixed.ts')?.unstaged).to.equal(true);
  });
});

suite('git commit flow', () => {
  test('stage + commit produces a clean tree with a HEAD SHA', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'track.txt'), 'v1\n');

    const staged = await stage(dir, ['track.txt']);
    expect(staged.ok).to.equal(true);

    const committed = await commit(dir, 'initial commit');
    expect(committed.ok).to.equal(true);

    const sha = await headSha(dir);
    expect(sha).to.match(/^[0-9a-f]{40}$/);

    expect(await isClean(dir)).to.equal(true);
    const entries = await log(dir, 1);
    expect(entries[0]?.subject).to.equal('initial commit');
  });

  test('staging broad patterns is refused', async () => {
    const dir = makeRepo();
    const result = await stage(dir, ['.']);
    expect(result.ok).to.equal(false);
    expect(result.stderr).to.contain('Refusing');

    const star = await stage(dir, ['*']);
    expect(star.ok).to.equal(false);

    const dash = await stage(dir, ['-a']);
    expect(dash.ok).to.equal(false);
  });

  test('unstage reverses stage', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    await stage(dir, ['seed.txt']);
    await commit(dir, 'seed');

    fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
    await stage(dir, ['f.txt']);

    const before = await status(dir);
    expect(before.find((e) => e.path === 'f.txt')?.staged).to.equal(true);

    const undone = await unstage(dir, ['f.txt']);
    expect(undone.ok).to.equal(true);

    const after = await status(dir);
    expect(after.find((e) => e.path === 'f.txt')?.staged).to.equal(false);
  });
});

suite('git branches', () => {
  test('creates, switches and deletes branches', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    await stage(dir, ['seed.txt']);
    await commit(dir, 'seed');

    const created = await createBranch(dir, 'feature/git-test', { checkout: true });
    expect(created.ok).to.equal(true);
    const current = (await repoInfo(dir)).branch;
    expect(current).to.equal('feature/git-test');

    const back = await switchBranch(dir, 'master');
    expect(back.ok).to.equal(true);

    const deleted = await deleteBranch(dir, 'feature/git-test');
    expect(deleted.ok).to.equal(true);

    const branches = await listBranches(dir);
    expect(branches.find((b) => b.name === 'feature/git-test')).to.equal(undefined);
  });

  test('rejects invalid branch names', async () => {
    const dir = makeRepo();
    expect((await createBranch(dir, '..bad')).ok).to.equal(false);
    expect((await createBranch(dir, '-c')).ok).to.equal(false);
    expect((await createBranch(dir, 'has space')).ok).to.equal(false);
  });
});

suite('git diff', () => {
  test('produces diff output and stats for working-tree changes', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'd.txt'), 'before\n');
    await stage(dir, ['d.txt']);
    await commit(dir, 'seed');
    fs.writeFileSync(path.join(dir, 'd.txt'), 'after\n');

    const staged = await diff(dir, { cached: true });
    const unstaged = await diff(dir, { cached: false });
    const stat = await diffStat(dir, false);

    expect(staged.text).to.be.a('string');
    expect(unstaged.text.length).to.be.greaterThan(0);
    expect(stat.additions).to.be.greaterThan(0);
  });
});

suite('git remotes and state', () => {
  test('strips credentials from remote URLs', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    await stage(dir, ['seed.txt']);
    await commit(dir, 'seed');

    execFileSync('git', ['remote', 'add', 'origin', 'https://token@example.com/owner/repo.git'], { cwd: dir, stdio: 'pipe' });
    const remotes = await listRemotes(dir);

    expect(remotes).to.have.length(1);
    expect(remotes[0]?.name).to.equal('origin');
    expect(remotes[0]?.url).to.not.contain('token@');
  });

  test('reports a clean repository with no conflicts or in-progress state', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    await stage(dir, ['seed.txt']);
    await commit(dir, 'seed');

    expect(await isClean(dir)).to.equal(true);
    const state = await inProgressState(dir);
    expect(state.merge).to.equal(false);
    expect(state.rebase).to.equal(false);
    expect(state.conflict).to.equal(false);
  });

  test('runGit executes without a shell', async () => {
    const dir = makeRepo();
    const result = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: dir });
    expect(result.ok).to.equal(true);
    expect(result.stdout.trim()).to.equal('true');
  });
});
