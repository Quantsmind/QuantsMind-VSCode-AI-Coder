import { expect } from 'chai';
import { undoAppliedChanges, type AppliedFile } from '../../src/changes/apply';
import type { ChangeFs } from '../../src/changes/fs';

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
    readBackup: async () => undefined,
    removeBackup: async () => undefined,
  };
}

const modify = (over: Partial<AppliedFile> = {}): AppliedFile => ({
  changeId: 'change-1',
  kind: 'modify',
  path: 'src/a.ts',
  before: 'before-content',
  after: 'after-content',
  backupName: 'change-1.json',
  ...over,
});

suite('undo accounting', () => {
  test('a restore that errors is counted as failed, never as restored', async () => {
    const map: Record<string, string> = { 'src/a.ts': 'after-content' };
    const fs = fakeFs(map, {
      writeText: () => {
        throw new Error('io failure');
      },
    });
    const outcome = await undoAppliedChanges([modify()], fs);
    expect(outcome.restored).to.equal(0);
    expect(outcome.conflicts).to.equal(0);
    expect(outcome.failed).to.equal(1);
  });

  test('a modified file restores and reports restored', async () => {
    const map: Record<string, string> = { 'src/a.ts': 'after-content' };
    const outcome = await undoAppliedChanges([modify()], fakeFs(map));
    expect(outcome.restored).to.equal(1);
    expect(outcome.failed).to.equal(0);
    expect(map['src/a.ts']).to.equal('before-content');
  });

  test('a conflicted restore is counted as conflict, not failed', async () => {
    const map: Record<string, string> = { 'src/a.ts': 'user-edits' };
    const outcome = await undoAppliedChanges([modify()], fakeFs(map));
    expect(outcome.restored).to.equal(0);
    expect(outcome.conflicts).to.equal(1);
    expect(outcome.failed).to.equal(0);
  });

  test('mixed outcome keeps honest per-status counts', async () => {
    const map: Record<string, string> = {
      'src/a.ts': 'after-content',
      'src/b.ts': 'user-edits',
      'src/c.ts': 'after-content',
    };
    const fs = fakeFs(map, {
      writeText: (p) => {
        if (p === 'src/c.ts') {
          throw new Error('disk error');
        }
      },
    });
    const outcome = await undoAppliedChanges(
      [
        modify({ changeId: 'c1', path: 'src/a.ts' }),
        modify({ changeId: 'c2', path: 'src/b.ts' }),
        modify({ changeId: 'c3', path: 'src/c.ts' }),
      ],
      fs,
    );
    expect(outcome.restored).to.equal(1);
    expect(outcome.conflicts).to.equal(1);
    expect(outcome.failed).to.equal(1);
  });
});
