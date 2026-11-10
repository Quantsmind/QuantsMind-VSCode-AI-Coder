/**
 * Karkain-aware agent demonstration (v2.2.0).
 *
 * Runs the real coding-agent loop (out/src/agent/codingAgent.js) against an
 * isolated copy of the checked-in Karkain fixture project. Tools, approvals,
 * change tracking and the repository-analysis pipeline are the production
 * code. The model is scripted so the demonstration is deterministic and
 * offline; the analysis and filesystem operations are real.
 *
 * Usage: node scripts/demo-karkain-agent.cjs
 */
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { runCodingAgent } = require('../out/src/agent/codingAgent.js');
const { WorkspaceTools } = require('../out/src/agent/workspaceTools.js');
const { FileSystemTools } = require('../out/src/agent/fileSystemTools.js');
const { RepositoryTools } = require('../out/src/agent/repositoryTools.js');
const { applyChangePlan } = require('../out/src/changes/apply.js');
const { buildReviewChanges } = require('../out/src/changes/review.js');
const { hashContent } = require('../out/src/changes/model.js');
const { analyzeSourceFile } = require('../out/src/repository/symbols.js');
const { DependencyGraphBuilder } = require('../out/src/repository/graph.js');
const { discoverRepository } = require('../out/src/repository/discovery.js');
const { analyzeArchitecture } = require('../out/src/project/architecture.js');
const {
  buildKarkainModuleGraph,
  collectKarkainContext,
  summarizeKarkainProject,
} = require('../out/src/project/karkain.js');
const { normalizeWorkspacePath } = require('../out/src/workspace/analyze.js');

