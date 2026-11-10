/**
 * WP5 functional demonstration for the QuantsMind agent foundation.
 *
 * Runs the real coding-agent loop (out/src/agent/codingAgent.js) against an
 * isolated workspace with real filesystem mutations and real command execution.
 * The model is scripted so the demonstration is deterministic and offline; the
 * tools, approvals, change tracking and command runner are the production code.
 *
 * Usage: node scripts/demo-agent-workspace.cjs
 */
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { runCodingAgent } = require('../out/src/agent/codingAgent.js');
const { WorkspaceTools } = require('../out/src/agent/workspaceTools.js');
const { FileSystemTools } = require('../out/src/agent/fileSystemTools.js');
const { CommandTools } = require('../out/src/agent/commandTools.js');
const { applyChangePlan } = require('../out/src/changes/apply.js');
const { buildReviewChanges } = require('../out/src/changes/review.js');
const { hashContent } = require('../out/src/changes/model.js');

const PYTHON_HOME = 'C:\\Users\\Lenovo\\AppData\\Local\\Programs\\Python\\Python311';
const TEST_COMMAND = 'python -B -m unittest test_calculator.py -v';

const BUGGY_CALCULATOR = `def add(a, b):
    return a - b
`;

const FIXED_CALCULATOR = `def add(a, b):
    return a + b
`;

const TEST_FILE = `import unittest

from calculator import add


class TestCalculator(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(2, 3), 5)


if __name__ == '__main__':
    unittest.main()
`;

class NodePathFs {
  constructor(root) {
    this.root = root;
  }

  async createDirectory(absolutePath) {
    await fsp.mkdir(absolutePath, { recursive: true });
  }

  async deletePath(absolutePath, recursive) {
    await fsp.rm(absolutePath, { recursive, force: true });
  }

  async renamePath(fromAbsolute, toAbsolute) {
    await fsp.mkdir(path.dirname(toAbsolute), { recursive: true });
    await fsp.rename(fromAbsolute, toAbsolute);
  }

  async statPath(absolutePath) {
    try {
      const stat = await fsp.stat(absolutePath);
      return { type: stat.isDirectory() ? 'directory' : 'file', size: stat.size };
    } catch {
      return undefined;
    }
  }

  async exists(absolutePath) {
    try {
      await fsp.stat(absolutePath);
      return true;
    } catch {
      return false;
    }
  }
}

/** ChangeFs implementation over node:fs, used by the real applyChangePlan. */
class NodeChangeFs {
  constructor(root, backupRoot) {
    this.root = root;
    this.backupRoot = backupRoot;
  }

