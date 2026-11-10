import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'verify-docs-links.mjs');
const tempRoots: string[] = [];

interface Result {
  readonly exitCode: number;
  readonly output: string;
}

function run(root: string): Result {
  try {
    const output = execFileSync(process.execPath, [SCRIPT, root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof err.status === 'number' ? err.status : 1,
      output: `${err.stdout ?? ''}${err.stderr ?? ''}`,
    };
  }
}

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quantsmind-docs-links-'));
  tempRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

suiteTeardown(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

suite('docs-links checker', () => {
  test('passes when every relative link, image and anchor resolves', () => {
    const root = fixture({
      'README.md': '[Guide](docs/guide.md)\n\n![Logo](media/logo.svg)\n\n[Section](docs/guide.md#getting-started)\n',
      'docs/guide.md': '# Getting started\n\n[Home](../README.md)\n',
      'media/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
    });

    const result = run(root);

    expect(result.exitCode).to.equal(0);
    expect(result.output).to.contain('Markdown files scanned: 2');
    expect(result.output).to.contain('Links checked');
  });

  test('reports a missing relative file target with file and line', () => {
    const root = fixture({
      'README.md': '# Title\n\nSee [Missing](docs/not-here.md) for details.\n',
    });

    const result = run(root);

    expect(result.exitCode).to.equal(1);
    expect(result.output).to.contain('README.md:3');
    expect(result.output).to.contain('docs/not-here.md');
    expect(result.output).to.contain('file does not exist');
  });

  test('reports a missing image reference', () => {
    const root = fixture({
      'README.md': '![Broken](media/missing.png)\n',
    });

    const result = run(root);

    expect(result.exitCode).to.equal(1);
    expect(result.output).to.contain('README.md:1');
    expect(result.output).to.contain('media/missing.png');
  });

  test('accepts a valid same-file anchor and rejects a missing one', () => {
    const good = fixture({ 'guide.md': '# Setup\n\n[jump](#setup)\n' });
    const bad = fixture({ 'guide.md': '# Setup\n\n[jump](#not-here)\n' });

    expect(run(good).exitCode).to.equal(0);
    const badResult = run(bad);
    expect(badResult.exitCode).to.equal(1);
    expect(badResult.output).to.contain('missing anchor #not-here');
  });

  test('validates anchors inside linked Markdown files', () => {
    const good = fixture({
      'README.md': '[Guide](docs/guide.md#step-1)\n',
      'docs/guide.md': '# Install\n\n## Step 1\n',
    });
    const bad = fixture({
      'README.md': '[Guide](docs/guide.md#step-2)\n',
      'docs/guide.md': '# Install\n\n## Step 1\n',
    });

    expect(run(good).exitCode).to.equal(0);

    const badResult = run(bad);
    expect(badResult.exitCode).to.equal(1);
    expect(badResult.output).to.contain('missing anchor #step-2');
  });

  test('accepts GitHub-style anchors with duplicates numbered', () => {
    const root = fixture({
      'README.md': '[One](docs/guide.md#setup)\n[Two](docs/guide.md#setup-1)\n',
      'docs/guide.md': '# Setup\n\ntext\n\n# Setup\n',
    });

    expect(run(root).exitCode).to.equal(0);
  });

  test('resolves URL-encoded paths and directory targets', () => {
    const root = fixture({
      'README.md': '[Space](docs/my%20file.md)\n[Dir](docs)\n',
      'docs/my file.md': '# Spaces\n',
      'docs/index.md': '# Directory index\n',
    });

    expect(run(root).exitCode).to.equal(0);
  });

  test('does not fetch external links and never fails on them', () => {
    const root = fixture({
      'README.md': '[External](https://example.invalid/not-real)\n[Mail](mailto:a@b.c)\n',
    });

    const result = run(root);

    expect(result.exitCode).to.equal(0);
    expect(result.output).to.contain('External links (not fetched): 2');
  });

  test('ignores links inside fenced code blocks and inline code spans', () => {
    const root = fixture({
      'README.md': '# Real\n\n```\n[fake](docs/not-here.md)\n```\n\n`[fake](also-missing.md)`\n',
    });

    expect(run(root).exitCode).to.equal(0);
  });

  test('undefined reference-style links are reported', () => {
    const root = fixture({
      'README.md': 'See [the guide][guide] for more.\n',
    });

    const result = run(root);

    expect(result.exitCode).to.equal(1);
    expect(result.output).to.contain('undefined reference link');
  });

  test('defined reference-style links are validated', () => {
    const root = fixture({
      'README.md': 'See [the guide][guide].\n\n[guide]: docs/guide.md\n',
      'docs/guide.md': '# Guide\n',
    });

    expect(run(root).exitCode).to.equal(0);
  });

  test('footnote references are not treated as links', () => {
    const root = fixture({
      'README.md': 'Text with a footnote[^1].\n\n[^1]: a footnote, not a link\n',
    });

    expect(run(root).exitCode).to.equal(0);
  });

  test('flags stale ajit-ai organization URLs', () => {
    const root = fixture({
      'README.md': '<https://github.com/ajit-ai/QuantsMind-VSCode-AI-Coder/issues>\n',
    });

    const result = run(root);

    expect(result.exitCode).to.equal(1);
    expect(result.output).to.contain('stale organization');
    expect(result.output).to.contain('Quantsmind');
  });

  test('fails when a required documentation file is missing from a repository root', () => {
    const root = fixture({
      'package.json': '{ "name": "fixture" }\n',
      'README.md': '# Fixture\n',
      'docs/AGENT_WORKFLOW.md': '# Agent workflow\n',
      'docs/PROJECT_INTELLIGENCE.md': '# Project intelligence\n',
    });

    const result = run(root);

    expect(result.exitCode).to.equal(1);
    expect(result.output).to.contain('docs/COMMAND_EXECUTION.md');
    expect(result.output).to.contain('required documentation file is missing');
  });

  test('passes when the repository root contains all required documentation', () => {
    const root = fixture({
      'package.json': '{ "name": "fixture" }\n',
      'README.md': '# Fixture\n',
      'docs/AGENT_WORKFLOW.md': '# Agent workflow\n',
      'docs/COMMAND_EXECUTION.md': '# Command execution\n',
      'docs/PROJECT_INTELLIGENCE.md': '# Project intelligence\n',
    });

    expect(run(root).exitCode).to.equal(0);
  });
});

suite('documentation CI wiring', () => {
  const repoRoot = path.join(__dirname, '..', '..', '..');

  test('the CI quality job runs the documentation link check', () => {
    const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

    expect(workflow).to.contain('Verify documentation links');
    expect(workflow).to.contain('npm run verify:docs-links');
  });

  test('package.json defines the verify:docs-links script', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts['verify:docs-links']).to.equal('node scripts/verify-docs-links.mjs');
  });

  test('the checker enforces the required documentation set on the repository root', () => {
    const checker = fs.readFileSync(path.join(repoRoot, 'scripts', 'lib', 'docs-links.mjs'), 'utf8');

    for (const required of ['docs/AGENT_WORKFLOW.md', 'docs/COMMAND_EXECUTION.md', 'docs/PROJECT_INTELLIGENCE.md']) {
      expect(checker).to.contain(required);
    }
  });
});
