import { expect } from 'chai';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { WorkspaceChangeFs } from '../../src/changes/fs';

suite('WorkspaceChangeFs (host-bound)', () => {
  let seed: string;
  let root: string;
  let backupRoot: string;
  let fs: WorkspaceChangeFs;

  setup(() => {
    seed = mkdtempSync(join(tmpdir(), 'qm-changefs-'));
    root = join(seed, 'workspace');
    backupRoot = join(seed, 'backups');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(backupRoot, { recursive: true });
    writeFileSync(join(root, 'src', 'seed.ts'), 'seed\n', 'utf8');
    fs = new WorkspaceChangeFs(vscode.Uri.file(root), vscode.Uri.file(backupRoot));
  });

  teardown(() => {
    rmSync(seed, { recursive: true, force: true });
  });

  test('writes, reads, moves and deletes inside the root', async () => {
    await fs.writeText('src/new.ts', 'fresh content\n');
    expect(await fs.readText('src/new.ts')).to.equal('fresh content\n');
    await fs.move('src/new.ts', 'src/moved.ts');
    expect(await existsSync(join(root, 'src', 'moved.ts'))).to.equal(true);
    expect(await fs.readText('src/moved.ts')).to.equal('fresh content\n');
    expect(await fs.exists('src/moved.ts')).to.equal(true);
    await fs.deleteFile('src/moved.ts');
    expect(await fs.exists('src/moved.ts')).to.equal(false);
  });

  test('refuses absolute paths', async () => {
    let failure: unknown;
    try {
      await fs.readText(join(root, 'src', 'seed.ts'));
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
  });

  test('refuses traversal outside the root', async () => {
    let failure: unknown;
    try {
      await fs.readText('../escape.txt');
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
  });

  test('backups round-trip through the backup root', async () => {
    await fs.writeBackup('unit-back.json', '{"before":"original"}');
    expect(await fs.readBackup('unit-back.json')).to.equal('{"before":"original"}');
    await fs.removeBackup('unit-back.json');
    expect(await fs.readBackup('unit-back.json')).to.equal(undefined);
  });

  test('files that are not valid UTF-8 content flow through as-is (binary-safe storage)', async () => {
    const binary = Buffer.from([0x00, 0xff, 0xfe, 0x61, 0x62]);
    writeFileSync(join(root, 'bin.dat'), binary);
    const decoded = await fs.readText('bin.dat');
    expect(typeof decoded).to.equal('string');
  });

  test('a directory passed to readText is reported as an error, never as text', async () => {
    let failure: unknown;
    try {
      await fs.readText('src');
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
  });
});
