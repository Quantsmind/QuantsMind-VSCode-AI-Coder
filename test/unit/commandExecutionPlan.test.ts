import { expect } from 'chai';
import * as path from 'node:path';

const win32 = path.win32;
import {
  canonicalWindowsShell,
  planCommand,
  resolveOnPath,
} from '../../src/commands/executionPlan';

const SYSTEM_ROOT = 'C:\\WINDOWS';
const SHELL = win32.join(SYSTEM_ROOT, 'System32', 'cmd.exe');
const NODE_DIR = 'C:\\Program Files\\nodejs';
const NODE_EXE = win32.join(NODE_DIR, 'node.exe');
const NPM_CMD = win32.join(NODE_DIR, 'npm.cmd');
const NPM_CLI = win32.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js');
const TOOLS_DIR = 'C:\\build\\tools';
const GRADLEW = win32.join(TOOLS_DIR, 'gradlew.cmd');
const WORKSPACE = 'F:\\Codes\\demo';

/** Separator- and case-insensitive so the same expectations hold on any host. */
function key(value: string): string {
  return value.replace(/[\\/]+/g, '/').toLowerCase();
}

function filesIn(files: readonly string[]): (candidate: string) => boolean {
  const set = new Set(files.map(key));
  return (candidate: string) => set.has(key(candidate));
}

function windowsEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PATH: `${NODE_DIR};${TOOLS_DIR}`,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    SystemRoot: SYSTEM_ROOT,
    ComSpec: 'F:\\workspace\\evil-shell.exe',
    ...extra,
  };
}

function quoted(value: string): string {
  return `"${value}"`;
}

function windowsPlan(tokens: readonly string[], options: {
  files?: readonly string[];
  env?: Record<string, string | undefined>;
}) {
  return planCommand({
    tokens,
    platform: 'win32',
    env: options.env ?? windowsEnv(),
    exists: filesIn(options.files ?? [SHELL, NODE_EXE, NPM_CMD, NPM_CLI, GRADLEW]),
  });
}

