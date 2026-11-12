import { expect } from 'chai';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWorkspacePath, isWorkspaceRoot } from '../../src/agent/pathSafety';

suite('workspace path containment', () => {
  let seed: string;
  let root: string;
  let outside: string;

  setup(async () => {
    seed = await fsp.mkdtemp(path.join(os.tmpdir(), 'qm-pathsafety-'));
    root = path.join(seed, 'workspace');
    outside = path.join(seed, 'outside');
    await fsp.mkdir(path.join(root, 'src'), { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
    await fsp.writeFile(path.join(root, 'src', 'ok.ts'), 'const ok = 1;\n', 'utf8');
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'top-secret\n', 'utf8');
  });

  teardown(async () => {
    // Junctions/symlinks inside the tree are removed as links, never followed.
    await fsp.rm(seed, { recursive: true, force: true });
  });

  test('resolves an ordinary workspace-relative file', async () => {
    const resolved = await resolveWorkspacePath(root, 'src/ok.ts');
    expect(resolved.relative).to.equal('src/ok.ts');
    expect(resolved.absolute.endsWith(path.join('src', 'ok.ts'))).to.equal(true);
    expect(isWorkspaceRoot(resolved)).to.equal(false);
  });

  test('normalizes redundant segments and backslash separators', async () => {
    const resolved = await resolveWorkspacePath(root, 'src\\.\\ok.ts');
    expect(resolved.relative).to.equal('src/ok.ts');
  });

  test('rejects explicit traversal out of the workspace', async () => {
    let failure: unknown;
    try {
      await resolveWorkspacePath(root, '../outside/secret.txt');
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
  });

  test('rejects absolute paths and drive-qualified paths', async () => {
    for (const candidate of ['/etc/passwd', 'C:/windows/system.ini', 'c:\\windows\\system.ini', '//share/file']) {
      let failure: unknown;
      try {
        await resolveWorkspacePath(root, candidate);
      } catch (error) {
        failure = error;
      }
      expect(failure, candidate).to.be.instanceOf(Error);
    }
  });

  test('rejects colons (alternate data streams and drive-relative forms)', async () => {
    let failure: unknown;
    try {
      await resolveWorkspacePath(root, 'src/ok.ts:stream');
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
  });

  test('rejects empty and root-only resolution requests', async () => {
    for (const candidate of ['', '.', './', '  ']) {
      let failure: unknown;
      try {
        await resolveWorkspacePath(root, candidate);
      } catch (error) {
        failure = error;
      }
      expect(failure, candidate).to.be.instanceOf(Error);
    }
  });

  test('resolves a not-yet-existing file inside the workspace', async () => {
    const resolved = await resolveWorkspacePath(root, 'src/new-file.ts');
    expect(resolved.relative).to.equal('src/new-file.ts');
  });

  test('refuses a path whose existing segment is a link to outside the workspace', async function () {
    const link = path.join(root, 'escape');
    try {
      await fsp.symlink(outside, link, 'junction');
    } catch {
      // File system without link privilege (non-junction capable); nothing to verify.
      this.skip();
    }
    let failure: unknown;
    try {
      await resolveWorkspacePath(root, 'escape/secret.txt');
    } catch (error) {
      failure = error;
    }
    expect(failure, 'expected the junction escape to be refused').to.be.instanceOf(Error);
    expect((failure as Error).message).to.contain('escape');
  });

  test('accepts a link whose target stays inside the workspace', async function () {
    const vendorDir = path.join(root, 'vendor');
    await fsp.mkdir(vendorDir, { recursive: true });
    await fsp.writeFile(path.join(vendorDir, 'lib.js'), 'module.exports = {};\n', 'utf8');
    const linkParent = path.join(root, 'pkg');
    await fsp.mkdir(linkParent, { recursive: true });
    const link = path.join(linkParent, 'vendored');
    try {
      await fsp.symlink(vendorDir, link, 'junction');
    } catch {
      this.skip();
    }
    const resolved = await resolveWorkspacePath(root, 'pkg/vendored/lib.js');
    expect(resolved.relative).to.equal('pkg/vendored/lib.js');
  });

  test('a link that escapes through the ancestor chain is refused', async function () {
    const nestedOutside = path.join(outside, 'nested');
    await fsp.mkdir(nestedOutside, { recursive: true });
    const link = path.join(root, 'deep');
    try {
      await fsp.symlink(outside, link, 'junction');
    } catch {
      this.skip();
    }
    let failure: unknown;
    try {
      await resolveWorkspacePath(root, 'deep/nested/file.txt');
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
  });
});
