import { expect } from 'chai';
import {
  BUILD_ADAPTERS,
  detectBuildAdapters,
  resolveKarkainEntry,
} from '../../src/build/adapters';
import {
  parseTestOutput,
  TEST_OUTPUT_FORMATS,
} from '../../src/build/testOutput';
import { parseSourceDiagnostics } from '../../src/diagnostics/sourceDiagnostics';
import { probeToolchain } from '../../src/build/toolchain';
import type { WorkspaceEntry } from '../../src/workspace/analyze';

const W = (path: string): WorkspaceEntry => ({ path });

function detectionIds(paths: string[], configContents: Record<string, string> = {}): string[] {
  return detectBuildAdapters(paths.map(W), configContents).map((d) => d.adapter.id);
}

suite('build adapter detection', () => {
  test('detects Node.js with npm by package.json (no lockfile confusion)', () => {
    expect(detectionIds(['package.json', 'src/index.ts'])).to.have.members(['npm']);
  });

  test('prefers pnpm when pnpm workspace files are present', () => {
    expect(detectionIds(['package.json', 'pnpm-workspace.yaml'])).to.have.members(['pnpm']);
    expect(detectionIds(['pnpm-lock.yaml', 'package.json'])).to.have.members(['pnpm']);
  });

  test('detects yarn and ignores npm when yarn.lock exists', () => {
    expect(detectionIds(['package.json', 'yarn.lock'])).to.have.members(['yarn']);
  });

  test('detects Maven and Gradle Java projects', () => {
    expect(detectionIds(['pom.xml', 'src/main/App.java'])).to.have.members(['maven']);
    expect(detectionIds(['build.gradle', 'src/main/App.java'])).to.have.members(['gradle']);
    expect(detectionIds(['build.gradle.kts'])).to.have.members(['gradle']);
  });

  test('detects Python ecosystems by manifest', () => {
    expect(detectionIds(['requirements.txt'])).to.have.members(['pip']);
    expect(detectionIds(['poetry.lock', 'pyproject.toml'])).to.have.members(['poetry']);
    expect(detectionIds(['uv.lock'])).to.have.members(['uv']);
    expect(detectionIds([], { 'pyproject.toml': '[tool.poetry]\nname = "x"\n' })).to.have.members(['poetry']);
    expect(detectionIds([], { 'pyproject.toml': '[tool.hatch]\n' })).to.have.members(['hatch']);
  });

  test('detects Go, CMake, Make, Ninja, .NET and Karkain projects', () => {
    expect(detectionIds(['go.mod', 'main.go'])).to.have.members(['go']);
    expect(detectionIds(['CMakeLists.txt', 'src/engine.cpp'])).to.have.members(['cmake']);
    expect(detectionIds(['Makefile'])).to.have.members(['make']);
    expect(detectionIds(['build.ninja'])).to.have.members(['ninja']);
    expect(detectionIds(['App.csproj', 'Program.cs'])).to.have.members(['dotnet']);
    expect(detectionIds(['App.sln', 'App.csproj'])).to.have.members(['dotnet', 'msbuild']);
    expect(detectionIds(['karkain.toml', 'src/main.kark'])).to.have.members(['karkain']);
    expect(detectionIds(['src/main.kark'])).to.have.members(['karkain']);
  });

  test('detects Composer, Bundler, Dart, Flutter, Cargo and Swift', () => {
    expect(detectionIds(['composer.json'])).to.have.members(['composer']);
    expect(detectionIds(['Gemfile'])).to.have.members(['bundler']);
    expect(detectionIds(['pubspec.yaml'])).to.have.members(['dart']);
    expect(detectionIds([], { 'pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n' })).to.have.members(['flutter']);
    expect(detectionIds(['Cargo.toml'])).to.have.members(['cargo']);
    expect(detectionIds(['Package.swift'])).to.have.members(['swift']);
  });

  test('no adapter is reported for an empty workspace', () => {
    expect(detectionIds([])).to.deep.equal([]);
  });

  test('every adapter declares build commands, test commands and a format', () => {
    for (const adapter of BUILD_ADAPTERS) {
      expect(adapter.ecosystem.length).to.be.greaterThan(0);
      expect(adapter.buildCommands()).to.not.equal(undefined);
      expect(adapter.testCommands()).to.not.equal(undefined);
      expect(TEST_OUTPUT_FORMATS).to.include(adapter.testOutputFormat);
    }
  });

  test('karkain entry point resolves to main.kark when present', () => {
    expect(resolveKarkainEntry([W('src/main.kark'), W('README.md')])).to.equal('src/main.kark');
    expect(resolveKarkainEntry([W('mathutils.kark'), W('tests/test.kark')])).to.equal('mathutils.kark');
    expect(resolveKarkainEntry([W('README.md')])).to.equal(undefined);
  });

  test('karkain build commands embed the resolved entry point', () => {
    const karkain = BUILD_ADAPTERS.find((adapter) => adapter.id === 'karkain');
    expect(karkain).to.not.equal(undefined);
    expect(karkain?.buildCommands({ karkainEntry: 'src/main.kark' })).to.deep.equal(['karkain build src/main.kark']);
    expect(karkain?.buildCommands({})).to.deep.equal(['karkain build main.kark']);
  });
});