suite('execution planning', () => {
  test('a binary runs by absolute path with the remaining tokens as argv', () => {
    const plan = windowsPlan(['node', '-p', '1+1'], {});
    expect(plan.ok).to.equal(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.plan.mode).to.equal('direct');
    expect(key(plan.plan.file)).to.equal(key(NODE_EXE));
    expect([...plan.plan.args]).to.deep.equal(['-p', '1+1']);
    expect(plan.plan.verbatimArguments).to.equal(false);
  });

  test('a package-manager batch wrapper runs through node on its real entry point', () => {
    const plan = windowsPlan(['npm', 'run', 'compile'], {});
    expect(plan.ok).to.equal(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.plan.mode).to.equal('node-entry');
    expect(key(plan.plan.file)).to.equal(key(NODE_EXE));
    expect([...plan.plan.args]).to.deep.equal([NPM_CLI, 'run', 'compile']);
    expect(plan.plan.verbatimArguments).to.equal(false);
  });

  test('an unmapped batch wrapper is quoted per value and never passed as one string', () => {
    const plan = windowsPlan(['gradlew', 'test'], {});
    expect(plan.ok).to.equal(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.plan.mode).to.equal('batch-wrapped');
    expect(key(plan.plan.file)).to.equal(key(SHELL));
    expect([...plan.plan.args].slice(0, 3)).to.deep.equal(['/d', '/s', '/c']);
    expect(key(plan.plan.args[3])).to.equal(key(`"${quoted(GRADLEW)} ${quoted('test')}"`));
    expect(plan.plan.verbatimArguments).to.equal(true);
  });

  test('the batch payload keeps spaces inside one quoted argument', () => {
    const plan = windowsPlan(['gradlew', 'test windows'], {});
    expect(plan.ok).to.equal(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.plan.args[3]).to.contain('"test windows"');
    expect(plan.plan.args[3].startsWith('""')).to.equal(true);
    expect(plan.plan.args[3].endsWith('"')).to.equal(true);
  });

  test('a redirected ComSpec is ignored in favour of the SystemRoot shell', () => {
    const plan = windowsPlan(['gradlew', 'test'], { env: windowsEnv({ ComSpec: `${WORKSPACE}\\evil-shell.exe` }) });
    expect(plan.ok).to.equal(true);
    if (!plan.ok) {
      return;
    }
    expect(key(plan.plan.file)).to.equal(key(SHELL));
    expect(plan.plan.file).to.not.contain('evil-shell');
  });

  test('PATH folders are the only search scope, never the working directory', () => {
    const exists = filesIn([`${WORKSPACE}\\node.exe`, SHELL]);
    expect(resolveOnPath('node', { PATH: NODE_DIR, PATHEXT: '.EXE' }, exists, 'win32')).to.equal(undefined);
    const plan = planCommand({
      tokens: ['node', '-v'],
      platform: 'win32',
      env: windowsEnv({ PATH: `${WORKSPACE}\\node.exe` }),
      exists,
    });
    expect(plan.ok).to.equal(false);
    if (plan.ok) {
      return;
    }
    expect(plan.reason).to.contain('PATH folders');
  });

  test('a value cmd would re-expand stops a batch command instead of degrading it', () => {
    for (const argument of ['%PATH%', 'a"b', 'x^y', 'C:\\']) {
      const plan = windowsPlan(['gradlew', 'run', argument], {});
      expect(plan.ok, argument).to.equal(false);
      if (plan.ok) {
        continue;
      }
      expect(plan.reason, argument).to.contain('without shell interpretation');
    }
  });

  test('the mapped node entry needs no cmd-safe arguments', () => {
    const plan = windowsPlan(['npm', 'run', 'a%b'], {});
    expect(plan.ok).to.equal(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.plan.mode).to.equal('node-entry');
    expect([...plan.plan.args]).to.deep.equal([NPM_CLI, 'run', 'a%b']);
  });

  test('a wrapper without its node entry falls back to the batch plan', () => {
    const plan = windowsPlan(['npm', 'test'], { files: [SHELL, NODE_EXE, NPM_CMD] });
    expect(plan.ok).to.equal(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.plan.mode).to.equal('batch-wrapped');
    expect(key(plan.plan.file)).to.equal(key(SHELL));
  });

  test('an executable that is not a bare command name is refused', () => {
    for (const name of ['../node', 'C:\\x\\node.exe', 'no"de', '%PATH%', 'node;rm', '']) {
      const plan = windowsPlan([name, '-v'], {});
      expect(plan.ok, name).to.equal(false);
    }
  });

  test('an empty argument is refused', () => {
    const plan = windowsPlan(['npm', '', 'test'], {});
    expect(plan.ok).to.equal(false);
    if (plan.ok) {
      return;
    }
    expect(plan.reason).to.contain('empty argument');
  });

  test('an executable with no runnable form is refused', () => {
    const plan = windowsPlan(['eslint', '--version'], {
      files: [win32.join(TOOLS_DIR, 'eslint.ps1'), SHELL, NODE_EXE],
      env: windowsEnv({ PATHEXT: '.PS1;.EXE;.CMD' }),
    });
    expect(plan.ok).to.equal(false);
    if (plan.ok) {
      return;
    }
    expect(plan.reason).to.contain('neither a binary nor a batch wrapper');
  });

  test('PATHEXT order decides between an exe and a cmd of the same name', () => {
    const both = [SHELL, NODE_EXE, win32.join(TOOLS_DIR, 'tool.exe'), win32.join(TOOLS_DIR, 'tool.cmd')];
    const plan = windowsPlan(['tool', '--version'], { files: both });
    expect(plan.ok).to.equal(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.plan.mode).to.equal('direct');
    expect(key(plan.plan.file)).to.equal(key(win32.join(TOOLS_DIR, 'tool.exe')));
  });

  test('a missing SystemRoot shell stops a batch command', () => {
    const withoutRoot = windowsPlan(['gradlew', 'test'], { env: windowsEnv({ SystemRoot: undefined, WINDIR: undefined }) });
    expect(withoutRoot.ok).to.equal(false);
    if (withoutRoot.ok) {
      return;
    }
    expect(withoutRoot.reason).to.contain('SystemRoot');

    const missingShell = windowsPlan(['gradlew', 'test'], { files: [NODE_EXE, NPM_CMD, GRADLEW] });
    expect(missingShell.ok).to.equal(false);
    if (missingShell.ok) {
      return;
    }
    expect(missingShell.reason).to.contain('cmd.exe was not found');
  });

  test('the canonical shell needs a plain path under SystemRoot', () => {
    expect(canonicalWindowsShell(windowsEnv(), filesIn([SHELL]))).to.equal(SHELL);
    expect(canonicalWindowsShell({ SystemRoot: undefined }, filesIn([SHELL]))).to.equal(undefined);
    expect(canonicalWindowsShell(windowsEnv(), filesIn([]))).to.equal(undefined);
    const spacedRoot = 'C:\\Program Files\\Windows';
    expect(
      canonicalWindowsShell({ SystemRoot: spacedRoot }, filesIn([win32.join(spacedRoot, 'System32', 'cmd.exe')])),
    ).to.equal(undefined);
  });

  test('posix keeps the bare name and passes every argument through untouched', () => {
    const plan = planCommand({
      tokens: ['npm', 'run', 'a%b'],
      platform: 'linux',
      env: { PATH: '/usr/local/bin' },
      exists: () => false,
    });
    expect(plan.ok).to.equal(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.plan.mode).to.equal('direct');
    expect(plan.plan.file).to.equal('npm');
    expect([...plan.plan.args]).to.deep.equal(['run', 'a%b']);
  });
});
