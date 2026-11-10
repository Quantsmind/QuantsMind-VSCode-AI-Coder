import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CheckpointService } from '../../src/git/checkpointService';

const tempRoots: string[] = [];

function makeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantsmind-checkpoint-test-'));
  tempRoots.push(dir);
  return dir;
}

suiteTeardown(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

suite('checkpoint service', () => {
  test('roundtrip: capture and restore unmodified files', async () => {
    const root = makeRoot();
    const service = new CheckpointService();

    fs.writeFileSync(path.join(root, 'a.txt'), 'aaa\n');
    fs.writeFileSync(path.join(root, 'b.txt'), 'bbb\n');
    const checkpoint = await service.createFromFs('task-1', ['a.txt', 'b.txt'], root, 'before edits');

    expect(checkpoint.id).to.be.a('string');
    expect(checkpoint.files).to.have.length(2);

    const restored = await service.restore(checkpoint.id, root);

    expect(restored?.restored).to.deep.equal([]);
    expect(restored?.alreadyIntact).to.deep.equal(['a.txt', 'b.txt']);
    expect(restored?.conflicts).to.deep.equal([]);
  });

  test('restore recreates a deleted file', async () => {
    const root = makeRoot();
    const service = new CheckpointService();

    fs.writeFileSync(path.join(root, 'keep.txt'), 'original\n');
    const checkpoint = await service.createFromFs('task-1', ['keep.txt'], root, 'before edits');

    fs.rmSync(path.join(root, 'keep.txt'));

    const restored = await service.restore(checkpoint.id, root);

    expect(restored?.restored).to.deep.equal(['keep.txt']);
    expect(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8')).to.equal('original\n');
  });

  test('restore does not overwrite user edits made after the checkpoint', async () => {
    const root = makeRoot();
    const service = new CheckpointService();

    fs.writeFileSync(path.join(root, 'edit.txt'), 'v1\n');
    const checkpoint = await service.createFromFs('task-1', ['edit.txt'], root, 'before edits');

    fs.writeFileSync(path.join(root, 'edit.txt'), 'v2-user-change\n');

    const restored = await service.restore(checkpoint.id, root);

    expect(restored?.conflicts).to.have.length(1);
    expect(restored?.conflicts[0]?.path).to.equal('edit.txt');
    // The user's version is kept; the checkpoint must not overwrite it.
    expect(fs.readFileSync(path.join(root, 'edit.txt'), 'utf8')).to.equal('v2-user-change\n');
  });

  test('checkpoint paths escaping the workspace are rejected', async () => {
    const root = makeRoot();
    const service = new CheckpointService();

    fs.writeFileSync(path.join(root, 'inside.txt'), 'inside\n');
    const checkpoint = await service.createFromFs('task-1', ['../outside.txt', 'inside.txt'], root);

    expect(checkpoint.files.map((file) => file.path)).to.deep.equal(['inside.txt']);
  });

  test('list and clear task checkpoints', async () => {
    const root = makeRoot();
    const service = new CheckpointService();

    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
    await service.createFromFs('task-1', ['a.txt'], root);
    await service.createFromFs('task-2', ['a.txt'], root);

    expect(service.list('task-1')).to.have.length(1);
    expect(service.list('task-2')).to.have.length(1);

    service.clearTask('task-1');
    expect(service.list('task-1')).to.have.length(0);
    expect(service.list('task-2')).to.have.length(1);
  });

  test('restore of unknown id returns undefined', async () => {
    const root = makeRoot();
    const service = new CheckpointService();

    expect(await service.restore('nope', root)).to.equal(undefined);
  });
});