suite('test output parsing', () => {
  test('parses JUnit/Surefire output', () => {
    const parsed = parseTestOutput('Tests run: 10, Failures: 1, Errors: 1, Skipped: 2', 'junit');
    expect(parsed.total).to.equal(10);
    expect(parsed.failed).to.equal(2);
    expect(parsed.skipped).to.equal(2);
    expect(parsed.passed).to.equal(6);
  });

  test('parses pytest output including failures', () => {
    const mixed = parseTestOutput('FAILED test_x.py::test_y\n2 passed, 1 failed in 0.5s', 'pytest');
    expect(mixed.passed).to.equal(2);
    expect(mixed.failed).to.equal(1);
    expect(mixed.failures).to.have.length(1);
    const ok = parseTestOutput('5 passed in 0.2s', 'pytest');
    expect(ok.passed).to.equal(5);
    expect(ok.failed).to.equal(undefined);
  });

  test('parses mocha/jest-style output', () => {
    const parsed = parseTestOutput('  3 passing\n  1 failing', 'node');
    expect(parsed.passed).to.equal(3);
    expect(parsed.failed).to.equal(1);
    const jest = parseTestOutput('Tests: 7 passed, 7 total', 'node');
    expect(jest.passed).to.equal(7);
  });

  test('parses go test output', () => {
    const parsed = parseTestOutput('--- PASS: TestA\n--- PASS: TestB\n--- FAIL: TestC\nok  \tpkg\t0.2s', 'go');
    expect(parsed.passed).to.equal(2);
    expect(parsed.failed).to.equal(1);
    expect(parsed.failures.map((f) => f.name)).to.deep.equal(['TestC']);
  });

  test('parses cargo, dotnet, ctest, rspec, phpunit, dart, swift and karkain', () => {
    expect(parseTestOutput('test result: ok. 5 passed; 0 failed', 'cargo').passed).to.equal(5);
    expect(parseTestOutput('Passed! - Failed: 0, Passed: 3, Skipped: 0', 'dotnet').total).to.equal(3);
    expect(parseTestOutput('100% tests passed, 0 tests failed out of 12', 'ctest').total).to.equal(12);
    expect(parseTestOutput('10 examples, 0 failures', 'rspec').total).to.equal(10);
    expect(parseTestOutput('OK (6 tests, 18 assertions)', 'phpunit').passed).to.equal(6);
    expect(parseTestOutput('Tests: 6, Assertions: 18, Failures: 1', 'phpunit').failed).to.equal(1);
    expect(parseTestOutput('All tests passed!', 'dart').failed).to.equal(0);
    expect(parseTestOutput('Executed 8 tests, with 0 failures', 'swift').total).to.equal(8);
    const karkain = parseTestOutput('PASS test_square\nFAIL test_cube\nPASS test_main', 'karkain');
    expect(karkain.passed).to.equal(2);
    expect(karkain.failed).to.equal(1);
  });

  test('reports undefined counts for unrecognized output', () => {
    expect(parseTestOutput('some unrelated text', 'unknown').total).to.equal(undefined);
  });
});

suite('toolchain probing', () => {
  test('finds node on this machine', async () => {
    const info = await probeToolchain({ name: 'node', executable: 'node', versionArgs: ['--version'] });
    expect(info.available).to.equal(true);
    expect(info.version).to.match(/^\d+\.\d+/);
  });

  test('reports missing executables honestly', async () => {
    const info = await probeToolchain({
      name: 'missing',
      executable: 'definitely-missing-executable-xyz-123',
      versionArgs: ['--version'],
    });
    expect(info.available).to.equal(false);
    expect(info.detail).to.be.a('string');
  });
});

suite('source diagnostics parsing', () => {
  test('parses TypeScript diagnostics', () => {
    const [diag] = parseSourceDiagnostics('src/app.ts(12,5): error TS2322: Type mismatch', 'build');
    expect(diag.file).to.equal('src/app.ts');
    expect(diag.line).to.equal(12);
    expect(diag.column).to.equal(5);
    expect(diag.severity).to.equal('error');
    expect(diag.message).to.contain('Type mismatch');
  });

  test('parses Java compiler diagnostics', () => {
    const [diag] = parseSourceDiagnostics('User.java:10: error: cannot find symbol', 'build');
    expect(diag.file).to.equal('User.java');
    expect(diag.line).to.equal(10);
    expect(diag.severity).to.equal('error');
  });

  test('parses GCC/Clang diagnostics', () => {
    const [diag] = parseSourceDiagnostics('main.cpp:22:7: error: expected ;', 'build');
    expect(diag.file).to.equal('main.cpp');
    expect(diag.line).to.equal(22);
    expect(diag.column).to.equal(7);
  });

  test('parses Go diagnostics', () => {
    const [diag] = parseSourceDiagnostics('./cmd/main.go:31:5: undefined: foo', 'build');
    expect(diag.file).to.equal('cmd/main.go');
    expect(diag.line).to.equal(31);
  });

  test('parses Rust diagnostics with location line', () => {
    const diags = parseSourceDiagnostics(
      'error[E0308]: mismatched types\n  --> src/main.rs:12:5\n   |\n12 |     let x: i32 = "s";',
      'build',
    );
    expect(diags).to.have.length(1);
    expect(diags[0].file).to.equal('src/main.rs');
    expect(diags[0].line).to.equal(12);
    expect(diags[0].severity).to.equal('error');
  });

  test('parses Karkain-format diagnostics', () => {
    const [diag] = parseSourceDiagnostics('main.kark:5:9: error: unexpected token }', 'build');
    expect(diag.file).to.equal('main.kark');
    expect(diag.line).to.equal(5);
    expect(diag.column).to.equal(9);
    expect(diag.message).to.contain('unexpected token');
  });

  test('ignores lines that are not diagnostics', () => {
    expect(parseSourceDiagnostics('total 0 failures, everything green', 'test')).to.deep.equal([]);
  });
});
