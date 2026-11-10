/**
 * Diagnostic-and-repair workflow demonstration (v2.3.0 WP4/WP5).
 *
 * A real coding-agent loop runs against an isolated fixture project:
 *   1. it detects the build system,
 *   2. runs the failing test suite through the pending-approval path,
 *   3. receives a failing-test diagnostic,
 *   4. reads the source, proposes a repair, applies it via the approved
 *      change pipeline, and re-runs the tests,
 *   5. reports the verified result.
 *
 * The model is scripted so the demonstration is deterministic; the build,
 * test, approval and change-tracking steps are the production code paths.
 *
 * Usage: node scripts/demo-diagnostic-repair.cjs
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const base = path.resolve(__dirname, '..');
const { runCodingAgent } = require(path.join(base, 'out/src/agent/codingAgent.js'));
const { WorkspaceTools } = require(path.join(base, 'out/src/agent/workspaceTools.js'));
const { FileSystemTools } = require(path.join(base, 'out/src/agent/fileSystemTools.js'));
const { CommandTools } = require(path.join(base, 'out/src/agent/commandTools.js'));
const { BuildTools } = require(path.join(base, 'out/src/agent/buildTools.js'));
const { ExecutionService } = require(path.join(base, 'out/src/execution/service.js'));
const { applyChangePlan } = require(path.join(base, 'out/src/changes/apply.js'));
const { buildReviewChanges } = require(path.join(base, 'out/src/changes/review.js'));
const { hashContent } = require(path.join(base, 'out/src/changes/model.js'));

const BUGGY_ADD = 'function add(a, b) {\n  return a - b;\n}\nmodule.exports = add;\n';
const FIXED_ADD = 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = add;\n';
const TEST_FILE = `const add = require('./add.js');
const ok1 = add(2, 3) === 5;
const ok2 = add(10, 20) === 30;
if (ok1 && ok2) {
  console.log('3 passing');
  console.log('0 failing');
  process.exit(0);
}
if (!ok1) { console.log('1 failing'); }
if (!ok2) { console.log('1 failing'); }
process.exit(1);
`;

class NodePathFs {
  constructor(root) {
    this.root = root;
  }
  async createDirectory(p) {
    await fsp.mkdir(p, { recursive: true });
  }
  async deletePath(p, recursive) {
    await fsp.rm(p, { recursive, force: true });
  }
  async renamePath(from, to) {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
  }
  async statPath(p) {
    try {
      const stat = await fsp.stat(p);
      return { type: stat.isDirectory() ? 'directory' : 'file', size: stat.size };
    } catch {
      return undefined;
    }
  }
  async exists(p) {
    try {
      await fsp.stat(p);
      return true;
    } catch {
      return false;
    }
  }
}

class NodeChangeFs {
  constructor(root, backupRoot) {
    this.root = root;
    this.backupRoot = backupRoot;
  }
  async readText(p) {
    try {
      return await fsp.readFile(path.join(this.root, p), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }
  async writeText(p, content) {
    const target = path.join(this.root, p);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf8');
  }
  async deleteFile(p) {
    await fsp.rm(path.join(this.root, p), { force: true });
  }
  async move(from, to) {
    const target = path.join(this.root, to);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rename(path.join(this.root, from), target);
  }
  async exists(p) {
    try {
      await fsp.stat(path.join(this.root, p));
      return true;
    } catch {
      return false;
    }
  }
  async writeBackup(name, content) {
    await fsp.mkdir(this.backupRoot, { recursive: true });
    await fsp.writeFile(path.join(this.backupRoot, name), content, 'utf8');
  }
  async readBackup(name) {
    try {
      return await fsp.readFile(path.join(this.backupRoot, name), 'utf8');
    } catch {
      return undefined;
    }
  }
  async removeBackup(name) {
    await fsp.rm(path.join(this.backupRoot, name), { force: true });
  }
}

class NodeChangeService {
  constructor(root, backupRoot) {
    this.root = root;
    this.backupRoot = backupRoot;
    this.history = [];
  }
  createFs(taskId) {
    return new NodeChangeFs(this.root, path.join(this.backupRoot, taskId));
  }
  async prepare(plan, taskId) {
    const fsx = this.createFs(taskId);
    const beforeByPath = new Map();
    const prepared = [];
    const errors = [];
    for (const change of plan.changes) {
      const source = change.kind === 'rename' ? change.fromPath : change.path;
      const before = await fsx.readText(source);
      if (change.kind === 'create') {
        prepared.push(change);
        beforeByPath.set(change.path, before);
        continue;
      }
      if (before === undefined) {
        errors.push(`${source} does not exist.`);
        continue;
      }
      prepared.push({ ...change, expectedHash: hashContent(before) });
      beforeByPath.set(change.path, before);
    }
    if (errors.length > 0) {
      return { plan: { ...plan, changes: [] }, beforeByPath, review: [], errors, warnings: [] };
    }
    const preparedPlan = { ...plan, changes: prepared };
    return { plan: preparedPlan, beforeByPath, review: buildReviewChanges(preparedPlan.changes, beforeByPath), errors, warnings: [] };
  }
  async apply(plan, approvedIds, taskId, summary) {
    const fsx = this.createFs(taskId);
    const outcome = await applyChangePlan(plan, fsx, { approvedIds });
    const entry = {
      applyId: `${taskId}-apply`,
      taskId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      summary,
      status: outcome.applied.length > 0 ? 'applied' : 'rejected',
      files: outcome.applied.map((file) => ({
        changeId: file.changeId,
        kind: file.kind,
        path: file.path,
        status: 'applied',
        backupName: file.backupName,
      })),
      undoable: outcome.applied.length > 0,
    };
    this.history.push(entry);
    return { outcome, entry };
  }
  async undo(taskId) {
    const entries = this.history.filter((entry) => entry.taskId === taskId && entry.undoable);
    return entries.length === 0 ? undefined : { restored: 0, conflicts: 0 };
  }
  listHistory() {
    return this.history;
  }
}

function entries(dir) {
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

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'quantsmind-repair-demo-'));
  try {
    await fsp.writeFile(path.join(dir, 'add.js'), BUGGY_ADD, 'utf8');
    await fsp.writeFile(path.join(dir, 'test_add.js'), TEST_FILE, 'utf8');
    await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: 'repair-demo',
      scripts: { test: 'node test_add.js', build: 'node --version' },
    }, null, 2) + '\n');

    const service = new ExecutionService(20);
    const changes = new NodeChangeService(dir, path.join(dir, '.backups'));
    const pathFs = new NodePathFs(dir);
    const fixtureEntries = entries(dir);
    const commandTools = new CommandTools({
      cwd: () => dir,
      workspaceRoot: () => dir,
      allowlist: () => ['npm test', 'npm run build'],
      timeoutMs: () => 30_000,
      maxOutputChars: () => 20_000,
      secret: () => Promise.resolve(undefined),
      trusted: () => true,
      approval: async (request) => {
        console.log(`[approval] ${request.command}`);
        return true;
      },
      executionService: service,
    });
    const buildTools = new BuildTools({
      trusted: () => true,
      entries: async () => fixtureEntries,
      configContents: async () => ({ 'package.json': fs.readFileSync(path.join(dir, 'package.json'), 'utf8') }),
      commandTools,
      executionService: service,
    });
    const workspaceTools = new WorkspaceTools(dir, {
      async readFile(relativePath) {
        const target = path.join(dir, relativePath);
        return await fsp.readFile(target, 'utf8');
      },
      async listDirectory(relativePath) {
        const listing = await fsp.readdir(path.join(dir, relativePath), { withFileTypes: true });
        return listing.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }));
      },
    });
    const fileSystemTools = new FileSystemTools({
      rootPath: dir,
      pathFs,
      changes,
      trusted: () => true,
      approval: async (request) => {
        console.log(`[approval] ${request.operation} ${request.path}`);
        return true;
      },
    });
    const tools = [
      ...workspaceTools.toAgentTools(),
      ...commandTools.toAgentTools(),
      ...buildTools.toAgentTools(),
      ...fileSystemTools.toAgentTools(),
    ];

    let step = 0;
    const model = {
      async complete() {
        step += 1;
        if (step === 1) {
          return { text: JSON.stringify({ tool_calls: [{ name: 'detect_build_system', arguments: {} }] }) };
        }
        if (step === 2) {
          return { text: JSON.stringify({ tool_calls: [{ name: 'run_tests', arguments: {} }] }) };
        }
        if (step === 3) {
          return { text: JSON.stringify({ tool_calls: [{ name: 'read_file', arguments: { path: 'add.js' } }] }) };
        }
        if (step === 4) {
          return { text: JSON.stringify({ tool_calls: [{ name: 'write_file', arguments: { path: 'add.js', content: FIXED_ADD } }] }) };
        }
        if (step === 5) {
          return { text: JSON.stringify({ tool_calls: [{ name: 'run_tests', arguments: {} }] }) };
        }
        return {
          text: JSON.stringify({
            final: 'The bug was in add.js (a - b). After fixing to (a + b) the suite reports 3 passing, 0 failing.',
          }),
        };
      },
    };

    console.log(`Workspace: ${dir}`);
    const result = await runCodingAgent({
      task: 'The add function in add.js is wrong. Fix it so the tests pass, then verify by running the tests.',
      model,
      tools,
      maxIterations: 10,
      onEvent: (event) => {
        if (event.type === 'tool') {
          console.log(`[tool] ${event.tool}: ${event.ok ? 'ok' : 'FAILED'}`);
        }
      },
    });

    const finalAdd = await fsp.readFile(path.join(dir, 'add.js'), 'utf8');
    console.log(`\n--- add.js after repair ---\n${finalAdd}`);
    console.log('--- execution history (newest first) ---');
    for (const record of service.list()) {
      console.log(`  ${record.kind.padEnd(5)} ${record.command.padEnd(20)} -> ${record.status} (${record.durationMs ?? 0}ms)`);
    }
    console.log('--- change history ---');
    for (const entry of changes.history) {
      console.log(`  ${entry.status} ${entry.summary} (${entry.files.map((file) => `${file.kind}:${file.path}`).join(', ')})`);
    }

    const checks = [
      ['agent completed', result.status === 'completed'],
      ['bug fixed on disk', finalAdd.includes('return a + b')],
      ['tests executed and recorded', service.list().some((r) => r.kind === 'test' && r.status === 'succeeded')],
      ['a failing test run was recorded before repair', service.list().some((r) => r.kind === 'test' && r.status === 'failed')],
      ['change history recorded', changes.history.length === 1],
    ];
    console.log('\n--- verification ---');
    for (const [label, ok] of checks) {
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    }
    if (checks.some(([, ok]) => !ok)) {
      process.exitCode = 1;
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Demonstration failed:', error);
  process.exitCode = 1;
});
