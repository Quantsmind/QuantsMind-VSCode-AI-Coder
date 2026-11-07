import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * How one allowlisted command becomes a spawn request. Every mode hands
 * `child_process.spawn` an executable plus an argument vector; none of them
 * hands a free-form command string to a shell.
 *
 * - `direct`: an absolute `.exe`/`.com` path with the remaining tokens as argv.
 * - `node-entry`: a known package-manager batch wrapper replaced by the Node
 *   entry point it exists to launch, so `node.exe` runs it without cmd.
 * - `batch-wrapped`: the last resort for a `.cmd`/`.bat` we cannot map. cmd.exe
 *   is invoked with `/d /s /c` and a command line this module builds itself,
 *   with every value quoted and every character cmd could re-interpret
 *   rejected, so nothing in the line can chain, redirect or expand.
 */
export type ExecutionMode = 'direct' | 'node-entry' | 'batch-wrapped';

export interface ExecutionPlan {
  readonly mode: ExecutionMode;
  readonly file: string;
  readonly args: readonly string[];
  readonly verbatimArguments: boolean;
}

export type PlanResult =
  | { readonly ok: true; readonly plan: ExecutionPlan; readonly detail: string }
  | { readonly ok: false; readonly reason: string };

export interface PlanInputs {
  readonly tokens: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly exists?: (candidate: string) => boolean;
}

const EXECUTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const BINARY_SUFFIXES = new Set(['.exe', '.com']);
const BATCH_SUFFIXES = new Set(['.cmd', '.bat']);
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * cmd.exe expands `%VAR%` inside double quotes, `!` expands under delayed
 * expansion, and `"` ends the quoting early, so a value containing any of them
 * has no safe batch-wrapped representation.
 */
const CMD_UNSAFE = /["%!^]/;

/** Batch wrappers whose only job is to start Node on a known script. */
const PACKAGE_JS_ENTRIES: Readonly<Record<string, readonly string[]>> = {
  npm: ['node_modules', 'npm', 'bin', 'npm-cli.js'],
  npx: ['node_modules', 'npm', 'bin', 'npx-cli.js'],
  pnpm: ['node_modules', 'pnpm', 'bin', 'pnpm.cjs'],
  yarn: ['node_modules', 'yarn', 'bin', 'yarn.js'],
};

function environmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key.toUpperCase() === name) {
      return value;
    }
  }
  return undefined;
}

function pathDirectories(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string[] {
  const raw = environmentValue(env, 'PATH') ?? '';
  const separator = platform === 'win32' ? ';' : ':';
  return raw
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.includes('"'));
}

function extensionOrder(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== 'win32') {
    return [''];
  }
  const configured = (environmentValue(env, 'PATHEXT') ?? DEFAULT_PATHEXT)
    .split(';')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.startsWith('.'));
  return [...configured, ''];
}

/**
 * Resolves a bare command name against the PATH folders only. The working
 * directory is never a candidate, which is what a workspace cannot influence.
 */
