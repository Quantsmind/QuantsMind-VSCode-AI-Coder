import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const vsixPath = resolve(process.argv[2] ?? 'quantsmind-vscode-ai-coder-0.3.0.vsix');
const expected = 'quantsmind.quantsmind-vscode-ai-coder@0.3.0';

function cliFromInstallationRoot(root) {
  const scripts = [
    join(root, 'resources', 'app', 'out', 'cli.js'),
    join(root, 'Contents', 'Resources', 'app', 'out', 'cli.js'),
    join(root, 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'out', 'cli.js'),
    join(root, 'Visual Studio Code - Insiders.app', 'Contents', 'Resources', 'app', 'out', 'cli.js'),
  ];

  for (const script of scripts) {
    if (!existsSync(script)) {
      continue;
    }

    const electronCandidates = [];
    const resourcesSegment = join('Contents', 'Resources');
    if (script.includes(resourcesSegment)) {
      const bundleRoot = script.slice(0, script.indexOf(resourcesSegment) - 1);
      electronCandidates.push(
        join(bundleRoot, 'Contents', 'MacOS', 'Electron'),
        join(bundleRoot, 'Contents', 'MacOS', 'Code'),
      );
    } else {
      electronCandidates.push(
        join(root, 'Code.exe'),
        join(root, 'Code - Insiders.exe'),
        join(root, 'code'),
        join(root, 'code-insiders'),
      );
    }

    const electron = electronCandidates.find((candidate) => existsSync(candidate));
    if (electron !== undefined) {
      return { electron, script };
    }
  }

  return undefined;
}

function candidateRoots(source) {
  const roots = [];
  const push = (value) => {
    if (value !== undefined && !roots.includes(value)) {
      roots.push(value);
    }
  };

  let current = resolve(source);
  try {
    if (!statSync(current).isDirectory()) {
      current = dirname(current);
    }
  } catch {
    current = dirname(current);
  }

  // A launcher such as <root>/bin/code.cmd needs two hops; macOS bundles need
  // three (Contents/MacOS/Electron -> .app). Walk up rather than special-casing.
  for (let depth = 0; depth < 5 && current !== dirname(current); depth += 1) {
    push(current);
    current = dirname(current);
  }

  return roots;
}

function findVsCodeCli() {
  const sources = [];
  if (process.env.VSCODE_EXECUTABLE) {
    sources.push(process.env.VSCODE_EXECUTABLE);
  }
  if (process.platform === 'win32') {
    sources.push('C:\\Program Files\\Microsoft VS Code');
    sources.push('C:\\Program Files (x86)\\Microsoft VS Code');
  }

  const base = resolve('.vscode-test');
  if (existsSync(base)) {
    for (const entry of readdirSync(base)) {
      if (entry.startsWith('vscode-')) {
        sources.push(join(base, entry));
      }
    }
  }

  for (const source of sources) {
    if (!existsSync(source)) {
      continue;
    }
    for (const root of candidateRoots(source)) {
      const cli = cliFromInstallationRoot(root);
      if (cli !== undefined) {
        return cli;
      }
    }
  }

  return undefined;
}

function runCli(cli, args) {
  // Mirrors VS Code's own bin/code launcher: run the Electron binary as Node
  // against resources/app/out/cli.js so no GUI/window is created. Launching
  // Code.exe directly starts the full desktop app and never returns.
  return execFileSync(cli.electron, [cli.script, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      VSCODE_DEV: '',
    },
  });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function cleanup(path) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch (error) {
      if (attempt === 5) {
        console.warn(
          `Could not remove temporary directory ${path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
      sleep(500);
    }
  }
}

if (!existsSync(vsixPath)) {
  console.error(`Missing VSIX: ${vsixPath}`);
  process.exit(1);
}

const cli = findVsCodeCli();
if (cli === undefined) {
  console.log('SKIP: no VS Code installation found. Set VSCODE_EXECUTABLE to run install verification.');
  process.exit(0);
}

const tempRoot = mkdtempSync(join(tmpdir(), 'quantsmind-install-'));
const extensionsDir = join(tempRoot, 'extensions');
const userDataDir = join(tempRoot, 'user-data');

console.log(`VS Code: ${cli.electron}`);
console.log(`VSIX: ${vsixPath}`);
console.log(`Isolated extensions: ${extensionsDir}`);

let exitCode = 0;
try {
  runCli(cli, [
    '--extensions-dir',
    extensionsDir,
    '--user-data-dir',
    userDataDir,
    '--install-extension',
    vsixPath,
    '--force',
  ]);
  console.log('Installed the VSIX into an empty extensions directory.');

  const listed = runCli(cli, [
    '--extensions-dir',
    extensionsDir,
    '--user-data-dir',
    userDataDir,
    '--list-extensions',
    '--show-versions',
  ]);
  const ids = listed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (!ids.includes(expected)) {
    console.error(`Expected ${expected} in the isolated extension list.`);
    console.error(listed);
    exitCode = 1;
  } else {
    console.log(`Verified installed extension: ${expected}`);
  }
} catch (error) {
  console.error('Install verification failed.');
  console.error(error instanceof Error ? error.message : error);
  if (error instanceof Error && 'stdout' in error && error.stdout) {
    console.error(String(error.stdout));
  }
  if (error instanceof Error && 'stderr' in error && error.stderr) {
    console.error(String(error.stderr));
  }
  exitCode = 1;
} finally {
  cleanup(tempRoot);
}

process.exit(exitCode);
