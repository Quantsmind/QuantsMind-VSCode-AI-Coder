import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildWorkspaceInspection,
  classifyWorkspaceIntent,
} from '../../src/workspace/inspectionReport';
import { repoInfo, status } from '../../src/git/gitService';

const tempRoots: string[] = [];

function makeRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir, stdio: 'pipe' });
}

function makeWorkspace(): { root: string; paths: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quantsmind-audit-'));
  tempRoots.push(root);
  fs.writeFileSync(path.join(root, 'README.md'), '# test fixture\n');
  fs.writeFileSync(path.join(root, 'hello.py'), 'print("hello")\n');
  fs.writeFileSync(path.join(root, 'task_manager.py'), 'def run():\n    pass\n');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@quantsmind/demo', version: '1.2.3' }, null, 2),
  );
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests', 'test_task_manager.py'), 'def test_run():\n    pass\n');
  makeRepo(root);
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: root, stdio: 'pipe' });
  // Create one modified tracked file and one untracked file.
  fs.appendFileSync(path.join(root, 'task_manager.py'), '# dirty edit\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'untracked notes\n');
  const relative: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === '.git' || entry.name === 'node_modules')) {
        continue;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else {
        relative.push(path.relative(root, abs).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return { root, paths: relative };
}

suite('workspace intent classifier (v3.1.1)', () => {
  test('explicit inspection requests are read-only', () => {
    for (const text of [
      'Inspect this workspace',
      'Summarize the workspace layout',
      'Inventory the test files',
      'Analyze the project and report findings',
      'What does this repository contain?',
    ]) {
      expect(classifyWorkspaceIntent(text), text).to.equal('read_only_inspection');
    }
  });

  test('modification requests never take the read-only path', () => {
    for (const text of [
      'Add a greeting helper to the CLI',
      'Create a Python script that summarizes logs',
      'Fix the bug in task_manager.py',
      'Refactor the tests',
    ]) {
      expect(classifyWorkspaceIntent(text), text).to.equal('implementation_request');
    }
  });

  test('uncertain requests are not forced into the read-only path', () => {
    expect(classifyWorkspaceIntent('hello')).to.equal('undetermined');
    expect(classifyWorkspaceIntent('')).to.equal('undetermined');
  });
});

suite('workspace inspection report (v3.1.1)', () => {
  test('accounts for every indexed file and distinguishes uninspected ones', async () => {
    const { root, paths } = makeWorkspace();
    const gitInfo = await repoInfo(root);
    expect(gitInfo.isRepository).to.equal(true);
    const changed = await status(root);

    const report = buildWorkspaceInspection({
      rootName: path.basename(root),
      rootPath: root,
      paths,
      maxIndexedFiles: 10_000,
      manifest: { found: true, name: '@quantsmind/demo', version: '1.2.3' },
      git: {
        available: true,
        repository: true,
        ...(gitInfo.branch !== undefined ? { branch: gitInfo.branch } : {}),
        ...(gitInfo.headShort !== undefined ? { headShort: gitInfo.headShort } : {}),
        changed: changed.map((entry) => entry.path),
      },
    });

    // Every file is accounted for in the counts.
    expect(report.totals.indexed).to.equal(paths.length);
    expect(report.totals.listed + report.totals.uninspected).to.equal(paths.length);

    // Languages detected.
    const py = report.languages.find((entry) => entry.language === 'Python');
    expect(py).to.not.equal(undefined);
    expect(py?.files).to.equal(3);

    // Manifest detected and identity verified.
    expect(report.manifests).to.deep.equal(['package.json']);
    expect(report.packageVersion).to.contain('@quantsmind/demo@1.2.3');

    // Git data is real and never invented.
    expect(report.gitDescription).to.match(/branch|master|main/);
    expect(report.notes.join(' ')).to.contain('task_manager.py');

    // Explicit verification basis recorded and structural sections all present.
    expect(report.text).to.contain('read-only');
    expect(report.text).to.contain('Explicitly inspected (evidence)');
    expect(report.text).to.contain('Unavailable or not determinable');
    expect(report.text).to.contain('tests/test_task_manager.py');
  });

  test('no-manifest workspaces report package missing as inspected, not absent by omission', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quantsmind-audit-nomanifest-'));
    tempRoots.push(root);
    fs.writeFileSync(path.join(root, 'README.md'), '# hi\n');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export {}\n');

    const report = buildWorkspaceInspection({
      rootName: path.basename(root),
      paths: ['README.md', 'src/main.ts'],
      manifest: { found: false },
      git: { available: true, repository: false },
    });

    expect(report.packageVersion).to.equal(undefined);
    expect(report.notes.join(' ')).to.contain('package.json');
    expect(report.gitDescription).to.equal('inspected: not a Git repository');
    expect(report.text).to.contain('Unavailable or not determinable');
  });

  test('truncated index and capped listing are explicit', () => {
    const report = buildWorkspaceInspection({
      rootName: 'demo',
      paths: Array.from({ length: 250 }, (_, i) => `src/file-${i}.ts`),
      maxIndexedFiles: 250,
      listLimit: 10,
      manifest: { found: false },
      git: { available: false, unavailable: 'git not found on PATH' },
    });

    expect(report.totals.listed).to.equal(10);
    expect(report.totals.uninspected).to.equal(240);
    expect(report.truncated).to.equal(true);
    expect(report.unavailable.some((u) => u.includes('Git'))).to.equal(true);
    expect(report.text).to.contain('240 more indexed file(s)');
  });
});
