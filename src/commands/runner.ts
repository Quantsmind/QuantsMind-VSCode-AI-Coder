import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { redactSecrets } from '../security/redact';
import { canonicalWindowsShell, planCommand } from './executionPlan';

export const MAX_COMMAND_LENGTH = 200;
export const MAX_COMMAND_OUTPUT = 120_000;

const SHELL_METACHARACTERS = /[;&|<>`$\n\r]/;

export interface CommandRunOptions {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly allowlist: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputChars?: number;
  readonly secret?: string;
  readonly signal?: AbortSignal;
  readonly trusted?: boolean;
}

export interface CommandValidation {
  readonly ok: boolean;
  readonly normalized?: string;
  readonly tokens?: readonly string[];
  readonly reason?: string;
}

export interface CommandResult {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly output: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly error?: string;
}

/**
 * Splits an allowlisted command into arguments without invoking a shell.
 * Quotes group arguments; every shell metacharacter is rejected outright.
 */
export function tokenizeCommand(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let hasContent = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else if (character === '\\' && quote === '"' && index + 1 < command.length) {
        index += 1;
        current += command[index];
      } else {
        current += character;
      }
      hasContent = true;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      hasContent = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (hasContent) {
        tokens.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }
    if (character === '\\') {
      if (index + 1 < command.length) {
        index += 1;
        current += command[index];
        hasContent = true;
      }
      continue;
    }
    current += character;
    hasContent = true;
  }

  if (quote !== undefined) {
    return undefined;
  }
  if (hasContent) {
    tokens.push(current);
  }
  return tokens.filter((token) => token.length > 0);
}

export function validateCommand(
  raw: string,
  allowlist: readonly string[],
): CommandValidation {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'The command must be text.' };
  }
  const normalized = raw.trim().replace(/\s+/g, ' ');
  if (normalized.length === 0) {
    return { ok: false, reason: 'The command is empty.' };
  }
  if (normalized.length > MAX_COMMAND_LENGTH) {
    return { ok: false, reason: 'The command is too long.' };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    return { ok: false, reason: 'The command contains control characters.' };
  }
  if (SHELL_METACHARACTERS.test(normalized)) {
    return {
      ok: false,
      reason: 'Shell metacharacters are not permitted in validation commands.',
    };
  }
  if (!allowlist.includes(normalized)) {
    return {
      ok: false,
      reason: 'The command is not in the configured validation allowlist.',
    };
  }
  const tokens = tokenizeCommand(normalized);
  if (tokens === undefined || tokens.length === 0) {
    return { ok: false, reason: 'The command could not be parsed safely.' };
  }
  const firstField = normalized.split(/\s+/)[0] ?? '';
  if (
    firstField.includes('/') ||
    firstField.includes('\\') ||
    firstField.includes(':') ||
    tokens[0].includes('/') ||
    tokens[0].includes('\\')
  ) {
    return { ok: false, reason: 'The executable must be a bare command name.' };
  }
  return { ok: true, normalized, tokens };
}

export function isWithinWorkspace(cwd: string, workspaceRoot: string): boolean {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(cwd));
  return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const INHERITED_ENV_KEYS = new Set([
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'LANG',
  'LC_ALL',
  'TERM',
  'SHELL',
]);

// eslint-disable-next-line no-control-regex
const ENV_VALUE_UNSAFE = /[\u0000-\u001f\u007f]/;

/**
 * Builds the child environment from an explicit key list, drops values that
 * carry control characters, and rewrites the Windows shell pointer to the
 * SystemRoot copy so a redirected ComSpec cannot reach a grandchild tool.
 */
function buildEnvironment(canonicalShell: string | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || !INHERITED_ENV_KEYS.has(key) || ENV_VALUE_UNSAFE.test(value)) {
      continue;
    }
    if (key.toUpperCase() === 'COMSPEC') {
      continue;
    }
    environment[key] = value;
  }
  if (canonicalShell !== undefined) {
    environment.ComSpec = canonicalShell;
  }
  // CI tools need a writable temporary directory and a deterministic color mode.
  environment.CI = '1';
  environment.NO_COLOR = '1';
  environment.FORCE_COLOR = '0';
  return environment;
}

function appendBounded(
  target: { text: string; truncated: boolean },
  chunk: string,
  maxChars: number,
): void {
  if (target.text.length >= maxChars) {
    target.truncated = true;
    return;
  }
  const remaining = maxChars - target.text.length;
  if (chunk.length > remaining) {
    target.text += chunk.slice(0, remaining);
    target.truncated = true;
  } else {
    target.text += chunk;
  }
}

/**
 * Confirms the working directory is a real folder whose resolved path stays
 * inside the resolved workspace, so a link cannot carry execution outside it.
 */
async function inspectWorkingDirectory(
  cwd: string,
  workspaceRoot: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let realCwd: string;
  let realRoot: string;
  try {
    const status = await fs.promises.stat(cwd);
    if (!status.isDirectory()) {
      return { ok: false, reason: 'The working directory is not a folder.' };
    }
    realCwd = await fs.promises.realpath(cwd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, reason: 'The working directory does not exist.' };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, reason: 'The working directory cannot be inspected (permission denied).' };
    }
    return { ok: false, reason: 'The working directory could not be inspected.' };
  }
  try {
    realRoot = await fs.promises.realpath(workspaceRoot);
  } catch {
    return { ok: false, reason: 'The workspace root could not be inspected.' };
  }
  if (!isWithinWorkspace(realCwd, realRoot)) {
    return { ok: false, reason: 'The working directory resolves outside the workspace.' };
  }
  return { ok: true };
}

/**
 * Runs exactly one allowlisted command as a direct executable invocation, with
 * a sanitized environment, bounded output, a hard timeout and cooperative
 * cancellation. A command with no shell-free representation is refused.
 */
export async function runApprovedCommand(
  raw: string,
  options: CommandRunOptions,
): Promise<CommandResult> {
  const startedAt = Date.now();
  const validation = validateCommand(raw, options.allowlist);
  const cwd = path.resolve(options.cwd);
  const maxOutputChars = Math.max(1_000, options.maxOutputChars ?? MAX_COMMAND_OUTPUT);
  const command = validation.normalized ?? raw;

  const blocked = (error: string, cancelled = false): CommandResult => ({
    command,
    cwd,
    exitCode: null,
    output: '',
    timedOut: false,
    cancelled,
    truncated: false,
    durationMs: 0,
    error,
  });

  if (options.trusted !== true) {
    return {
      command: raw,
      cwd: path.resolve(options.cwd),
      exitCode: null,
      output: '',
      timedOut: false,
      cancelled: false,
      truncated: false,
      durationMs: 0,
      error: 'Workspace trust is required before running validation commands.',
    };
  }

  if (!validation.ok || validation.normalized === undefined || validation.tokens === undefined) {
    return blocked(validation.reason ?? 'The command is not allowed.');
  }

  if (!isWithinWorkspace(cwd, options.workspaceRoot)) {
    return blocked('The working directory is outside the workspace.');
  }

  const directory = await inspectWorkingDirectory(cwd, options.workspaceRoot);
  if (!directory.ok) {
    return blocked(directory.reason);
  }

  const plan = planCommand({ tokens: validation.tokens });
  if (!plan.ok) {
    return blocked(plan.reason);
  }

  if (options.signal?.aborted === true) {
    return blocked('The command was cancelled before it started.', true);
  }

  const execution = plan.plan;
  const output = { text: '', truncated: false };
  let timedOut = false;
  let cancelled = false;
  let spawnError: string | undefined;

  return await new Promise<CommandResult>((resolve) => {
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(execution.file, [...execution.args], {
      cwd,
      env: buildEnvironment(canonicalWindowsShell()),
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: execution.verbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);

    const finish = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      options.signal?.removeEventListener('abort', onAbort);
      const redacted = redactSecrets(output.text, [options.secret]);
      resolve({
        command,
        cwd,
        exitCode,
        output: redacted.text,
        timedOut,
        cancelled,
        truncated: output.truncated,
        durationMs: Date.now() - startedAt,
        error: spawnError,
      });
    };

    const terminate = (): void => {
      if (settled) {
        return;
      }
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, 2_000);
    };

    const onAbort = (): void => {
      cancelled = true;
      terminate();
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer | string) => {
      appendBounded(output, chunk.toString(), maxOutputChars);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      appendBounded(output, chunk.toString(), maxOutputChars);
    });
    child.on('error', (error) => {
      spawnError = error.message;
      finish(null);
    });
    child.on('close', (code) => {
      finish(typeof code === 'number' ? code : null);
    });
  });
}
