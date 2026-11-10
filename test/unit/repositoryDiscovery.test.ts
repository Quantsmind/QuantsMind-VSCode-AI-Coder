import { expect } from 'chai';
import {
  architectureSummary,
  discoverRepository,
  isIgnoredRepositoryPath,
} from '../../src/repository/discovery';

const ENTRIES = [
  { path: 'package.json' },
  { path: 'tsconfig.json' },
  { path: 'README.md' },
  { path: 'src/index.ts' },
  { path: 'src/app.ts' },
  { path: 'src/app.test.ts' },
  { path: 'node_modules/pkg/index.js' },
  { path: 'dist/bundle.js' },
  { path: 'assets/logo.png' },
];

const PACKAGE_JSON = JSON.stringify({
  name: 'demo-app',
  main: 'src/index.ts',
  scripts: {
    test: 'mocha',
    compile: 'tsc -p .',
    lint: 'eslint .',
  },
  dependencies: { react: '^19.0.0' },
  devDependencies: { jest: '^30.0.0', eslint: '^9.0.0' },
});

suite('repository discovery', () => {
  test('summarizes structure, languages, technologies, manifests, and commands', () => {
    const overview = discoverRepository({
      rootName: 'demo',
      entries: ENTRIES,
      configContents: { 'package.json': PACKAGE_JSON },
    });

    expect(overview.fileCount).to.equal(6);
    expect(overview.sourceFileCount).to.equal(3);
    expect(overview.testFileCount).to.equal(1);
    expect(overview.languages.map((language) => language.name)).to.include('TypeScript');
    expect(overview.manifests.map((manifest) => manifest.path)).to.include.members([
      'package.json',
      'tsconfig.json',
    ]);
    expect(overview.buildSystems.map((system) => system.name)).to.include('npm');
    const npm = overview.buildSystems.find((system) => system.name === 'npm');
    expect(npm?.commands).to.include.members(['npm test', 'npm run compile', 'npm run lint']);
    expect(overview.entryPoints).to.include('src/index.ts');
    expect(overview.technologies.map((technology) => technology.name)).to.include.members([
      'React',
      'Jest',
      'ESLint',
    ]);
    expect(overview.configFiles).to.include('tsconfig.json');
    expect(overview.ignored.files).to.be.at.least(3);
    expect(overview.ignored.reasons.generated).to.be.at.least(3);
    expect(architectureSummary(overview)).to.match(/TypeScript/);
  });

  test('excludes generated, binary, and dependency paths before analysis', () => {
    expect(isIgnoredRepositoryPath('node_modules/react/index.js')).to.equal(true);
    expect(isIgnoredRepositoryPath('dist/out.js')).to.equal(true);
    expect(isIgnoredRepositoryPath('build/out.js')).to.equal(true);
    expect(isIgnoredRepositoryPath('assets/logo.png')).to.equal(true);
    expect(isIgnoredRepositoryPath('src/index.ts')).to.equal(false);
  });

  test('honours the entry limit and records truncation', () => {
    const overview = discoverRepository({
      rootName: 'demo',
      entries: Array.from({ length: 10 }, (_, index) => ({ path: `src/file${index}.ts` })),
      maxEntries: 3,
    });
    expect(overview.fileCount).to.equal(3);
    expect(overview.limits.truncated).to.equal(true);
  });
});
