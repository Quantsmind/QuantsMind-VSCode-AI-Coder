import { expect } from 'chai';
import { buildStackGuidance } from '../../src/agent/stackGuidance';
import { buildLanguageInventory } from '../../src/languages/inventory';

const inventoryOf = (paths: readonly string[]) =>
  buildLanguageInventory(paths.map((path) => ({ path })));

suite('stack guidance', () => {
  test('returns guidance even without languages (detection note) but stays empty when nothing is known and no karkain', () => {
    const guidance = buildStackGuidance({ inventory: inventoryOf([]) });
    expect(guidance).to.contain('Detection confidence: unknown');
    expect(buildStackGuidance({ inventory: inventoryOf([]), hasKarkain: false })).to.contain('Detection confidence: unknown');
  });

  test('names detected languages, package manager and Karkain posture', () => {
    const guidance = buildStackGuidance({
      inventory: inventoryOf([
        ...Array.from({ length: 42 }, (_, index) => `src/a${index}.ts`),
        'src/b1.kark',
        'src/b2.kark',
        'src/b3.kark',
      ]),
      packageManager: 'npm',
      hasKarkain: true,
    });

    expect(guidance).to.contain('TypeScript');
    expect(guidance).to.contain('Karkain');
    expect(guidance).to.contain('Package manager: npm');
    expect(guidance).to.contain('get_karkain_project');
  });

  test('bounds the guidance block and names the primary language', () => {
    const paths = [
      ...Array.from({ length: 10 }, (_, index) => `src/m${index}.ts`),
      'lib/x.py',
      'lib/y.py',
    ];
    const guidance = buildStackGuidance({ inventory: inventoryOf(paths) });

    expect(guidance.length).to.be.lessThanOrEqual(2_400);
    expect(guidance).to.contain('Primary language: TypeScript');
    expect(guidance).to.contain('Also present: Python');
  });
});
