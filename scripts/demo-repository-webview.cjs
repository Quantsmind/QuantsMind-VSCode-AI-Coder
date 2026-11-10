/**
 * Webview evidence for the architecture capabilities.
 *
 * Executes the real media/chat.js inside a minimal DOM shim, posts a real
 * `repository` host message built from the checked-in fixture projects, and
 * asserts that the webview renders the architecture and Karkain sections.
 * This is a runtime check of the shipped webview script, not a marker check.
 *
 * Usage: node scripts/demo-repository-webview.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const base = path.resolve(__dirname, '..');
const { analyzeSourceFile } = require(path.join(base, 'out/src/repository/symbols.js'));
const { discoverRepository, detectMonorepo } = require(path.join(base, 'out/src/repository/discovery.js'));
const { DependencyGraphBuilder } = require(path.join(base, 'out/src/repository/graph.js'));
const { analyzeArchitecture } = require(path.join(base, 'out/src/project/architecture.js'));
const { analyzeKarkainProject } = require(path.join(base, 'out/src/project/karkain.js'));
const { architectureSummary } = require(path.join(base, 'out/src/repository/discovery.js'));
const { normalizeWorkspacePath } = require(path.join(base, 'out/src/workspace/analyze.js'));

const MIXED_ROOT = path.join(base, 'test', 'fixtures', 'mixed-monorepo');
const KARKAIN_ROOT = path.join(base, 'test', 'fixtures', 'karkain-project');

function walkFixture(root, transform) {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      files.push(transform(relative, absolute));
    }
  };
  walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function buildMixedView() {
  const files = walkFixture(MIXED_ROOT, (relative, absolute) => ({
    path: normalizeWorkspacePath(relative),
    content: fs.readFileSync(absolute, 'utf8'),
  }));
  const entries = files.map((file) => ({ path: file.path, size: file.content.length }));
  const configPaths = [
    'package.json',
    'pnpm-workspace.yaml',
    'turbo.json',
    'packages/web/package.json',
    'packages/shared/package.json',
    'services/api-java/pom.xml',
    'services/api-python/requirements.txt',
    'services/api-go/go.mod',
    'cpp/CMakeLists.txt',
  ];
  const configContents = {};
  for (const configPath of configPaths) {
    const entry = files.find((file) => file.path === configPath);
    if (entry !== undefined) {
      configContents[configPath] = entry.content;
    }
  }
  const overview = discoverRepository({ rootName: 'mixed-monorepo', entries, configContents });
  const monorepo = detectMonorepo(entries.map((entry) => entry.path), configContents);
  const builder = new DependencyGraphBuilder({ maxNodes: 500, maxEdges: 1_000 });
  for (const file of files) {
    builder.upsert(analyzeSourceFile(file.path, file.content));
  }
  const graph = builder.snapshot();
  const analyses = files.map((file) => analyzeSourceFile(file.path, file.content));
  const architecture = analyzeArchitecture(analyses, overview, graph, {});

  const dependents = new Map();
  const dependencies = new Map();
  for (const edge of graph.edges) {
    dependents.set(edge.to, (dependents.get(edge.to) ?? 0) + 1);
    dependencies.set(edge.from, (dependencies.get(edge.from) ?? 0) + 1);
  }
  const hotspots = (graph.nodes ?? [])
    .map((node) => ({
      path: node.path,
      dependents: dependents.get(node.path) ?? 0,
      dependencies: dependencies.get(node.path) ?? 0,
      publicApi: node.publicApi,
    }))
    .sort((left, right) => right.dependents - left.dependents || left.path.localeCompare(right.path))
    .slice(0, 8);

  return {
    overview,
    monorepo,
    architecture,
    graph,
    view: {
      overview,
      summary: architectureSummary(overview),
      architecture,
      dependencies: {
        nodeCount: graph.stats.nodeCount,
        edgeCount: graph.stats.edgeCount,
        heuristicEdges: graph.stats.heuristicEdges,
        unresolvedCount: graph.stats.unresolvedCount,
        cycleCount: graph.stats.cycleCount,
        truncated: graph.stats.truncated,
        hotspots,
        cycles: (graph.cycles ?? []).slice(0, 6),
        unresolved: (graph.unresolved ?? []).slice(0, 10),
      },
    },
  };
}

function buildKarkainView() {
  const files = walkFixture(KARKAIN_ROOT, (relative, absolute) => ({
    path: normalizeWorkspacePath(relative),
    content: fs.readFileSync(absolute, 'utf8'),
  })).filter((file) => file.path !== 'karkain.toml');
  const entries = files.map((file) => ({ path: file.path, size: file.content.length }));
  const result = analyzeKarkainProject({ rootName: 'karkain-project', entries, files });
  return {
    view: { summary: result.summary, graph: result.graph },
    summary: result.summary,
    graph: result.graph,
  };
}

function createDom() {
  const elements = new Map();
  function makeElement(tag) {
    const element = {
      tagName: String(tag).toUpperCase(),
      children: [],
      style: {},
      dataset: {},
      attributes: {},
      disabled: false,
      hidden: false,
      value: '',
      title: '',
      innerHTML: '',
      textContent: '',
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 800,
      append(...nodes) {
        for (const node of nodes) {
          if (node !== null && node !== undefined) {
            this.children.push(node);
          }
        }
      },
      appendChild(node) {
        this.children.push(node);
        return node;
      },
      replaceChildren(...nodes) {
        this.children = nodes.filter((node) => node !== null && node !== undefined);
      },
      before() {},
      after() {},
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : '';
      },
      removeAttribute(name) {
        delete this.attributes[name];
      },
      remove() {
        this.children = [];
      },
      focus() {},
      blur() {},
      click() {},
      addEventListener() {},
      removeEventListener() {},
      querySelector() {
        return makeElement('div');
      },
      querySelectorAll() {
        return [];
      },
      classList: {
        add() {},
        remove() {},
        toggle() {},
        contains() {
          return false;
        },
      },
    };
    return element;
  }
  const document = {
    createElement: (tag) => makeElement(tag),
    createDocumentFragment: () => makeElement('fragment'),
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, makeElement('div'));
      }
      return elements.get(id);
    },
    querySelector() {
      return makeElement('div');
    },
    querySelectorAll() {
      return [];
    },
    body: makeElement('body'),
    head: makeElement('head'),
    addEventListener() {},
    readyState: 'complete',
  };
  let messageHandler = undefined;
  const window = {
    document,
    addEventListener(type, handler) {
      if (type === 'message') {
        messageHandler = handler;
      }
    },
    removeEventListener() {},
    setTimeout: () => 1,
    clearTimeout() {},
    requestAnimationFrame: (callback) => callback(0),
  };
  window.window = window;
  const vscode = {
    postMessage: () => {},
    getState: () => ({}),
    setState: () => {},
  };
  const sandbox = {
    window,
    document,
    console,
    clearTimeout: () => {},
    setTimeout: () => 1,
    navigator: { clipboard: { writeText: async () => undefined } },
    getComputedStyle: () => ({}),
    scrollTo: () => {},
    acquireVsCodeApi: () => vscode,
  };
  sandbox.globalThis = sandbox;
  return { elements, document, sandbox, getMessageHandler: () => messageHandler };
}

function collectInnerHtml(element, out) {
  if (element === null || element === undefined) {
    return;
  }
  if (typeof element.innerHTML === 'string' && element.innerHTML.length > 0) {
    out.push(element.innerHTML);
  }
  for (const child of element.children ?? []) {
    collectInnerHtml(child, out);
  }
}

function main() {
  const mixed = buildMixedView();
  const karkain = buildKarkainView();
  const repository = { ...mixed.view, karkain: karkain.view };

  const source = fs.readFileSync(path.join(base, 'media', 'chat.js'), 'utf8');
  const dom = createDom();
  const sandbox = vm.createContext(dom.sandbox);
  vm.runInContext(source, sandbox, { filename: 'media/chat.js' });

  const handler = dom.getMessageHandler();
  if (typeof handler !== 'function') {
    throw new Error('chat.js did not register a window message handler');
  }
  handler({ data: { type: 'repository', repository } });
  handler({
    data: {
      type: 'gitSnapshot',
      snapshot: {
        root: 'F:\\demo',
        branch: 'main',
        headShort: 'a1b2c3d',
        remote: 'origin',
        staged: 1,
        modified: 2,
        untracked: 1,
        deleted: 0,
        conflicts: 0,
        clean: false,
        mergeInProgress: false,
        rebaseInProgress: false,
        entries: [
          { path: 'src/main.rs', state: 'staged' },
          { path: 'README.md', state: 'modified' },
        ],
        log: [
          { shortSha: 'a1b2c3d', subject: 'seed', author: 'Demo', date: '2026-11-10' },
        ],
        checkpoints: [
          { id: 'ckpt-1', taskId: 'task-1', fileCount: 2, createdAt: '2026-11-10T00:00:00Z', label: 'before edit' },
        ],
        github: { openIssues: 3, openPullRequests: 1, connected: true },
      },
    },
  });
  handler({
    data: {
      type: 'execution',
      execution: {
        id: 'exec-demo-1',
        kind: 'test',
        command: 'python -B -m unittest test_calculator.py -v',
        cwd: 'C:\\demo',
        state: 'finished',
        startedAt: new Date().toISOString(),
        status: 'succeeded',
        durationMs: 234,
        exitCode: 0,
        output: 'test_add ... ok\n\nRan 1 test in 0.000s\n\nOK',
        tests: { passed: 1, total: 1 },
        diagnostics: 0,
      },
    },
  });

  const htmlChunks = [];
  collectInnerHtml(dom.document.getElementById('messages'), htmlChunks);
  const html = htmlChunks.join('\n');

  const checks = [
    ['architecture heading', 'Architecture'],
    ['backend layer', 'backend'],
    ['frontend layer', 'frontend'],
    ['spring boot component path', 'UserController.java'],
    ['service component path', 'UserService.java'],
    ['react component path', 'Button.tsx'],
    ['uses relationship', 'uses'],
    ['framework mention', 'React'],
    ['karkain heading', 'Karkain project'],
    ['karkain entry module', 'main.kark'],
    ['karkain mathutils module', 'mathutils.kark'],
    ['karkain module import', 'Module imports'],
    ['karkain types section', 'Types'],
    ['monorepo detection', 'Monorepo:'],
    ['git snapshot heading', 'Git status'],
    ['git branch shown', 'Branch:'],
    ['git recent commits', 'Recent commits'],
    ['git checkpoint section', 'Checkpoints'],
    ['git github counts', '3 open issue(s)'],
    ['execution heading', 'Execution · test'],
    ['execution passed badge', 'Passed'],
    ['execution command', 'python -B -m unittest'],
    ['execution tests count', '1 passed'],
    ['execution output', 'Ran 1 test'],
  ];
  const results = checks.map(([label, needle]) => [label, html.includes(needle)]);
  const failed = results.filter(([, ok]) => !ok);

  console.log('=== Architecture snapshot (from real workspace files) ===');
  console.log(`  layers: ${mixed.architecture.layers.map((layer) => `${layer.layer}=${layer.components}`).join(', ')}`);
  console.log(`  components: ${mixed.architecture.components.length}`);
  console.log(`  relationships: ${mixed.architecture.relationships.length}`);
  console.log(`  frameworks: ${mixed.architecture.frameworks.map((framework) => `${framework.name}(${framework.layer})`).join(', ')}`);
  console.log(`  monorepo: ${mixed.monorepo.isMonorepo} (packages: ${mixed.monorepo.packages.join(', ')})`);
  console.log(`  backend: ${mixed.architecture.backend.length} files, frontend: ${mixed.architecture.frontend.length} files, shared: ${mixed.architecture.shared.length} files`);
  console.log('=== Karkain snapshot ===');
  console.log(`  modules: ${karkain.summary.moduleCount}, edges: ${karkain.graph.edges.length}, entry: ${karkain.graph.root}`);
  console.log(`  types: ${karkain.summary.types.map((type) => `${type.name}(${type.kind})`).join(', ')}`);
  console.log('=== Webview render checks ===');
  for (const [label, ok] of results) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  }

  if (failed.length > 0) {
    console.error(`\n${failed.length} webview render check(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log('\nAll webview render checks passed.');
}

main();
