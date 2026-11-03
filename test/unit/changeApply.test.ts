import { expect } from 'chai';
import { applyChangePlan, undoAppliedChanges } from '../../src/changes/apply';
import {
  hashContent,
  validateChangeInputs,
  type ChangePlan,
  type FileChangeInput,
} from '../../src/changes/model';
import { MemoryChangeFs } from './changeFs';

function makePlan(inputs: readonly FileChangeInput[]): ChangePlan {
  const validation = validateChangeInputs(inputs);
  if (validation.errors.length > 0) {
    throw new Error(validation.errors.join(' '));
  }
  return { id: 'plan-1', summary: 'Test plan', changes: validation.changes };
}

function modify(path: string, before: string, after: string, expectedHash = hashContent(before)): FileChangeInput {
  return { kind: 'modify', path, content: after, expectedHash };
}

suite('change application', () => {
  test('creates a file and writes a backup before mutating', async () => {
    const fs = new MemoryChangeFs();
    const plan = makePlan([{ kind: 'create', path: 'src/new.ts', content: 'export {};\n' }]);
    const outcome = await applyChangePlan(plan, fs);

    expect(outcome.applied).to.have.length(1);
    expect(outcome.conflicts).to.have.length(0);
    expect(outcome.failed).to.have.length(0);
    expect(fs.files.get('src/new.ts')).to.equal('export {};\n');
    const backup = JSON.parse(fs.backups.get('change-1.json') ?? '{}');
    expect(backup.changeId).to.equal('change-1');
    expect(backup.before).to.equal(undefined);
    expect(backup.after).to.equal('export {};\n');
  });

  test('refuses to overwrite an existing file on create', async () => {
    const fs = new MemoryChangeFs({ 'src/new.ts': 'existing' });
    const outcome = await applyChangePlan(
      makePlan([{ kind: 'create', path: 'src/new.ts', content: 'new' }]),
      fs,
    );
    expect(outcome.conflicts[0].status).to.equal('conflict');
    expect(outcome.conflicts[0].message).to.contain('already exists');
    expect(fs.files.get('src/new.ts')).to.equal('existing');
    expect(fs.backups.size).to.equal(0);
  });

  test('applies a modify only when the baseline hash matches', async () => {
    const fs = new MemoryChangeFs({ 'src/a.ts': 'one\n' });
    const applied = await applyChangePlan(makePlan([modify('src/a.ts', 'one\n', 'two\n')]), fs);
    expect(applied.applied).to.have.length(1);
    expect(fs.files.get('src/a.ts')).to.equal('two\n');

    const stale = new MemoryChangeFs({ 'src/a.ts': 'changed by user\n' });
    const conflict = await applyChangePlan(makePlan([modify('src/a.ts', 'one\n', 'two\n')]), stale);
    expect(conflict.conflicts[0].message).to.contain('changed after the plan');
    expect(stale.files.get('src/a.ts')).to.equal('changed by user\n');

    const noHash = new MemoryChangeFs({ 'src/a.ts': 'one\n' });
    const missing = await applyChangePlan(
      makePlan([{ kind: 'modify', path: 'src/a.ts', content: 'two\n' }]),
      noHash,
    );
    expect(missing.conflicts[0].message).to.contain('No baseline content hash');
  });

  test('deletes a file after backing it up', async () => {
    const fs = new MemoryChangeFs({ 'src/gone.ts': 'bye\n' });
    const outcome = await applyChangePlan(
      makePlan([
        { kind: 'delete', path: 'src/gone.ts', expectedHash: hashContent('bye\n') },
      ]),
      fs,
    );
    expect(outcome.applied[0].kind).to.equal('delete');
    expect(fs.files.has('src/gone.ts')).to.equal(false);
    expect(JSON.parse(fs.backups.get('change-1.json') ?? '{}').before).to.equal('bye\n');
  });

  test('renames a file and refuses unsafe rename states', async () => {
    const fs = new MemoryChangeFs({ 'src/old.ts': 'content\n' });
    const outcome = await applyChangePlan(
      makePlan([
        {
          kind: 'rename',
          fromPath: 'src/old.ts',
          path: 'src/new.ts',
          expectedHash: hashContent('content\n'),
        },
      ]),
      fs,
    );
    expect(outcome.applied).to.have.length(1);
    expect(fs.files.get('src/new.ts')).to.equal('content\n');
    expect(fs.files.has('src/old.ts')).to.equal(false);

    const missingSource = await applyChangePlan(
      makePlan([{ kind: 'rename', fromPath: 'src/missing.ts', path: 'src/target.ts' }]),
      new MemoryChangeFs(),
    );
    expect(missingSource.conflicts[0].message).to.contain('source file no longer exists');

    const existingTarget = await applyChangePlan(
      makePlan([{ kind: 'rename', fromPath: 'src/a.ts', path: 'src/b.ts' }]),
      new MemoryChangeFs({ 'src/a.ts': 'a', 'src/b.ts': 'b' }),
    );
    expect(existingTarget.conflicts[0].message).to.contain('rename target already exists');

    const staleSource = await applyChangePlan(
      makePlan([
        {
          kind: 'rename',
          fromPath: 'src/a.ts',
          path: 'src/b.ts',
          expectedHash: hashContent('old'),
        },
      ]),
      new MemoryChangeFs({ 'src/a.ts': 'new content' }),
    );
    expect(staleSource.conflicts[0].message).to.contain('changed after the plan');
  });

  test('applies only explicitly approved changes', async () => {
    const fs = new MemoryChangeFs();
    const plan = makePlan([
      { kind: 'create', path: 'src/a.ts', content: 'a' },
      { kind: 'create', path: 'src/b.ts', content: 'b' },
    ]);
    const outcome = await applyChangePlan(plan, fs, { approvedIds: ['change-2'] });
    expect(outcome.applied.map((file) => file.path)).to.deep.equal(['src/b.ts']);
    expect(outcome.results.find((result) => result.changeId === 'change-1')?.status).to.equal(
      'skipped',
    );
    expect(fs.files.has('src/a.ts')).to.equal(false);
  });

  test('reports write failures without aborting later changes', async () => {
    const fs = new MemoryChangeFs();
    const originalWrite = fs.writeText.bind(fs);
    fs.writeText = async (path, content) => {
      if (path === 'src/a.ts') {
        throw new Error('disk full');
      }
      await originalWrite(path, content);
    };
    const outcome = await applyChangePlan(
      makePlan([
        { kind: 'create', path: 'src/a.ts', content: 'a' },
        { kind: 'create', path: 'src/b.ts', content: 'b' },
      ]),
      fs,
    );
    expect(outcome.failed[0].message).to.equal('disk full');
    expect(outcome.applied[0].path).to.equal('src/b.ts');
  });
});

