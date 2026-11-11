import { expect } from 'chai';
import { MAX_CHANGE_HISTORY } from '../../src/config/defaults';
import {
  ChangeHistoryStore,
  historyFilesFor,
  undoHistoryEntry,
  type HistoryEntry,
  type HistoryFile,
} from '../../src/changes/history';
import { applyChangePlan } from '../../src/changes/apply';
import { validateChangeInputs, hashContent } from '../../src/changes/model';
import { MemoryChangeFs } from './changeFs';

class MemoryMemento {
  readonly values = new Map<string, unknown>();

  get(key: string): unknown {
    return this.values.get(key);
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function entry(taskId: string, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    applyId: taskId,
    taskId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    summary: `Task ${taskId}`,
    status: 'applied',
    files: [],
    undoable: true,
    ...overrides,
  };
}

function file(overrides: Partial<HistoryFile> = {}): HistoryFile {
  return {
    changeId: 'change-1',
    kind: 'create',
    path: 'src/a.ts',
    status: 'applied',
    backupName: 'change-1.json',
    ...overrides,
  };
}

suite('change history store', () => {
  test('starts empty and returns undefined for unknown tasks', () => {
    const store = new ChangeHistoryStore(new MemoryMemento());
    expect(store.list()).to.deep.equal([]);
    expect(store.get('missing')).to.equal(undefined);
  });

  test('adds, replaces, and updates entries', async () => {
    const store = new ChangeHistoryStore(new MemoryMemento());
    await store.add(entry('t1'));
    await store.add(entry('t2'));
    expect(store.list().map((item) => item.taskId)).to.deep.equal(['t2', 't1']);
    expect(store.get('t1')?.summary).to.equal('Task t1');

    const original = store.get('t1');
    await store.update('t1', { status: 'undone', undoable: false });
    const updated = store.get('t1');
    expect(updated?.status).to.equal('undone');
    expect(updated?.undoable).to.equal(false);
    expect((updated?.updatedAt ?? '').localeCompare(original?.updatedAt ?? '')).to.be.at.least(0);

    await store.update('unknown', { status: 'undone' });
    expect(store.list()).to.have.length(2);
  });

  test('re-adding a task replaces it without duplicating', async () => {
    const store = new ChangeHistoryStore(new MemoryMemento());
    await store.add(entry('t1', { summary: 'first' }));
    await store.add(entry('t1', { summary: 'second' }));
    expect(store.list()).to.have.length(1);
    expect(store.get('t1')?.summary).to.equal('second');
  });

  test('records failures as non-undoable history', async () => {
    const store = new ChangeHistoryStore(new MemoryMemento());
    await store.fail('t1', 'Provider unavailable');
    expect(store.get('t1')).to.deep.include({
      taskId: 't1',
      summary: 'Provider unavailable',
      status: 'failed',
      undoable: false,
    });
  });

  test('drops entries beyond the history cap', async () => {
    const store = new ChangeHistoryStore(new MemoryMemento());
    for (let index = 0; index < MAX_CHANGE_HISTORY + 5; index += 1) {
      await store.add(entry(`t${index}`));
    }
    expect(store.list()).to.have.length(MAX_CHANGE_HISTORY);
    expect(store.get('t0')).to.equal(undefined);
    expect(store.get(`t${MAX_CHANGE_HISTORY + 4}`)).to.not.equal(undefined);
  });

  test('ignores malformed stored entries and files', () => {
    const memento = new MemoryMemento();
    memento.values.set('quantsmind.changes.history.v1', [
      entry('valid', {
        files: [
          file(),
          { changeId: 'x', path: 'y', kind: 'overwrite', status: 'applied' } as unknown as HistoryFile,
          { changeId: 'x', path: 'y', kind: 'modify', status: 'unknown' } as unknown as HistoryFile,
          { changeId: 1, path: 'y', kind: 'modify', status: 'applied' } as unknown as HistoryFile,
        ],
      }),
      { taskId: 'bad', status: 'nonsense' },
      null,
    ]);
    const stored = new ChangeHistoryStore(memento).list();
    expect(stored).to.have.length(1);
    expect(stored[0].files).to.have.length(1);
  });
});

suite('change history file mapping', () => {
  test('merges plan changes with apply results and backup names', () => {
    const validation = validateChangeInputs([
      { kind: 'create', path: 'src/a.ts', content: 'a' },
      { kind: 'rename', fromPath: 'src/old.ts', path: 'src/new.ts' },
    ]);
    const plan = { id: 'p1', summary: 's', changes: validation.changes };
    const outcome = {
      results: [
        { changeId: 'change-1', path: 'src/a.ts', kind: 'create' as const, status: 'applied' as const },
        { changeId: 'change-2', path: 'src/new.ts', kind: 'rename' as const, status: 'skipped' as const },
      ],
      applied: [
        {
          changeId: 'change-1',
          kind: 'create' as const,
          path: 'src/a.ts',
          before: undefined,
          after: 'a',
          backupName: 'change-1.json',
        },
      ],
      conflicts: [],
      failed: [],
    };
    expect(historyFilesFor(plan, outcome)).to.deep.equal([
      {
        changeId: 'change-1',
        kind: 'create',
        path: 'src/a.ts',
        fromPath: undefined,
        status: 'applied',
        backupName: 'change-1.json',
      },
      {
        changeId: 'change-2',
        kind: 'rename',
        path: 'src/new.ts',
        fromPath: 'src/old.ts',
        status: 'skipped',
        backupName: undefined,
      },
    ]);
  });
});

suite('undo from history', () => {
  test('restores a modified file from its backup record', async () => {
    const fs = new MemoryChangeFs({ 'src/a.ts': 'changed' });
    fs.backups.set(
      'change-1.json',
      JSON.stringify({ before: 'original', after: 'changed' }),
    );
    const outcome = await undoHistoryEntry(
      entry('t1', {
        files: [file({ kind: 'modify', path: 'src/a.ts' })],
      }),
      fs,
    );
    expect(outcome.restored).to.equal(1);
    expect(fs.files.get('src/a.ts')).to.equal('original');
  });

  test('reports a conflict when the file changed after apply', async () => {
    const fs = new MemoryChangeFs({ 'src/a.ts': 'user edit' });
    fs.backups.set('change-1.json', JSON.stringify({ before: 'original', after: 'changed' }));
    const outcome = await undoHistoryEntry(
      entry('t1', { files: [file({ kind: 'modify', path: 'src/a.ts' })] }),
      fs,
    );
    expect(outcome.conflicts).to.equal(1);
    expect(fs.files.get('src/a.ts')).to.equal('user edit');
  });

  test('skips non-applied files; a missing backup surfaces as an explicit failure', async () => {
    const fs = new MemoryChangeFs();
    const outcome = await undoHistoryEntry(
      entry('t1', {
        files: [
          file({ status: 'skipped' }),
          file({ changeId: 'change-2', path: 'src/b.ts', backupName: undefined }),
          file({ changeId: 'change-3', path: 'src/c.ts', backupName: 'missing.json' }),
        ],
      }),
      fs,
    );
    // Files without applied status or without a backup record produce no restore at all.
    expect(outcome.results).to.have.length(1);
    expect(outcome.results[0]?.status).to.equal('failed');
    expect(outcome.results[0]?.message).to.contain('missing');
    expect(outcome.restored).to.equal(0);
    expect(outcome.failed).to.equal(1);
  });

  test('reports corrupt backup records as failed without throwing', async () => {
    const fs = new MemoryChangeFs({ 'src/a.ts': 'current' });
    fs.backups.set('change-1.json', '{not json');
    const outcome = await undoHistoryEntry(
      entry('t1', { files: [file({ kind: 'modify', path: 'src/a.ts' })] }),
      fs,
    );
    expect(outcome.restored).to.equal(0);
    expect(outcome.conflicts).to.equal(0);
    expect(outcome.failed).to.equal(1);
    expect(outcome.results[0]?.status).to.equal('failed');
    expect(outcome.results[0]?.message).to.contain('parse');
  });

  test('round-trips a real apply through history undo', async () => {
    const fs = new MemoryChangeFs({ 'src/a.ts': 'original\n' });
    const validation = validateChangeInputs([
      {
        kind: 'modify',
        path: 'src/a.ts',
        content: 'replacement\n',
        expectedHash: undefined,
      },
    ]);
    const plan = { id: 'p1', summary: 's', changes: validation.changes };
    const hash = hashContent('original\n');
    const hashedPlan = {
      ...plan,
      changes: plan.changes.map((change) => ({ ...change, expectedHash: hash })),
    };
    const applied = await applyChangePlan(hashedPlan, fs);
    expect(fs.files.get('src/a.ts')).to.equal('replacement\n');

    const outcome = await undoHistoryEntry(
      entry('t1', {
        files: historyFilesFor(hashedPlan, applied),
      }),
      fs,
    );
    expect(outcome.restored).to.equal(1);
    expect(fs.files.get('src/a.ts')).to.equal('original\n');
  });
});
