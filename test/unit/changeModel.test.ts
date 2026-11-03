import { expect } from 'chai';
import {
  MAX_CHANGES_PER_PLAN,
  MAX_CHANGE_PATH_LENGTH,
  describeChange,
  hashContent,
  normalizeChangePath,
  validateChangeInputs,
  withExpectedHash,
  type FileChangeInput,
} from '../../src/changes/model';

function create(path: string, content = 'export const value = 1;\n'): FileChangeInput {
  return { kind: 'create', path, content };
}

suite('change model', () => {
  test('normalizes safe workspace-relative paths', () => {
    expect(normalizeChangePath('src/chat/provider.ts')).to.equal('src/chat/provider.ts');
    expect(normalizeChangePath('./src/chat//provider.ts')).to.equal('src/chat/provider.ts');
    expect(normalizeChangePath('src\\chat\\provider.ts')).to.equal('src/chat/provider.ts');
    expect(normalizeChangePath('src/./chat/provider.ts')).to.equal('src/chat/provider.ts');
    expect(normalizeChangePath('  src/a.ts  ')).to.equal('src/a.ts');
  });

  test('rejects unsafe or malformed paths', () => {
    for (const value of [
      undefined,
      null,
      42,
      '',
      '   ',
      '/etc/passwd',
      'C:/Windows/system.ini',
      'c:relative',
      '//server/share/file.ts',
      '../outside.ts',
      'src/../../outside.ts',
      'src/..',
      '.',
      './',
      'src/\u0000file.ts',
      `src/${'a'.repeat(MAX_CHANGE_PATH_LENGTH)}.ts`,
    ]) {
      expect(normalizeChangePath(value), String(value)).to.equal(undefined);
    }
  });

  test('hashes content with SHA-256 deterministically', () => {
    const digest = hashContent('hello');
    expect(digest).to.match(/^[a-f0-9]{64}$/);
    expect(hashContent('hello')).to.equal(digest);
    expect(hashContent('hello!')).to.not.equal(digest);
  });

  test('accepts a plan with every supported kind', () => {
    const validation = validateChangeInputs([
      create('src/new.ts'),
      { kind: 'modify', path: 'src/existing.ts', content: 'next\n', summary: '  keep it short  ' },
      { kind: 'delete', path: 'src/gone.ts' },
      { kind: 'rename', fromPath: 'src/old.ts', path: 'src/renamed.ts' },
    ]);
    expect(validation.errors).to.deep.equal([]);
    expect(validation.changes.map((change) => change.id)).to.deep.equal([
      'change-1',
      'change-2',
      'change-3',
      'change-4',
    ]);
    expect(validation.changes[1].summary).to.equal('keep it short');
    expect(validation.changes[3].fromPath).to.equal('src/old.ts');
  });

  test('rejects empty and oversized plans', () => {
    expect(validateChangeInputs([]).errors).to.contain('The plan did not contain any changes.');
    const tooMany = Array.from({ length: MAX_CHANGES_PER_PLAN + 1 }, (_, index) =>
      create(`src/file-${index}.ts`),
    );
    expect(validateChangeInputs(tooMany).errors).to.contain(
      `The plan exceeds the ${MAX_CHANGES_PER_PLAN}-file limit.`,
    );
  });

  test('rejects unsafe paths, unknown kinds, and duplicate targets', () => {
    const validation = validateChangeInputs([
      create('../escape.ts'),
      { kind: 'overwrite', path: 'src/a.ts', content: 'x' } as unknown as FileChangeInput,
      create('src/b.ts'),
      create('src/b.ts'),
    ]);
    expect(validation.errors).to.have.length(3);
    expect(validation.errors[0]).to.contain('invalid or unsafe path');
    expect(validation.errors[1]).to.contain('unsupported kind');
    expect(validation.errors[2]).to.contain('appears more than once');
  });

  test('requires a safe, unique rename source', () => {
    expect(
      validateChangeInputs([{ kind: 'rename', path: 'src/new.ts' }]).errors[0],
    ).to.contain('without a safe source path');

    expect(
      validateChangeInputs([
        create('src/a.ts'),
        { kind: 'rename', fromPath: 'src/a.ts', path: 'src/b.ts' },
      ]).errors[0],
    ).to.contain('appears elsewhere in the plan');
  });

  test('requires full content for create and modify and rejects it elsewhere', () => {
    expect(validateChangeInputs([{ kind: 'create', path: 'src/a.ts' }]).errors[0]).to.contain(
      'requires full file content',
    );
    expect(validateChangeInputs([{ kind: 'modify', path: 'src/a.ts' }]).errors[0]).to.contain(
      'requires full file content',
    );
    expect(
      validateChangeInputs([{ kind: 'delete', path: 'src/a.ts', content: 'x' }]).errors[0],
    ).to.contain('must not include content');
    expect(
      validateChangeInputs([{ kind: 'rename', fromPath: 'a.ts', path: 'b.ts', content: 'x' }])
        .errors[0],
    ).to.contain('must not include content');
  });

  test('enforces per-file and total content limits', () => {
    const huge = validateChangeInputs([create('src/huge.ts', 'x'.repeat(1_000_001))]);
    expect(huge.errors[0]).to.contain('per-file content limit');

    const total = validateChangeInputs(
      Array.from({ length: MAX_CHANGES_PER_PLAN }, (_, index) =>
        create(`src/file-${index}.ts`, 'x'.repeat(250_000)),
      ),
    );
    expect(total.errors).to.contain('The plan exceeds the total content limit.');
  });

  test('only keeps well-formed baseline hashes', () => {
    const hash = hashContent('baseline');
    const validation = validateChangeInputs([
      { ...create('src/a.ts'), expectedHash: hash },
      { ...create('src/b.ts'), expectedHash: 'not-a-hash' },
    ]);
    expect(validation.changes[0].expectedHash).to.equal(hash);
    expect(validation.changes[1].expectedHash).to.equal(undefined);
  });

  test('attaches expected hashes and describes each kind', () => {
    const validation = validateChangeInputs([
      create('src/new.ts'),
      { kind: 'modify', path: 'src/old.ts', content: 'x' },
      { kind: 'delete', path: 'src/gone.ts' },
      { kind: 'rename', fromPath: 'a.ts', path: 'b.ts' },
    ]);
    expect(withExpectedHash(validation.changes[0], 'abc').expectedHash).to.equal('abc');
    expect(validation.changes.map((change) => describeChange(change))).to.deep.equal([
      'Create src/new.ts',
      'Modify src/old.ts',
      'Delete src/gone.ts',
      'Rename a.ts to b.ts',
    ]);
  });
});