  async readText(relativePath) {
    try {
      return await fsp.readFile(path.join(this.root, relativePath), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async writeText(relativePath, content) {
    const target = path.join(this.root, relativePath);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf8');
  }

  async deleteFile(relativePath) {
    await fsp.rm(path.join(this.root, relativePath), { force: true });
  }

  async move(from, to) {
    const target = path.join(this.root, to);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rename(path.join(this.root, from), target);
  }

  async exists(relativePath) {
    try {
      await fsp.stat(path.join(this.root, relativePath));
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

/** Minimal ChangeApprovalService that reuses the production apply pipeline. */
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
    const fs = this.createFs(taskId);
    const errors = [];
    const warnings = [];
    const beforeByPath = new Map();
    const prepared = [];

    for (const change of plan.changes) {
      const sourcePath = change.kind === 'rename' ? change.fromPath : change.path;
      if (sourcePath === undefined) {
        errors.push(`${change.path} has no source path.`);
        continue;
      }
      const before = await fs.readText(sourcePath);
      if (change.kind === 'create') {
        if (before !== undefined) {
          warnings.push(`${change.path} already exists.`);
        }
        prepared.push(change);
        beforeByPath.set(change.path, before);
        continue;
      }
      if (before === undefined) {
        errors.push(`${sourcePath} does not exist.`);
        continue;
      }
      prepared.push({ ...change, expectedHash: hashContent(before) });
      beforeByPath.set(change.path, before);
    }

    if (errors.length > 0) {
      return { plan: { ...plan, changes: [] }, beforeByPath, review: [], errors, warnings };
    }
    const preparedPlan = { ...plan, changes: prepared };
    return {
      plan: preparedPlan,
      beforeByPath,
      review: buildReviewChanges(preparedPlan.changes, beforeByPath),
      errors,
      warnings,
    };
  }

  async apply(plan, approvedIds, taskId, summary) {
    const fs = this.createFs(taskId);
    const outcome = await applyChangePlan(plan, fs, { approvedIds });
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
        fromPath: file.fromPath,
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

function createScriptedModel() {
  let step = 0;
  return {
    async complete(messages) {
      step += 1;
      const last = messages[messages.length - 1];
      const content = typeof last?.content === 'string' ? last.content : '';

      if (step === 1) {
        return {
          text: JSON.stringify({
            tool_calls: [
              { name: 'list_files', arguments: { path: '' } },
              { name: 'read_file', arguments: { path: 'calculator.py' } },
            ],
          }),
        };
      }
      if (step === 2) {
        return {
          text: JSON.stringify({
            tool_calls: [
              { name: 'write_file', arguments: { path: 'test_calculator.py', content: TEST_FILE } },
            ],
          }),
        };
      }
      if (step === 3) {
        return {
          text: JSON.stringify({
            tool_calls: [{ name: 'run_command', arguments: { command: TEST_COMMAND } }],
          }),
        };
      }
      if (step === 4) {
        if (content.includes('FAILED') || content.includes('AssertionError')) {
          return {
            text: JSON.stringify({
              tool_calls: [
                { name: 'write_file', arguments: { path: 'calculator.py', content: FIXED_CALCULATOR } },
              ],
            }),
          };
        }
        return { text: JSON.stringify({ final: 'The tests already passed; no fix was needed.' }) };
      }
      if (step === 5) {
        return {
          text: JSON.stringify({
            tool_calls: [{ name: 'run_command', arguments: { command: TEST_COMMAND } }],
          }),
        };
      }
      return {
        text: JSON.stringify({
          final:
            'Fixed calculator.py: add(a, b) now returns a + b instead of a - b.\n\n' +
            `Final test run:\n${content.slice(-600)}`,
        }),
      };
    },
  };
}

async function main() {
  // The command runner resolves bare names against PATH, so expose Python.
  process.env.PATH = `${PYTHON_HOME}${path.delimiter}${process.env.PATH ?? ''}`;

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'quantsmind-agent-demo-'));
  const backupRoot = path.join(root, '.quantsmind-backups');
  await fsp.writeFile(path.join(root, 'calculator.py'), BUGGY_CALCULATOR, 'utf8');

  console.log(`Workspace: ${root}`);
  console.log(`Initial calculator.py:\n${BUGGY_CALCULATOR}`);

  const pathFs = new NodePathFs(root);
  const changes = new NodeChangeService(root, backupRoot);

  const fileSystem = {
    async readFile(relativePath) {
      return await fsp.readFile(path.join(root, relativePath), 'utf8');
    },
    async listDirectory(relativePath) {
      const base = path.join(root, relativePath);
      const entries = await fsp.readdir(base, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
      }));
    },
  };

  const workspaceTools = new WorkspaceTools(root, fileSystem);
  const fileSystemTools = new FileSystemTools({
    rootPath: root,
    pathFs,
    changes,
    trusted: () => true,
    approval: async (request) => {
      console.log(`[approval] ${request.operation} ${request.path}`);
      return true;
    },
  });
  const commandTools = new CommandTools({
    cwd: () => root,
    workspaceRoot: () => root,
    allowlist: () => [TEST_COMMAND],
    timeoutMs: () => 60_000,
    maxOutputChars: () => 20_000,
    secret: () => undefined,
    trusted: () => true,
    approval: async (request) => {
      console.log(`[approval] ${request.command}`);
      return true;
    },
  });

  const tools = [
    ...workspaceTools.toAgentTools(),
    ...fileSystemTools.toAgentTools(),
    ...commandTools.toAgentTools(),
  ];

  const result = await runCodingAgent({
    task:
      'The add function in calculator.py is wrong. Create test_calculator.py, run the tests, ' +
      'fix the bug, and run the tests again.',
    model: createScriptedModel(),
    tools,
    maxIterations: 12,
    onEvent: (event) => {
      if (event.type === 'tool') {
        console.log(`[tool] ${event.tool}: ${event.ok ? 'ok' : 'failed'}`);
      }
    },
  });

  console.log('\n--- final answer ---');
  console.log(result.finalText);
  console.log('\n--- final workspace ---');
  for (const name of await fsp.readdir(root)) {
    const absolute = path.join(root, name);
    const stat = await fsp.stat(absolute);
    if (!stat.isFile()) {
      continue;
    }
    const content = await fsp.readFile(absolute, 'utf8');
    console.log(`\n### ${name}\n${content}`);
  }

  console.log('\n--- change history ---');
  for (const entry of changes.history) {
    console.log(`${entry.status} ${entry.summary} (${entry.files.map((file) => `${file.kind}:${file.path}`).join(', ')})`);
  }

  const finalCalculator = await fsp.readFile(path.join(root, 'calculator.py'), 'utf8');
  const finalTest = await fsp.readFile(path.join(root, 'test_calculator.py'), 'utf8');
  const verified =
    result.status === 'completed' &&
    finalCalculator.includes('return a + b') &&
    finalTest.includes('test_add') &&
    result.finalText.includes('OK');

  console.log(`\nVerification: ${verified ? 'PASS' : 'FAIL'}`);
  console.log(`Agent status: ${result.status}, iterations: ${result.iterations}, tools: ${result.toolResults.length}`);

  await fsp.rm(root, { recursive: true, force: true });
  process.exitCode = verified ? 0 : 1;
}

main().catch((error) => {
  console.error('Demonstration failed:', error);
  process.exitCode = 1;
});
