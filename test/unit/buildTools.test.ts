import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BuildTools } from '../../src/agent/buildTools';
import { CommandTools } from '../../src/agent/commandTools';
import { ExecutionService } from '../../src/execution/service';
import type { WorkspaceEntry } from '../../src/workspace/analyze';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'test', 'fixtures');
const NPM_FIXTURE = path.join(FIXTURES, 'npm-scripts-fixture');
const KARKAIN_BROKEN = path.join(FIXTURES, 'karkain-broken');
const KARKAIN_TOOLKIT = path.join(FIXTURES, 'karkain-toolkit');

function readFixture(root: string, skip: ReadonlySet<string> = new Set(['node_modules', '.git'])): WorkspaceEntry[] {
  const entries: WorkspaceEntry[] = [];
  const walk = (directory: string, relative: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const next = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) {
          walk(absolute, next);
        }
        continue;
      }
      entries.push({ path: next });
    }
  };
  walk(root, '');
  return entries;
}

function readConfig(fixture: string): Record<string, string> {
  const contents: Record<string, string> = {};
  for (const entry of readFixture(fixture)) {
    if (/(^|\/)(package\.json|karkain\.toml|go\.mod|pom\.xml)$/i.test(entry.path)) {
      try {
        contents[entry.path] = fs.readFileSync(path.join(fixture, entry.path), 'utf8');
      } catch {
        // Skip unreadable files in fixtures.
      }
    }
  }
  return contents;
}

interface Harness {
  readonly tools: BuildTools;
  readonly service: ExecutionService;
  readonly approvals: { command: string }[];
}

function harness(fixture: string, approved = true): Harness {
  const service = new ExecutionService();
  const approvals: { command: string }[] = [];
  const commandTools = new CommandTools({
    cwd: () => fixture,
    workspaceRoot: () => fixture,
    allowlist: () => ['npm run build', 'npm test', 'karkain build broken.kark', 'karkain test .', 'karkain --version'],
    timeoutMs: () => 30_000,
    maxOutputChars: () => 20_000,
    secret: () => Promise.resolve(undefined),
    trusted: () => true,
    approval: async (request) => {
      approvals.push(request);
      return approved;
    },
    executionService: service,
  });
  const tools = new BuildTools({
    trusted: () => true,
    entries: async () => readFixture(fixture),
    configContents: async () => readConfig(fixture),
    commandTools,
    executionService: service,
  });
  return { tools, service, approvals };
}

suite('build tools — npm fixture', () => {
  test('detects the npm build system with commands and toolchain', async () => {
    const { tools } = harness(NPM_FIXTURE);
    const result = await tools.detectBuildSystem();

    expect(result.ok).to.equal(true);
    const parsed = JSON.parse(result.output ?? '{}') as { detected: Array<{ id: string; buildCommands: string[]; testCommands: string[]; toolchainAvailable: boolean }> };
    const npm = parsed.detected.find((adapter) => adapter.id === 'npm');
    expect(npm).to.not.equal(undefined);
    expect(npm?.buildCommands).to.deep.equal(['npm run build']);
    expect(npm?.testCommands).to.deep.equal(['npm test']);
    expect(npm?.toolchainAvailable).to.equal(true);
  });

  test('runs the approved npm build and records it in execution history', async () => {
    const { tools, service, approvals } = harness(NPM_FIXTURE);

    const result = await tools.runBuild({ adapter: 'npm' });

    expect(result.ok).to.equal(true);
    expect(approvals.map((request) => request.command)).to.deep.equal(['npm run build']);
    expect(service.historyForTask(undefined).some((entry) => entry.kind === 'build')).to.equal(true);
    const parsed = JSON.parse(result.output ?? '{}') as { steps: Array<{ ok: boolean }> };
    expect(parsed.steps.every((step) => step.ok)).to.equal(true);
  });

  test('runs the approved npm test and reports pass/fail counts', async () => {
    const { tools, approvals } = harness(NPM_FIXTURE);

    const result = await tools.runTests({ adapter: 'npm' });

    expect(result.ok).to.equal(false);
    expect(approvals).to.have.length(1);
    const parsed = JSON.parse(result.output ?? '{}') as { tests?: { passed?: number; failed?: number } };
    expect(parsed.tests?.passed).to.equal(3);
    expect(parsed.tests?.failed).to.equal(1);
  });

  test('refuses to run without approval and records nothing', async () => {
    const { tools, service, approvals } = harness(NPM_FIXTURE, false);

    const result = await tools.runBuild({ adapter: 'npm' });

    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('approval');
    expect(approvals).to.have.length(1);
    expect(service.historyForTask(undefined)).to.have.length(0);
  });

  test('reports the requested adapter is not detected', async () => {
    const { tools } = harness(NPM_FIXTURE);

    const result = await tools.runBuild({ adapter: 'maven' });

    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('maven');
    expect(result.error).to.contain('npm');
  });
});

suite('build tools — Karkain with the controllable fixture compiler', () => {
  let originalPath: string | undefined;

  setup(() => {
    originalPath = process.env.PATH;
    process.env.PATH = `${path.resolve(KARKAIN_TOOLKIT)}${path.delimiter}${originalPath ?? ''}`;
  });

  teardown(() => {
    process.env.PATH = originalPath;
  });

  test('detects the karkain adapter and probes the fixture compiler', async () => {
    const { tools } = harness(KARKAIN_BROKEN);
    const result = await tools.detectBuildSystem();

    expect(result.ok).to.equal(true);
    const parsed = JSON.parse(result.output ?? '{}') as { detected: Array<{ id: string; toolchainAvailable: boolean; toolchainVersion?: string; buildCommands: string[] }> };
    const karkain = parsed.detected.find((adapter) => adapter.id === 'karkain');
    expect(karkain).to.not.equal(undefined);
    expect(karkain?.toolchainAvailable).to.equal(true);
    expect(karkain?.toolchainVersion).to.equal('1.1.0');
    expect(karkain?.buildCommands).to.deep.equal(['karkain build broken.kark']);
  });

  test('runs the fixture compiler and extracts karkain diagnostics (not a real toolchain run)', async () => {
    const { tools, approvals } = harness(KARKAIN_BROKEN);

    const result = await tools.runBuild({ adapter: 'karkain' });

    expect(result.ok).to.equal(false);
    expect(approvals.map((request) => request.command)).to.deep.equal(['karkain build broken.kark']);
    const parsed = JSON.parse(result.output ?? '{}') as {
      adapter: string;
      diagnostics: Array<{ file?: string; line?: number; column?: number; message: string }>;
    };
    expect(parsed.adapter).to.equal('karkain');
    const diag = parsed.diagnostics.find((item) => item.file === 'main.kark');
    expect(diag?.line).to.equal(5);
    expect(diag?.column).to.equal(9);
    expect(diag?.message).to.contain('unexpected token');
  });

  test('runs the fixture compiler test command and parses PASS/FAIL markers', async () => {
    const { tools } = harness(KARKAIN_BROKEN);

    const result = await tools.runTests({ adapter: 'karkain' });

    expect(result.ok).to.equal(false);
    const parsed = JSON.parse(result.output ?? '{}') as { tests?: { passed?: number; failed?: number; total?: number } };
    expect(parsed.tests?.passed).to.equal(2);
    expect(parsed.tests?.failed).to.equal(1);
    expect(parsed.tests?.total).to.equal(3);
  });
});