const FIXTURE_ROOT = path.join(__dirname, '..', 'test', 'fixtures', 'karkain-project');

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
    const beforeByPath = new Map();
    const prepared = [];
    const errors = [];
    for (const change of plan.changes) {
      const sourcePath = change.kind === 'rename' ? change.fromPath : change.path;
      if (sourcePath === undefined) {
        errors.push(`${change.path} has no source path.`);
        continue;
      }
      const before = await fs.readText(sourcePath);
      if (change.kind === 'create') {
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
      return { plan: { ...plan, changes: [] }, beforeByPath, review: [], errors, warnings: [] };
    }
    const preparedPlan = { ...plan, changes: prepared };
    return {
      plan: preparedPlan,
      beforeByPath,
      review: buildReviewChanges(preparedPlan.changes, beforeByPath),
      errors: [],
      warnings: [],
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

async function readKarkainFixture() {
  const files = [];
  const walk = async (directory) => {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      const relative = path.relative(FIXTURE_ROOT, absolute).split(path.sep).join('/');
      if (relative === 'karkain.toml') {
        continue;
      }
      files.push({ path: relative, content: await fsp.readFile(absolute, 'utf8') });
    }
  };
  await walk(FIXTURE_ROOT);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function createRepositoryIntelligence(files, entries, configContents) {
  const analyses = files.map((file) => analyzeSourceFile(file.path, file.content));
  const builder = new DependencyGraphBuilder({ maxNodes: 100, maxEdges: 400 });
  for (const analysis of analyses) {
    builder.upsert(analysis);
  }
  const overview = discoverRepository({ rootName: 'karkain-project', entries, configContents });
  const graph = builder.snapshot();
  const architecture = analyzeArchitecture(analyses, overview, graph, {});
  const karkainAnalyses = analyses.filter((analysis) => analysis.language === 'karkain');
  const karkainGraph = buildKarkainModuleGraph(karkainAnalyses);
  const karkainSummary = summarizeKarkainProject('karkain-project', karkainAnalyses, karkainGraph);
  return {
    overview: async () => overview,
    selectContext: async (query, options) => ({
      truncated: false,
      budgetChars: options.maxChars ?? 40_000,
      selections: [],
      summary: overview.summary,
      items: [],
      reasons: {},
      skipped: [],
    }),
    analyzeChanges: async () => ({ files: [], tests: [], commands: [], evidence: [] }),
    findSymbols: async (query) =>
      analyses
        .flatMap((analysis) => analysis.symbols.map((symbol) => ({ analysis, symbol })))
        .filter(({ symbol }) => symbol.name.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 20)
        .map(({ analysis, symbol }) => ({
          path: analysis.path,
          name: symbol.name,
          kind: symbol.kind,
          line: symbol.line,
          exported: symbol.exported,
          confidence: symbol.confidence,
        })),
    architecture: async () => architecture,
    karkainContext: async (query, options) => collectKarkainContext(query, karkainAnalyses, options ?? {}),
    karkainProject: async () => karkainSummary,
  };
}

function createScriptedModel(newContent) {
  let step = 0;
  return {
    async complete() {
      step += 1;
      if (step === 1) {
        return {
          text: JSON.stringify({
            tool_calls: [
              { name: 'get_karkain_context', arguments: { query: 'square mathutils' } },
              { name: 'get_architecture', arguments: {} },
            ],
          }),
        };
      }
      if (step === 2) {
        return {
          text: JSON.stringify({
            tool_calls: [
              {
                name: 'write_file',
                arguments: { path: 'mathutils.kark', content: newContent, summary: 'add double_square helper' },
              },
            ],
          }),
        };
      }
      return {
        text: JSON.stringify({
          final:
            'Inspected the Karkain project, added double_square to mathutils.kark, and wrote it through the approved change pipeline.',
        }),
      };
    },
  };
}

async function main() {
  const fixtureFiles = await readKarkainFixture();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'quantsmind-karkain-demo-'));
  for (const file of fixtureFiles) {
    const target = path.join(root, file.path);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, file.content, 'utf8');
  }

  const entries = fixtureFiles.map((file) => ({ path: file.path, size: file.content.length }));
  const configContents = { 'karkain.toml': await fsp.readFile(path.join(FIXTURE_ROOT, 'karkain.toml'), 'utf8') };
  const intelligence = createRepositoryIntelligence(fixtureFiles, entries, configContents);

  const before = await fsp.readFile(path.join(root, 'mathutils.kark'), 'utf8');
  const newContent = `${before}public func double_square(n) {
    return square(n) * 2
}
`;

  const repositoryTools = new RepositoryTools(intelligence);
  const changes = new NodeChangeService(root, path.join(root, '.quantsmind-backups'));
  const pathFs = new NodePathFs(root);
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
  const workspaceTools = new WorkspaceTools(root, {
    async readFile(relativePath) {
      return await fsp.readFile(path.join(root, normalizeWorkspacePath(relativePath)), 'utf8');
    },
    async listDirectory(relativePath) {
      const resolved = normalizeWorkspacePath(relativePath);
      const directory = path.join(root, resolved);
      const listing = await fsp.readdir(directory, { withFileTypes: true });
      return listing.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
      }));
    },
  });

  const tools = [
    ...workspaceTools.toAgentTools(),
    ...repositoryTools.toAgentTools(),
    ...fileSystemTools.toAgentTools(),
  ];

  console.log(`Workspace: ${root}`);
  console.log('--- agent task: inspect the Karkain project, then extend mathutils ---');
  const result = await runCodingAgent({
    task: 'Inspect the Karkain project and extend mathutils.kark with a double_square helper.',
    model: createScriptedModel(newContent),
    tools,
    maxIterations: 6,
    onEvent: (event) => {
      if (event.type === 'tool') {
        console.log(`[tool] ${event.tool}: ${event.ok ? 'ok' : 'failed'}`);
        if (event.tool === 'get_karkain_context' || event.tool === 'get_architecture') {
          console.log(String(event.output).slice(0, 700));
        }
      }
    },
  });

  const after = await fsp.readFile(path.join(root, 'mathutils.kark'), 'utf8');
  console.log('\n--- mathutils.kark after the agent run ---');
  console.log(after);
  console.log('--- change history ---');
  for (const entry of changes.history) {
    console.log(`  ${entry.status} ${entry.summary} -> ${entry.files.map((file) => `${file.kind}:${file.path}`).join(', ')}`);
  }

  const checks = [
    ['agent completed', result.status === 'completed'],
    ['mathutils.kark extended with double_square', after.includes('public func double_square(n)')],
    ['before content preserved', after.includes('func square(n)') && after.includes('public func magnitude(p)')],
    ['change history recorded', changes.history.length === 1],
    ['new function was applied through approval', changes.history[0]?.files.some((file) => file.kind === 'modify')],
  ];
  console.log('\n--- verification ---');
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  }

  await fsp.rm(root, { recursive: true, force: true });
  if (checks.some(([, ok]) => !ok)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Demonstration failed:', error);
  process.exitCode = 1;
});