suite('change undo', () => {
  test('restores a created file by removing it and deleting the backup', async () => {
    const fs = new MemoryChangeFs();
    const plan = makePlan([{ kind: 'create', path: 'src/new.ts', content: 'x' }]);
    const applied = await applyChangePlan(plan, fs);
    const outcome = await undoAppliedChanges(applied.applied, fs);

    expect(outcome.restored).to.equal(1);
    expect(outcome.conflicts).to.equal(0);
    expect(fs.files.has('src/new.ts')).to.equal(false);
    expect(fs.backups.size).to.equal(0);
  });

  test('restores a modified file and round-trips to the original content', async () => {
    const fs = new MemoryChangeFs({ 'src/a.ts': 'original\n' });
    const plan = makePlan([modify('src/a.ts', 'original\n', 'replacement\n')]);
    const applied = await applyChangePlan(plan, fs);
    const outcome = await undoAppliedChanges(applied.applied, fs);
    expect(outcome.restored).to.equal(1);
    expect(fs.files.get('src/a.ts')).to.equal('original\n');
  });

  test('restores a deleted file', async () => {
    const fs = new MemoryChangeFs({ 'src/gone.ts': 'bring me back\n' });
    const plan = makePlan([
      { kind: 'delete', path: 'src/gone.ts', expectedHash: hashContent('bring me back\n') },
    ]);
    const applied = await applyChangePlan(plan, fs);
    await undoAppliedChanges(applied.applied, fs);
    expect(fs.files.get('src/gone.ts')).to.equal('bring me back\n');
  });

  test('reverses a rename', async () => {
    const fs = new MemoryChangeFs({ 'src/old.ts': 'x\n' });
    const plan = makePlan([
      {
        kind: 'rename',
        fromPath: 'src/old.ts',
        path: 'src/new.ts',
        expectedHash: hashContent('x\n'),
      },
    ]);
    const applied = await applyChangePlan(plan, fs);
    await undoAppliedChanges(applied.applied, fs);
    expect(fs.files.get('src/old.ts')).to.equal('x\n');
    expect(fs.files.has('src/new.ts')).to.equal(false);
  });

  test('never overwrites user edits made after apply', async () => {
    const fs = new MemoryChangeFs({ 'src/a.ts': 'original\n' });
    const applied = await applyChangePlan(
      makePlan([modify('src/a.ts', 'original\n', 'replacement\n')]),
      fs,
    );
    fs.files.set('src/a.ts', 'user edit after apply\n');
    const outcome = await undoAppliedChanges(applied.applied, fs);
    expect(outcome.conflicts).to.equal(1);
    expect(outcome.restored).to.equal(0);
    expect(fs.files.get('src/a.ts')).to.equal('user edit after apply\n');
    expect(fs.backups.size).to.equal(1);
  });

  test('reports conflicts for created, deleted, and renamed paths that changed', async () => {
    const fs = new MemoryChangeFs({ 'src/old.ts': 'x\n', 'src/gone.ts': 'gone\n' });
    const plan = makePlan([
      { kind: 'create', path: 'src/new.ts', content: 'x' },
      { kind: 'delete', path: 'src/gone.ts', expectedHash: hashContent('gone\n') },
      {
        kind: 'rename',
        fromPath: 'src/old.ts',
        path: 'src/moved.ts',
        expectedHash: hashContent('x\n'),
      },
    ]);
    const applied = await applyChangePlan(plan, fs);
    fs.files.set('src/new.ts', 'edited');
    fs.files.set('src/gone.ts', 'new occupant');
    fs.files.set('src/old.ts', 'recreated');

    const outcome = await undoAppliedChanges(applied.applied, fs);
    expect(outcome.conflicts).to.equal(3);
    expect(fs.files.get('src/new.ts')).to.equal('edited');
    expect(fs.files.get('src/gone.ts')).to.equal('new occupant');
    expect(fs.files.get('src/old.ts')).to.equal('recreated');
  });

  test('undoes changes in reverse order', async () => {
    const fs = new MemoryChangeFs();
    const plan = makePlan([
      { kind: 'create', path: 'src/a.ts', content: 'a' },
      { kind: 'create', path: 'src/b.ts', content: 'b' },
    ]);
    const applied = await applyChangePlan(plan, fs);
    fs.calls.length = 0;
    await undoAppliedChanges(applied.applied, fs);
    expect(fs.calls).to.deep.equal(['delete:src/b.ts', 'delete:src/a.ts']);
  });
});
