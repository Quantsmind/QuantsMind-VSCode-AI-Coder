/**
 * Guard for the release chain: version numbers must come from package.json, never
 * from literals baked into tooling, source or tests. A literal is what makes a
 * version bump break verification silently, so this fails the chain instead.
 *
 * Historical version mentions (CHANGELOG.md, docs/, the migration fixtures that
 * talk about "pre-0.3.4 records") are deliberately not scanned.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, version as projectVersion } from './project-meta.mjs';

const scanRoots = ['scripts', 'src', 'media', 'test'];
const scanFiles = ['package.json', '.vscode-test.packaged.mjs', '.vscode-test.mjs'];
const skipDirs = new Set(['node_modules', 'out', 'dist', 'coverage', '.vscode-test', '.tmp']);
const extensions = ['.mjs', '.js', '.ts', '.json'];

const offenders = [
  {
    name: 'artefact filename with an embedded version',
    pattern: /quantsmind-vscode-ai-coder-\d+\.\d+\.\d+\.vsix/,
  },
  {
    name: 'extension id pinned to a version',
    pattern: /quantsmind\.quantsmind-vscode-ai-coder@\d+\.\d+\.\d+/,
  },
  {
    name: 'vsix identity version literal',
    pattern: /<Identity[^>]*Version="\d+\.\d+\.\d+"/,
  },
  {
    // Scoped to the shipped version on purpose: test fixtures use invented
    // versions like 9.9.9 and must not trip the guard.
    name: 'user-agent pinned to the current version',
    pattern: new RegExp(`QuantsMind-VSCode-AI-Coder/${projectVersion.replace(/\./g, '\\.')}`),
  },
];

function* walk(directory) {
  for (const entry of readdirSync(directory)) {
    if (skipDirs.has(entry)) {
      continue;
    }
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
    } else if (extensions.some((extension) => entry.endsWith(extension))) {
      yield path;
    }
  }
}

const targets = [
  ...scanFiles.map((file) => join(projectRoot, file)).filter((file) => isFile(file)),
  ...scanRoots
    .filter((root) => isDirectory(join(projectRoot, root)))
    .flatMap((root) => [...walk(join(projectRoot, root))]),
];

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

let failures = 0;
for (const path of targets) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const offender of offenders) {
      if (offender.pattern.test(line)) {
        failures += 1;
        console.log(
          `  FAIL ${offender.name}: ${path.slice(projectRoot.length + 1)}:${index + 1}  ${line.trim()}`,
        );
      }
    }
  });
}

if (failures > 0) {
  console.error(`\n${failures} hardcoded version literal(s) found. Read them from package.json.`);
  process.exit(1);
}

console.log(`Release literal check passed across ${targets.length} files.`);
