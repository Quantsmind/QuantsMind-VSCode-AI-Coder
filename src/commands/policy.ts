import { runApprovedCommand, validateCommand, type CommandResult } from './runner';
import type { CommandPolicy, CommandRisk, ICommandExecutionService } from '../agent/models';

const DESTRUCTIVE_FIRST_TOKENS = new Set([
  'rm',
  'rmdir',
  'del',
  'erase',
  'format',
  'mkfs',
  'diskpart',
  'dd',
  'shutdown',
  'reboot',
]);

const COMPOUND_DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\bgit\s+(?:reset\s+--hard|clean\b|push\b|checkout\b|switch\b|branch\s+-D|filter-branch\b)/,
  /\b(?:npm|yarn|pnpm)\s+(?:run\s+)?(?:publish|unpublish|deprecate|release|deploy)\b/,
  /\b(?:docker|podman)\s+(?:push|rm|rmi|system\s+prune)\b/,
  /\b(?:kubectl|helm)\s+(?:delete|apply|upgrade|uninstall)\b/,
  /\bterraform\s+(?:apply|destroy)\b/,
];

const VALIDATION_FIRST_TOKENS = new Set([
  'npm',
  'yarn',
  'pnpm',
  'bun',
  'npx',
  'deno',
  'mocha',
  'jest',
  'vitest',
  'tsc',
  'eslint',
  'biome',
  'prettier',
  'pytest',
  'python',
  'python3',
  'cargo',
  'go',
  'mvn',
  'mvnw',
  'gradle',
  'gradlew',
  'dotnet',
  'make',
  'cmake',
  'ninja',
  'ruff',
  'mypy',
  'tox',
  'nox',
  'rake',
  'bundle',
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'rev-parse',
  'remote',
  'ls-files',
  'describe',
  'blame',
]);

function firstTokens(normalized: string): string[] {
  return normalized.toLowerCase().split(/\s+/).slice(0, 3);
}

function classify(normalized: string): CommandRisk {
  const lower = normalized.toLowerCase();
  const tokens = firstTokens(normalized);
  const first = tokens[0] ?? '';
  if (
    DESTRUCTIVE_FIRST_TOKENS.has(first) ||
    COMPOUND_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(lower))
  ) {
    return 'destructive';
  }
  if (first === 'git' && READ_ONLY_GIT_SUBCOMMANDS.has(tokens[1] ?? '')) {
    return 'read-only';
  }
  if (
    (first === 'npm' || first === 'yarn' || first === 'pnpm') &&
    (tokens[1] === '--version' || tokens[1] === '-v' || tokens[1] === 'list' || tokens[1] === 'ls')
  ) {
    return 'read-only';
  }
  if (
    (first === 'node' && (tokens[1] === '--version' || tokens[1] === '-v')) ||
    first === 'ls' ||
    first === 'dir' ||
    first === 'pwd'
  ) {
    return 'read-only';
  }
  if (VALIDATION_FIRST_TOKENS.has(first)) {
    return 'validation';
  }
  return 'unknown';
}

/**
 * Classifies a command without executing it. The allowlist is exact and the
 * destructive check is independent of it, so adding a destructive command to
 * the allowlist cannot enable it.
 */
export function evaluateCommand(
  raw: string,
  allowlist: readonly string[],
): CommandPolicy {
  if (typeof raw !== 'string') {
    return {
      allowed: false,
      risk: 'unknown',
      requiresApproval: true,
      reason: 'The command must be text.',
    };
  }
  const normalized = raw.trim().replace(/\s+/g, ' ');
  const risk = normalized.length > 0 ? classify(normalized) : 'unknown';
  if (risk === 'destructive') {
    return {
      allowed: false,
      risk,
      requiresApproval: true,
      normalized: normalized.length > 0 ? normalized : undefined,
      reason: 'Destructive commands are not permitted, even when allowlisted.',
    };
  }
  const validation = validateCommand(normalized, allowlist);
  if (!validation.ok || validation.normalized === undefined) {
    return {
      allowed: false,
      risk,
      requiresApproval: true,
      normalized: validation.normalized,
      reason: validation.reason ?? 'The command is not allowed.',
    };
  }
  return {
    allowed: true,
    risk,
    requiresApproval: true,
    normalized: validation.normalized,
    reason: 'The command is in the exact allowlist and requires explicit approval.',
  };
}

export interface CommandExecutionSettings {
  allowlist(): readonly string[];
  cwd(): string;
  workspaceRoot(): string;
  timeoutMs(): number;
  maxOutputChars(): number;
  secret?(): string | undefined;
}

function blockedResult(command: string, cwd: string, error: string): CommandResult {
  return {
    command,
    cwd,
    exitCode: null,
    output: '',
    timedOut: false,
    cancelled: false,
    truncated: false,
    durationMs: 0,
    error,
  };
}

export class CommandExecutionService implements ICommandExecutionService {
  constructor(private readonly settings: CommandExecutionSettings) {}

  evaluate(command: string, allowlist: readonly string[] = this.settings.allowlist()): CommandPolicy {
    return evaluateCommand(command, allowlist);
  }

  async run(command: string, signal: AbortSignal): Promise<CommandResult> {
    const policy = this.evaluate(command, this.settings.allowlist());
    const cwd = this.settings.cwd();
    if (!policy.allowed || policy.normalized === undefined) {
      return blockedResult(command, cwd, policy.reason);
    }
    return runApprovedCommand(policy.normalized, {
      cwd,
      workspaceRoot: this.settings.workspaceRoot(),
      allowlist: this.settings.allowlist(),
      timeoutMs: this.settings.timeoutMs(),
      maxOutputChars: this.settings.maxOutputChars(),
      secret: this.settings.secret?.(),
      signal,
    });
  }
}
