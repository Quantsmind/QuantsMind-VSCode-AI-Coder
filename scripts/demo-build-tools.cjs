/**
 * Multi-toolchain build/test demonstration (v2.3.0).
 *
 * Runs REAL builds and tests for the toolchains available on this machine,
 * through the same ExecutionService + command allowlist path used by the
 * agent. Karkain is demonstrated two ways:
 *   1. the real `karkain` compiler is probed (`--version` works)
 *   2. a *controllable fixture compiler* (test/fixtures/karkain-toolkit)
 *      stands in for `karkain check/build/test`, because the real Karkain
 *      compiler cannot execute on this machine (verified: known-good
 *      conformance files exit silently with code 3 and no diagnostics).
 * Fixture-compiler results are labelled as such and never mixed with real
 * toolchain evidence.
 *
 * Usage: node scripts/demo-build-tools.cjs
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const base = path.resolve(__dirname, '..');
const { ExecutionService } = require(path.join(base, 'out/src/execution/service.js'));
const { detectBuildAdapters } = require(path.join(base, 'out/src/build/adapters.js'));
const { parseTestOutput } = require(path.join(base, 'out/src/build/testOutput.js'));
const { parseSourceDiagnostics } = require(path.join(base, 'out/src/diagnostics/sourceDiagnostics.js'));

const roots = [];

async function tempDir(name) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `quantsmind-demo-${name}-`));
  roots.push(dir);
  return dir;
}

function makeService() {
  return new ExecutionService(50);
}

async function runAllowlisted(service, command, allowlist, cwd, timeoutMs = 60_000, kind = 'command', signal) {
  return service.run(command, {
    kind,
    cwd,
    workspaceRoot: cwd,
    allowlist,
    timeoutMs,
    secret: undefined,
    trusted: true,
    ...(signal !== undefined ? { signal } : {}),
  });
}

function printResult(label, result) {
  console.log(`--- ${label}`);
  console.log(`  status=${result.status} exit=${result.exitCode} durationMs=${result.durationMs ?? 0}`);
  if (result.diagnostics?.length) {
    for (const diag of result.diagnostics.slice(0, 5)) {
      console.log(`  diag [${diag.severity}] ${diag.file ?? '-'}:${diag.line ?? '-'} ${diag.message}`);
    }
  }
  const trimmed = String(result.output).trim();
  if (trimmed.length > 0) {
    console.log(`  output: ${trimmed.slice(0, 300).replace(/\n/g, '\n          ')}`);
  }
  return result;
}

async function jsFixture() {
  const dir = await tempDir('js');
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'demo-js',
    scripts: {
      build: 'node --version',
      test: "node -e \"console.log('3 passing'); console.log('0 failing'); process.exit(0)\"",
    },
  }, null, 2));
  await fsp.writeFile(path.join(dir, 'index.js'), 'module.exports = () => 1;\n');
  return dir;
}

async function goFixture() {
  const dir = await tempDir('go');
  await fsp.writeFile(path.join(dir, 'go.mod'), 'module demo\n\ngo 1.21\n');
  await fsp.writeFile(path.join(dir, 'main.go'), 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("ok") }\n');
  await fsp.writeFile(path.join(dir, 'main_test.go'), 'package main\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) { if 1+1 != 2 { t.Fatal("math broke") } }\n');
  return dir;
}

async function pythonFixture() {
  const dir = await tempDir('py');
  await fsp.writeFile(path.join(dir, 'test_sample.py'), 'def test_ok():\n    assert 1 + 1 == 2\n');
  return dir;
}

async function karkainFixture() {
  const dir = await tempDir('karkain');
  await fsp.mkdir(path.join(dir, 'tests'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'main.kark'), 'func main() {\n    print("hi")\n}\n');
  await fsp.writeFile(path.join(dir, 'karkain.toml'), 'name = "demo"\nversion = "0.1.0"\n');
  return dir;
}

function entriesOf(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full, next); continue; }
      out.push({ path: next });
    }
  };
  walk(dir, '');
  return out;
}

async function demoDetect(service, dir) {
  const entries = entriesOf(dir);
  const detected = detectBuildAdapters(entries, {}).map((d) => d.adapter.id);
  console.log(`--- detect in ${path.basename(dir)}: ${detected.join(', ') || '(none)'}`);
  return detected;
}

async function main() {
  const service = makeService();

  // 1. Real npm build + test.
  const jsDir = await jsFixture();
  await demoDetect(service, jsDir);
  printResult('npm run build (real)', await runAllowlisted(service, 'npm run build', ['npm run build'], jsDir, 60_000, 'build'));
  printResult('npm test (real)', await runAllowlisted(service, 'npm test', ['npm test'], jsDir, 60_000, 'test'));

  // 2. Real Go build + test.
  const goDir = await goFixture();
  await demoDetect(service, goDir);
  printResult('go build ./... (real)', await runAllowlisted(service, 'go build ./...', ['go build ./...'], goDir, 120_000, 'build'));
  printResult('go test ./... (real)', await runAllowlisted(service, 'go test ./...', ['go test ./...'], goDir, 120_000, 'test'));

  // 3. Real Python unittest (PATH prepended with Python 3.11).
  const pyDir = await pythonFixture();
  const pyHome = 'C:\\Users\\Lenovo\\AppData\\Local\\Programs\\Python\\Python311';
  const oldPath = process.env.PATH ?? '';
  process.env.PATH = `${pyHome}${path.delimiter}${oldPath}`;
  await demoDetect(service, pyDir);
  printResult('python -m unittest discover -v (real)', await runAllowlisted(service, 'python -m unittest discover -v', ['python -m unittest discover -v'], pyDir, 60_000, 'test'));
  process.env.PATH = oldPath;

  // 4. Karkain: REAL compiler probe and REAL invocation attempt, plus
  //    fixture-compiler results clearly labelled as fixture-based.
  const karkainDir = await karkainFixture();
  await demoDetect(service, karkainDir);
  process.env.PATH = `F:\\Codes\\Git\\Karkain${path.delimiter}${process.env.PATH ?? ''}`;
  printResult('karkain --version (REAL compiler)', await runAllowlisted(service, 'karkain --version', ['karkain --version'], karkainDir, 10_000));
  printResult('karkain check main.kark (REAL compiler attempt)', await runAllowlisted(service, 'karkain check main.kark', ['karkain check main.kark'], karkainDir, 30_000));
  process.env.PATH = oldPath;

  process.env.PATH = `${path.resolve(base, 'test/fixtures/karkain-toolkit')}${path.delimiter}${process.env.PATH ?? ''}`;
  const fixtureResult = printResult('karkain check main.kark (FIXTURE compiler — not the real toolchain)', await runAllowlisted(service, 'karkain check main.kark', ['karkain check main.kark'], karkainDir, 10_000));
  const diagnostics = parseSourceDiagnostics(String(fixtureResult.output), 'build');
  console.log(`  parsed karkain diagnostics: ${JSON.stringify(diagnostics)}`);
  printResult('karkain test . (FIXTURE compiler — not the real toolchain)', await runAllowlisted(service, 'karkain test .', ['karkain test .'], karkainDir, 10_000, 'test'));
  const parsed = parseTestOutput('PASS test_square\nFAIL test_cube\nPASS test_main', 'karkain');
  console.log(`  karkain test parse: passed=${parsed.passed} failed=${parsed.failed} total=${parsed.total}`);

  console.log('\nExecution record kinds recorded:');
  for (const record of service.list()) {
    console.log(`  ${record.kind.padEnd(5)} ${record.command.padEnd(45)} -> ${record.status}`);
  }

  for (const root of roots) {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Demonstration failed:', error);
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.exitCode = 1;
});
