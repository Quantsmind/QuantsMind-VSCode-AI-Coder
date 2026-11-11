import { expect } from 'chai';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChangeHistoryStore, undoHistoryEntry, type HistoryEntry } from '../../src/changes/history';
import { applyChangePlan, undoAppliedChanges } from '../../src/changes/apply';
import { pruneBackupFolders, backupRetentionKey, safeBackupSegment } from '../../src/changes/prune';
import { MAX_CHANGE_HISTORY } from '../../src/config/defaults';
import type { ChangeFs } from '../../src/changes/fs';
import type { ChangePlan } from '../../src/changes/model';

// ---------------------------------------------------------------------------
// In-memory memento + fake ChangeFs (pure Node; no vscode host required)
// ---------------------------------------------------------------------------
class MemoryMemento {
  private readonly values = new Map<string, unknown>();
  get(key: string): unknown {
    return this.values.get(key);
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function fakeFs(map: Record<string, string>, failOn?: { writeText?: (path: string) => void }): ChangeFs {
  return {
    readText: async (p: string) => (p in map ? map[p] : undefined),
    writeText: async (p: string, content: string) => {
      failOn?.writeText?.(p);
      map[p] = content;
    },
    deleteFile: async (p: string) => {
      delete map[p];
    },
    move: async (from: string, to: string) => {
      if (!(from in map)) {
        throw new Error('missing source');
      }
      map[to] = map[from];
      delete map[from];
    },
    exists: async (p: string) => p in map,
    writeBackup: async () => undefined,
    readBackup: async (name: string) => (name in map ? map[name] : undefined),
    removeBackup: async (name: string) => {
      delete map[name];
    },
  };
}

function historyEntry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    applyId: 'apply-1',
    taskId: 'task-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    summary: 'change',
    status: 'applied',
    files: [
      { changeId: 'change-1', kind: 'modify', path: 'src/a.ts', status: 'applied', backupName: 'change-1.json' },
    ],
    undoable: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// History store retention cap
// ---------------------------------------------------------------------------
suite('change history retention', () => {
  test('adding more than MAX_CHANGE_HISTORY keeps the newest entries only', async () => {
    const store = new ChangeHistoryStore(new MemoryMemento());
    for (let i = 0; i < MAX_CHANGE_HISTORY + 5; i += 1) {
      await store.add(
        historyEntry({ taskId: `task-${i}`, applyId: `apply-${i}`, createdAt: `t-${i}`, summary: `s-${i}` }),
      );
    }
    const entries = store.list();
    expect(entries.length).to.equal(MAX_CHANGE_HISTORY);
    expect(entries[0]?.applyId).to.equal(`apply-${MAX_CHANGE_HISTORY + 4}`);
    // The oldest five entries were evicted by the cap.
    for (let i = 0; i < 5; i += 1) {
      expect(entries.some((entry) => entry.applyId === `apply-${i}`)).to.equal(false);
    }
  });

  test('an evicted entry no longer appears as undoable for its task', async () => {
    const store = new ChangeHistoryStore(new MemoryMemento());
    for (let i = 0; i < MAX_CHANGE_HISTORY + 1; i += 1) {
      await store.add(
        historyEntry({ taskId: `task-${i}`, applyId: `apply-${i}`, createdAt: `t-${i}` }),
      );
    }
    expect(store.listForTask('task-0')).to.have.length(0);
    expect(store.getApply('apply-0')).to.equal(undefined);
  });
});

// ---------------------------------------------------------------------------
// Prune against real temporary directories
// ---------------------------------------------------------------------------
suite('backup pruning', () => {
  let seed: string;
  let root: string;

  setup(async () => {
    seed = await fsp.mkdtemp(path.join(os.tmpdir(), 'qm-prune-'));
    root = path.join(seed, 'backups');
    await fsp.mkdir(path.join(root, 'taskA', 'applyKeep'), { recursive: true });
    await fsp.mkdir(path.join(root, 'taskA', 'applyOld'), { recursive: true });
    await fsp.mkdir(path.join(root, 'taskB', 'applyOld2'), { recursive: true });
    await fsp.writeFile(path.join(root, 'taskA', 'applyKeep', 'c1.json'), '{"before":"x"}', 'utf8');
    await fsp.writeFile(path.join(root, 'taskA', 'applyOld', 'c2.json'), '{"before":"y"}', 'utf8');
    await fsp.writeFile(path.join(root, 'taskB', 'applyOld2', 'c3.json'), '{"before":"z"}', 'utf8');
  });

  teardown(async () => {
    await fsp.rm(seed, { recursive: true, force: true });
  });

  const keepSet = () => new Set([backupRetentionKey('taskA', 'applyKeep')]);

  test('removes expired backup leaves and preserves tracked recovery data', async () => {
    const result = await pruneBackupFolders(root, keepSet());
    expect(result.kept.length).to.equal(1);
    expect(result.deleted.length).to.equal(2);
    // The tracked backup leaf still holds its before-image.
    const keptRaw = await fsp.readFile(path.join(root, 'taskA', 'applyKeep', 'c1.json'), 'utf8');
    expect(keptRaw).to.contain('"before":"x"');
    expect(await existsDir(path.join(root, 'taskA', 'applyOld'))).to.equal(false);
    expect(await existsDir(path.join(root, 'taskB', 'applyOld2'))).to.equal(false);
    // The emptied taskB folder is swept as well.
    expect(await existsDir(path.join(root, 'taskB'))).to.equal(false);
  });

  test('keeps the newest valid recovery data while pruning older siblings', async () => {
    const keep = new Set([backupRetentionKey('taskA', 'applyOld')]);
    const result = await pruneBackupFolders(root, keep);
    expect(result.kept).to.have.length(1);
    expect(await existsDir(path.join(root, 'taskA', 'applyKeep'))).to.equal(false);
    expect(await existsDir(path.join(root, 'taskA', 'applyOld'))).to.equal(true);
  });

  test('never deletes a leaf holding non-backup content (unrelated files are preserved)', async () => {
    await fsp.writeFile(path.join(root, 'taskA', 'applyOld', 'operator-notes.txt'), 'do not delete', 'utf8');
    const result = await pruneBackupFolders(root, new Set());
    expect(result.skipped.some((item) => item.path.endsWith('applyOld'))).to.equal(true);
    expect(await existsDir(path.join(root, 'taskA', 'applyOld'))).to.equal(true);
    const preserved = await fsp.readFile(path.join(root, 'taskA', 'applyOld', 'operator-notes.txt'), 'utf8');
    expect(preserved).to.equal('do not delete');
  });

  test('a directory inside a backup leaf is preserved, never silently recursed into', async () => {
    await fsp.mkdir(path.join(root, 'taskA', 'applyOld', 'nested'), { recursive: true });
    await fsp.writeFile(path.join(root, 'taskA', 'applyOld', 'nested', 'deep.txt'), 'keep', 'utf8');
    const result = await pruneBackupFolders(root, new Set());
    expect(result.skipped.some((item) => item.path.endsWith('applyOld'))).to.equal(true);
    expect(await existsDir(path.join(root, 'taskA', 'applyOld', 'nested'))).to.equal(true);
  });

  test('a marker file at the backup root is preserved', async () => {
    await fsp.writeFile(path.join(root, 'README.txt'), 'marker', 'utf8');
    const result = await pruneBackupFolders(root, new Set());
    expect(result.skipped.some((item) => item.path.endsWith('README.txt'))).to.equal(true);
    expect((await fsp.readFile(path.join(root, 'README.txt'), 'utf8'))).to.equal('marker');
  });

  test('pruning pointed at a plain file reports failure without throwing or deleting', async () => {
    const plainFile = path.join(seed, 'not-a-dir');
    await fsp.writeFile(plainFile, 'x', 'utf8');
    const result = await pruneBackupFolders(plainFile, new Set());
    expect(result.deleted).to.have.length(0);
    expect(result.skipped.length).to.equal(1);
    expect(await existsFile(plainFile)).to.equal(true);
  });

  test('a missing backup root is a no-op, never an exception', async () => {
    const result = await pruneBackupFolders(path.join(seed, 'does-not-exist'), new Set());
    expect(result.deleted).to.have.length(0);
    expect(result.skipped.length).to.equal(1);
  });

  test('safeBackupSegment sanitizes path separators and truncates', () => {
    expect(safeBackupSegment('..\\evil\\path')).to.not.contain('\\');
    expect(safeBackupSegment('..')).to.equal('__');
    expect(safeBackupSegment('x'.repeat(200)).length).to.equal(80);
    expect(safeBackupSegment('')).to.equal('task');
  });
});

// ---------------------------------------------------------------------------
// Restore failures: missing/corrupt backups must surface as failures
// ---------------------------------------------------------------------------
suite('undo with missing or corrupt backups', () => {
  test('a missing before-image is reported as failed, never as restored', async () => {
    const entry = historyEntry({
      files: [
        { changeId: 'change-1', kind: 'modify', path: 'src/a.ts', status: 'applied', backupName: 'gone.json' },
      ],
    });
    const fs = fakeFs({ 'src/a.ts': 'after' });
    const outcome = await undoHistoryEntry(entry, fs);
    expect(outcome.restored).to.equal(0);
    expect(outcome.failed).to.equal(1);
    expect(outcome.results[0]?.status).to.equal('failed');
    expect(outcome.results[0]?.message).to.contain('missing');
    // The after-content stays in place (nothing clobbered).
    expect(await fs.exists('src/a.ts')).to.equal(true);
  });

  test('a corrupt before-image is reported as failed, never as restored or conflicted', async () => {
    const entry = historyEntry({
      files: [
        { changeId: 'change-1', kind: 'modify', path: 'src/a.ts', status: 'applied', backupName: 'broken.json' },
      ],
    });
    const fs = fakeFs({ 'src/a.ts': 'after', 'broken.json': 'not-json{{{' });
    const outcome = await undoHistoryEntry(entry, fs);
    expect(outcome.restored).to.equal(0);
    expect(outcome.conflicts).to.equal(0);
    expect(outcome.failed).to.equal(1);
    expect(outcome.results[0]?.message).to.contain('parse');
  });

  test('mixed outcome: good backup restores, missing backup fails — both accounted', async () => {
    const entry = historyEntry({
      files: [
        { changeId: 'c1', kind: 'modify', path: 'src/a.ts', status: 'applied', backupName: 'a.json' },
        { changeId: 'c2', kind: 'modify', path: 'src/b.ts', status: 'applied', backupName: 'missing.json' },
      ],
    });
    const fs = fakeFs({
      'src/a.ts': 'after-a',
      'src/b.ts': 'after-b',
      'a.json': JSON.stringify({ before: 'before-a', after: 'after-a' }),
    });
    const outcome = await undoHistoryEntry(entry, fs);
    expect(outcome.restored).to.equal(1);
    expect(outcome.failed).to.equal(1);
    expect(outcome.conflicts).to.equal(0);
    expect(await fs.readText('src/a.ts')).to.equal('before-a');
  });

  test('failed restore leaves the file bytes of unrelated files untouched', async () => {
    const map: Record<string, string> = { 'src/a.ts': 'after-content', 'src/keep.ts': 'untouched' };
    const realFs = fakeFs(map);
    const outcome = await undoHistoryEntry(
      historyEntry({
        files: [{ changeId: 'c1', kind: 'modify', path: 'src/a.ts', status: 'applied', backupName: 'absent.json' }],
      }),
      realFs,
    );
    expect(outcome.failed).to.equal(1);
    expect(map['src/keep.ts']).to.equal('untouched');
    expect(map['src/a.ts']).to.equal('after-content');
  });
});

// ---------------------------------------------------------------------------
// End-to-end apply→undo roundtrip with a real FS boundary (in-memory map)
// ---------------------------------------------------------------------------
suite('apply then undo', () => {
  test('a full apply→undo cycle restores the before-image and reports honestly', async () => {
    const map: Record<string, string> = {};
    const plan: ChangePlan = {
      id: 'plan-1',
      summary: 'create file',
      changes: [
        { id: 'change-1', kind: 'create', path: 'src/created.ts', summary: 'add', content: 'fresh\n' },
      ],
    };
    const fs = fakeFs(map);
    const applyOutcome = await applyChangePlan(plan, fs, { approvedIds: ['change-1'] });
    expect(applyOutcome.applied).to.have.length(1);
    const undo = await undoAppliedChanges(applyOutcome.applied, fs);
    expect(undo.restored).to.equal(1);
    expect(undo.failed).to.equal(0);
    expect(await fs.exists('src/created.ts')).to.equal(false);
  });
});

async function existsDir(p: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function existsFile(p: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}
