import { expect } from 'chai';
import {
  buildLanguageInventory,
  cachedLanguageInventory,
  __clearLanguageInventoryCache,
  inventorySummary,
  type LanguageInventory,
} from '../../src/languages/inventory';

const entriesOf = (paths: readonly string[], size = 100) => paths.map((path) => ({ path, size }));

const fixture = (paths: readonly string[]): LanguageInventory => buildLanguageInventory(entriesOf(paths));

suite('language inventory', () => {
  test('an empty workspace is reported as unknown, never as an error', () => {
    const inventory = fixture([]);

    expect(inventory.detection).to.equal('unknown');
    expect(inventory.primary).to.equal(undefined);
    expect(inventory.languages).to.deep.equal([]);
    expect(inventory.recognizedFiles).to.equal(0);
  });

  test('a mixed-language workspace distinguishes primary from supporting languages', () => {
    const inventory = fixture([
      ...Array.from({ length: 12 }, (_, index) => `src/ts${index}.ts`),
      'src/main.py',
      'src/util.py',
      'docs/deploy.yaml',
      'db/schema.sql',
    ]);

    expect(inventory.detection).to.equal('confident');
    expect(inventory.primary?.id).to.equal('typescript');
    expect(inventory.supporting.map((language) => language.id)).to.contain('python');
    expect(inventory.supporting.map((language) => language.id)).to.contain('yaml');
    expect(inventory.supporting.map((language) => language.id)).to.contain('sql');
    expect(inventory.languages[0]?.id).to.equal('typescript');
  });

  test('fewer than three primary-language source files produces partial detection', () => {
    const inventory = fixture(['src/a.ts', 'src/b.ts', 'src/c.py']);

    expect(inventory.detection).to.equal('partial');
    expect(inventory.primary?.id).to.equal('typescript');
  });

  test('config-only workspaces are partial, never confident', () => {
    const inventory = fixture(['config/a.yaml', 'config/b.yaml', 'config/c.json', 'config/d.toml']);

    expect(inventory.detection).to.equal('partial');
    expect(inventory.primary).to.equal(undefined);
    expect(inventory.languages.map((language) => language.id)).to.deep.equal(['yaml', 'json', 'toml']);
  });

  test('unrecognized files are ignored without breaking detection', () => {
    const inventory = fixture(['notes.xyz123', 'image.png']);

    expect(inventory.detection).to.equal('unknown');
    expect(inventory.recognizedFiles).to.equal(0);
  });

  test('vendored and generated directories are excluded from the inventory', () => {
    const inventory = fixture([
      'src/real.ts',
      'src/real2.ts',
      'src/real3.ts',
      'node_modules/pkg/index.js',
      'dist/bundle.js',
      'vendor/lib.c',
      '.git/hooks/pre-commit.sh',
    ]);

    expect(inventory.recognizedFiles).to.equal(3);
    expect(inventory.primary?.id).to.equal('typescript');
  });

  test('oversized files do not consume the scan budget contribution', () => {
    const inventory = buildLanguageInventory([
      { path: 'src/a.ts', size: 10 },
      { path: 'src/b.ts', size: 10 },
      { path: 'src/c.ts', size: 10 },
      { path: 'src/huge.ts', size: 10_000_000 },
    ]);

    expect(inventory.recognizedFiles).to.equal(3);
    expect(inventory.primary?.files).to.equal(3);
  });

  test('the scan truncates deterministically at the entries bound', () => {
    const inventory = buildLanguageInventory(
      entriesOf(Array.from({ length: 10 }, (_, index) => `src/f${index}.ts`)),
      { maxEntries: 4 },
    );

    expect(inventory.truncated).to.equal(true);
    expect(inventory.consideredEntries).to.equal(4);
    expect(inventory.recognizedFiles).to.equal(4);
  });

  test('manifest markers are reported by path without reading contents', () => {
    const inventory = fixture([
      'package.json',
      'tsconfig.json',
      'src/app.ts',
      'src/more.ts',
      'src/evenmore.ts',
      'pom.xml',
    ]);

    const markerNames = inventory.markers.map((marker) => marker.name);
    expect(markerNames).to.contain('package.json');
    expect(markerNames).to.contain('tsconfig.json');
    expect(markerNames).to.contain('pom.xml');
    expect(inventory.markers.every((marker) => marker.kind === 'manifest')).to.equal(true);
  });

  test('inventory is deterministic across identical inputs', () => {
    const paths = ['src/a.ts', 'src/b.py', 'docs/c.yaml'];
    const first = fixture(paths);
    const second = fixture(paths);

    expect(second).to.deep.equal(first);
  });

  test('memoized inventories hit the cache and invalidate on content change', () => {
    __clearLanguageInventoryCache();
    const before = entriesOf(['src/a.ts', 'src/b.ts'], 100);
    const after = entriesOf(['src/a.ts', 'src/b.ts'], 101);

    const first = cachedLanguageInventory(before);
    const second = cachedLanguageInventory(before);
    const third = cachedLanguageInventory(after);

    expect(second).to.equal(first); // cache hit: same object
    expect(third).to.not.equal(first); // cache miss: new object for changed signature
    expect(third.primary?.files).to.equal(2);
  });

  test('the inventory summary is bounded', () => {
    const inventory = fixture(Array.from({ length: 30 }, (_, index) => `src/f${index}.ts`).concat(['x/y.py']));

    expect(inventorySummary(inventory).length).to.be.lessThanOrEqual(600);
  });
});