export function resolveOnPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  exists: (candidate: string) => boolean,
  platform: NodeJS.Platform,
): string | undefined {
  for (const directory of pathDirectories(env, platform)) {
    for (const extension of extensionOrder(env, platform)) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function directPlan(file: string, args: readonly string[]): PlanResult {
  return {
    ok: true,
    plan: { mode: 'direct', file, args, verbatimArguments: false },
    detail: `direct ${path.basename(file)}`,
  };
}

/**
 * The only cmd.exe this module will use or hand to a child process: the copy
 * under SystemRoot. `ComSpec` is deliberately ignored, because that variable is
 * a pointer a caller could redirect.
 */
export function canonicalWindowsShell(
  env: Readonly<Record<string, string | undefined>> = process.env,
  exists: (candidate: string) => boolean = (candidate) => fs.existsSync(candidate),
): string | undefined {
  const root = environmentValue(env, 'SYSTEMROOT') ?? environmentValue(env, 'WINDIR');
  if (root === undefined || root.length === 0) {
    return undefined;
  }
  const candidate = path.join(root, 'System32', 'cmd.exe');
  if (!exists(candidate) || /[\s"%!^]/.test(candidate)) {
    return undefined;
  }
  return candidate;
}

function systemShell(
  env: Readonly<Record<string, string | undefined>>,
  exists: (candidate: string) => boolean,
): { readonly file: string } | { readonly reason: string } {
  const file = canonicalWindowsShell(env, exists);
  if (file === undefined) {
    return {
      reason:
        'cmd.exe was not found as a plain path under SystemRoot, so batch-file commands ' +
        'cannot be run without shell interpretation.',
    };
  }
  return { file };
}

function batchWrapped(
  script: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  exists: (candidate: string) => boolean,
): PlanResult {
  for (const value of [script, ...args]) {
    if (CMD_UNSAFE.test(value)) {
      return {
        ok: false,
        reason:
          `"${value}" contains a character cmd.exe re-interprets, so this batch command ` +
          'cannot be run without shell interpretation.',
      };
    }
    if (value.endsWith('\\')) {
      return {
        ok: false,
        reason:
          `"${value}" ends with a backslash, which cmd.exe would fuse into the following quote, ` +
          'so the command cannot be run without shell interpretation.',
      };
    }
  }

  const shell = systemShell(env, exists);
  if ('reason' in shell) {
    return { ok: false, reason: shell.reason };
  }

  const line = [script, ...args].map((value) => `"${value}"`).join(' ');
  return {
    ok: true,
    plan: {
      mode: 'batch-wrapped',
      file: shell.file,
      args: ['/d', '/s', '/c', `"${line}"`],
      verbatimArguments: true,
    },
    detail: `batch-wrapped ${path.basename(script)}`,
  };
}

function nodeEntryPlan(
  name: string,
  wrapper: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  exists: (candidate: string) => boolean,
  platform: NodeJS.Platform,
): PlanResult | undefined {
  const segments = PACKAGE_JS_ENTRIES[name.toLowerCase()];
  if (segments === undefined) {
    return undefined;
  }
  const script = path.resolve(path.dirname(wrapper), ...segments);
  if (!exists(script)) {
    return undefined;
  }
  const node = resolveOnPath('node', env, exists, platform);
  if (node === undefined || !BINARY_SUFFIXES.has(path.extname(node).toLowerCase())) {
    return undefined;
  }
  return {
    ok: true,
    plan: {
      mode: 'node-entry',
      file: node,
      args: [script, ...args],
      verbatimArguments: false,
    },
    detail: `node-entry ${path.basename(script)}`,
  };
}

/**
 * Turns the tokens of an already allowlisted command into a spawn request.
 * Executable, arguments, shell availability and the platform are considered
 * independently, and a command with no shell-free representation is rejected
 * with the reason instead of being degraded to an unsafe invocation.
 */
export function planCommand(input: PlanInputs): PlanResult {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const exists = input.exists ?? ((candidate: string) => fs.existsSync(candidate));
  const tokens = input.tokens;
  const name = tokens[0] ?? '';
  const args = tokens.slice(1);

  if (tokens.length === 0 || name.length === 0) {
    return { ok: false, reason: 'The command names no executable.' };
  }
  if (!EXECUTABLE_NAME.test(name)) {
    return {
      ok: false,
      reason: 'The executable must be a bare command name without separators, quotes or expansions.',
    };
  }
  for (const argument of args) {
    if (argument.length === 0) {
      return { ok: false, reason: 'The command contains an empty argument.' };
    }
  }

  if (platform !== 'win32') {
    return directPlan(name, args);
  }

  const resolved = resolveOnPath(name, env, exists, platform);
  if (resolved === undefined) {
    return {
      ok: false,
      reason: `Nothing named "${name}" was found in the PATH folders, so it cannot be run by absolute path.`,
    };
  }

  const suffix = path.extname(resolved).toLowerCase();
  if (BINARY_SUFFIXES.has(suffix)) {
    return directPlan(resolved, args);
  }
  if (BATCH_SUFFIXES.has(suffix)) {
    return (
      nodeEntryPlan(name, resolved, args, env, exists, platform) ??
      batchWrapped(resolved, args, env, exists)
    );
  }
  return {
    ok: false,
    reason: `"${path.basename(resolved)}" is neither a binary nor a batch wrapper, ` +
      'so it cannot be run without shell interpretation.',
  };
}
