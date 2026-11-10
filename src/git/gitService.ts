import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { planCommand } from '../commands/executionPlan';
import { redactSecrets } from '../security/redact';

export interface GitOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxOutputChars?: number;
}

export interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_CHARS = 4_000_000;

const INHERITED_ENV_KEYS = new Set([
  'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'WINDIR',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'LC_ALL', 'TERM', 'SHELL',
]);

function childEnv(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && INHERITED_ENV_KEYS.has(key)) {
      environment[key] = value;
    }
  }
  // Deterministic, machine-parseable output; disable user prompts.
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

function appendBounded(target: { text: string }, chunk: Buffer | string, limit: number): void {
  if (target.text.length < limit) {
    target.text += chunk.toString('utf8').slice(0, limit - target.text.length);
  }
}

/**
 * Runs git with arguments as a direct executable invocation; never a shell.
 * Working directory must exist; callers enforce workspace boundaries.
 */
export async function runGit(args: readonly string[], options: GitOptions): Promise<GitResult> {
  const startedAt = Date.now();
  const plan = planCommand({ tokens: ['git', ...args] });
  if (!plan.ok) {
    return { ok: false, stdout: '', stderr: plan.reason, exitCode: null, durationMs: Date.now() - startedAt };
  }
  const timeoutMs = Math.max(250, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxOutputChars = Math.max(1_000, options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);
  const execution = plan.plan;
  const stdout = { text: '' };
  const stderr = { text: '' };

  return await new Promise<GitResult>((resolve) => {
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout: redactSecrets(stdout.text).text,
        stderr: redactSecrets(stderr.text).text,
        exitCode: code,
        durationMs: Date.now() - startedAt,
      });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, 2_000);
    }, timeoutMs);

    const child = spawn(execution.file, [...execution.args], {
      cwd: options.cwd,
      env: childEnv(),
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: execution.verbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer | string) => appendBounded(stdout, chunk, maxOutputChars));
    child.stderr?.on('data', (chunk: Buffer | string) => appendBounded(stderr, chunk, maxOutputChars));
    child.on('error', (error) => {
      stderr.text += `\n${error.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(typeof code === 'number' ? code : null));
  });
}

function normalizeFsPath(value: string): string {
  return value.replace(/\\/g, '/');
}

/** Absolute path with forward slashes, normalized for portable comparisons. */
export function absoluteGitPath(cwd: string, input: string): string {
  if (path.isAbsolute(input)) {
    return normalizeFsPath(path.normalize(input));
  }
  return normalizeFsPath(path.join(cwd, input));
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export interface GitRepoInfo {
  readonly isRepository: boolean;
  readonly root?: string;
  readonly bare?: boolean;
  readonly branch?: string;
  readonly headSha?: string;
  readonly headShort?: string;
  readonly defaultRemote?: string;
}

/** Detects Git repository state without writing anything. */
export async function repoInfo(cwd: string): Promise<GitRepoInfo> {
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd });
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { isRepository: false };
  }
  const rootResult = await runGit(['rev-parse', '--show-toplevel'], { cwd });
  const root = rootResult.ok ? normalizeFsPath(rootResult.stdout.trim()) : undefined;
  if (root === undefined) {
    return { isRepository: false };
  }
  const bareResult = await runGit(['rev-parse', '--is-bare-repository'], { cwd });
  const branch = await resolveBranch(cwd);
  const head = await resolveHead(cwd);
  const remotes = await listRemotes(cwd);
  return {
    isRepository: true,
    root,
    bare: bareResult.ok ? bareResult.stdout.trim() === 'true' : false,
    branch,
    headSha: head.sha,
    headShort: head.short,
    defaultRemote: remotes[0]?.name,
  };
}

async function resolveBranch(cwd: string): Promise<string | undefined> {
  const result = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
  if (result.ok && result.stdout.trim().length > 0) {
    return result.stdout.trim();
  }
  return undefined; // detached HEAD
}

async function resolveHead(cwd: string): Promise<{ sha?: string; short?: string }> {
  const result = await runGit(['rev-parse', 'HEAD'], { cwd });
  if (!result.ok) {
    return {};
  }
  const sha = result.stdout.trim();
  return { sha, short: sha.slice(0, 7) };
}

export type GitFileState =
  | 'staged'
  | 'modified'
  | 'staged-modified'
  | 'added'
  | 'deleted'
  | 'staged-deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflict';

export interface GitStatusEntry {
  readonly path: string;
  readonly state: GitFileState;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
  readonly deleted: boolean;
  readonly conflict: boolean;
  readonly renamedFrom?: string;
}

function isConflictXY(x: string, y: string): boolean {
  // Git conflict states always involve a U, or are AA/DD.
  if (x === 'U' || y === 'U') {
    return true;
  }
  if (x === 'A' && y === 'A') {
    return true;
  }
  return x === 'D' && y === 'D';
}

/** Parses `git status --porcelain=v1 -z` output. */
export function parsePorcelainV1(raw: string): GitStatusEntry[] {
  if (raw.length === 0) {
    return [];
  }
  const tokens = raw.split('\0').filter((token) => token.length > 0);
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token.length < 4) {
      continue;
    }
    const x = token[0] ?? '?';
    const y = token[1] ?? '?';
    const path = token.slice(3);
    if (x === '?' && y === '?') {
      entries.push({ path, state: 'untracked', staged: false, unstaged: false, untracked: true, deleted: false, conflict: false });
      continue;
    }
    // Rename/copy entries carry the original path as the next -z token.
    let renamedFrom: string | undefined;
    if ((x === 'R' || x === 'C') && index + 1 < tokens.length) {
      renamedFrom = tokens[index + 1];
      index += 1;
    }
    const conflict = isConflictXY(x, y);
    const stagedPart = /[MADRC]/.test(x);
    const unstagedPart = /[MD]/.test(y) || conflict;
    let state: GitFileState;
    if (conflict) {
      state = 'conflict';
    } else if (x === 'R') {
      state = 'renamed';
    } else if (x === 'C') {
      state = 'copied';
    } else if (x === 'A') {
      state = 'added';
    } else if (y === 'D' || x === 'D') {
      state = x === 'D' && stagedPart ? 'staged-deleted' : 'deleted';
    } else if (stagedPart && unstagedPart) {
      state = 'staged-modified';
    } else if (stagedPart) {
      state = 'staged';
    } else {
      state = 'modified';
    }
    entries.push({
      path,
      state,
      staged: stagedPart || conflict,
      unstaged: unstagedPart || conflict,
      untracked: false,
      deleted: y === 'D' || x === 'D',
      conflict,
      ...(renamedFrom !== undefined ? { renamedFrom } : {}),
    });
  }
  return entries;
}

export async function status(cwd: string): Promise<GitStatusEntry[]> {
  const result = await runGit(['status', '--porcelain=v1', '-z'], { cwd });
  return result.ok ? parsePorcelainV1(result.stdout) : [];
}

export interface DiffStat {
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: number;
}

export async function diffStat(cwd: string, cached: boolean, pathspec?: string): Promise<DiffStat> {
  const args = cached ? ['diff', '--cached', '--numstat', '--no-renames'] : ['diff', '--numstat', '--no-renames'];
  if (pathspec !== undefined) {
    args.push('--', pathspec);
  }
  const result = await runGit(args, { cwd });
  if (!result.ok) {
    return { files: 0, additions: 0, deletions: 0, binary: 0 };
  }
  let additions = 0;
  let deletions = 0;
  let files = 0;
  let binary = 0;
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const match = /^(\d+|-)\s+(\d+|-)\s+(.+)$/.exec(trimmed);
    if (match === null) {
      continue;
    }
    files += 1;
    if (match[1] === '-' && match[2] === '-') {
      binary += 1;
      continue;
    }
    additions += Number.parseInt(match[1] ?? '0', 10);
    deletions += Number.parseInt(match[2] ?? '0', 10);
  }
  return { files, additions, deletions, binary };
}

const DIFF_MAX_BYTES = 400_000;

export interface DiffResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly binaryFiles: number;
  readonly whitespaceErrors: number;
}

export async function diff(
  cwd: string,
  options: { cached?: boolean; pathspec?: string; ignoreWhitespace?: boolean; maxBytes?: number } = {},
): Promise<DiffResult> {
  const args = options.cached ? ['diff', '--cached'] : ['diff'];
  if (options.ignoreWhitespace === true) {
    args.push('-w');
  }
  args.push('--no-renames', `--stat`);
  args.push('-p');
  if (options.pathspec !== undefined) {
    args.push('--', options.pathspec);
  }
  const maxBytes = Math.max(1_000, options.maxBytes ?? DIFF_MAX_BYTES);
  const result = await runGit(args, { cwd, maxOutputChars: maxBytes + 64_000 });
  if (!result.ok) {
    return { text: result.stderr, truncated: false, binaryFiles: 0, whitespaceErrors: 0 };
  }
  const text = result.stdout;
  const whitespaceErrors = (text.match(/^error:/gm) ?? []).length;
  const binaryFiles = (text.match(/Bin\s+\d+\s+->\s+\d+ bytes/g) ?? []).length;
  const truncated = text.length > maxBytes;
  return {
    text: truncated ? text.slice(0, maxBytes) : text,
    truncated,
    binaryFiles,
    whitespaceErrors,
  };
}

export interface BranchInfo {
  readonly name: string;
  readonly current: boolean;
  readonly upstream?: string;
  readonly ahead?: number;
  readonly behind?: number;
}

export async function listBranches(cwd: string): Promise<BranchInfo[]> {
  const result = await runGit(
    ['branch', '--format=%(HEAD)|%(refname:short)|%(upstream:short)|%(upstream:track)'],
    { cwd },
  );
  if (!result.ok) {
    return [];
  }
  const branches: BranchInfo[] = [];
  for (const line of result.stdout.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    const parts = line.split('|');
    if (parts.length < 2) {
      continue;
    }
    const current = parts[0] === '*';
    const name = parts[1] ?? '';
    const upstream = (parts[2] ?? '').trim() || undefined;
    const track = (parts[3] ?? '').trim();
    const ahead = /ahead (\d+)/.exec(track);
    const behind = /behind (\d+)/.exec(track);
    branches.push({
      name,
      current,
      ...(upstream !== undefined ? { upstream } : {}),
      ...(ahead !== null ? { ahead: Number.parseInt(ahead[1] ?? '0', 10) } : {}),
      ...(behind !== null ? { behind: Number.parseInt(behind[1] ?? '0', 10) } : {}),
    });
  }
  return branches;
}

export interface RemoteInfo {
  readonly name: string;
  readonly url: string;
}

function stripCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      parsed.username = '';
      parsed.password = '';
      parsed.port = '';
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export async function listRemotes(cwd: string): Promise<RemoteInfo[]> {
  const result = await runGit(['remote', '-v'], { cwd });
  if (!result.ok) {
    return [];
  }
  const seen = new Set<string>();
  const remotes: RemoteInfo[] = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\((?:fetch|push)\)$/.exec(line.trim());
    if (match === null) {
      continue;
    }
    const [, name, url] = match;
    if (name !== undefined && url !== undefined && !seen.has(name)) {
      seen.add(name);
      remotes.push({ name, url: stripCredentials(url) });
    }
  }
  return remotes;
}

export interface LogEntry {
  readonly sha: string;
  readonly shortSha: string;
  readonly author: string;
  readonly date: string;
  readonly subject: string;
}

export async function log(cwd: string, limit = 10): Promise<LogEntry[]> {
  const result = await runGit(
    ['log', `-n`, String(Math.max(1, Math.min(limit, 100))), `--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e`],
    { cwd },
  );
  if (!result.ok) {
    return [];
  }
  const entries: LogEntry[] = [];
  for (const record of result.stdout.split('\x1e')) {
    const trimmed = record.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const fields = trimmed.split('\x1f');
    const [sha, shortSha, author, date, subject] = fields;
    if (sha === undefined) {
      continue;
    }
    entries.push({ sha, shortSha: shortSha ?? '', author: author ?? '', date: date ?? '', subject: subject ?? '' });
  }
  return entries;
}

/** Stages an explicit list of paths. Never stages `.` or `-A`. */
export async function stage(cwd: string, paths: readonly string[]): Promise<GitResult> {
  if (paths.length === 0) {
    return { ok: false, stdout: '', stderr: 'No files selected for staging.', exitCode: null, durationMs: 0 };
  }
  for (const p of paths) {
    if (p === '.' || p === '*' || p === '-a' || p === '--all' || p.startsWith('-')) {
      return { ok: false, stdout: '', stderr: `Refusing to stage the broad pattern: ${p}`, exitCode: null, durationMs: 0 };
    }
  }
  return runGit(['add', '--', ...paths], { cwd });
}

/** Unstages an explicit list of paths. */
export async function unstage(cwd: string, paths: readonly string[]): Promise<GitResult> {
  if (paths.length === 0) {
    return { ok: false, stdout: '', stderr: 'No files selected for unstaging.', exitCode: null, durationMs: 0 };
  }
  return runGit(['restore', '--staged', '--', ...paths], { cwd });
}

/** Creates a commit from currently staged changes. Never implies `-a`. */
export async function commit(cwd: string, message: string): Promise<GitResult> {
  if (message.trim().length === 0) {
    return { ok: false, stdout: '', stderr: 'A commit message is required.', exitCode: null, durationMs: 0 };
  }
  return runGit(['commit', '-m', message], { cwd });
}

export async function headSha(cwd: string): Promise<string | undefined> {
  const result = await runGit(['rev-parse', 'HEAD'], { cwd });
  return result.ok ? result.stdout.trim() : undefined;
}

/** Creates a branch from HEAD; `checkout` switches to it. Requires prior approval. */
export async function createBranch(
  cwd: string,
  name: string,
  options: { checkout?: boolean; startPoint?: string } = {},
): Promise<GitResult> {
  if (name.startsWith('-') || name.includes('..') || name.includes(' ') || name.length > 200) {
    return { ok: false, stdout: '', stderr: 'Invalid branch name.', exitCode: null, durationMs: 0 };
  }
  if (options.checkout === true) {
    return options.startPoint !== undefined
      ? runGit(['switch', '-c', name, options.startPoint], { cwd })
      : runGit(['switch', '-c', name], { cwd });
  }
  if (options.startPoint !== undefined) {
    return runGit(['branch', name, options.startPoint], { cwd });
  }
  return runGit(['branch', name], { cwd });
}

export async function switchBranch(cwd: string, name: string): Promise<GitResult> {
  if (name.startsWith('-')) {
    return { ok: false, stdout: '', stderr: 'Invalid branch name.', exitCode: null, durationMs: 0 };
  }
  return runGit(['switch', name], { cwd });
}

/** Deletes a branch; `force` requires explicit user approval. */
export async function deleteBranch(cwd: string, name: string, options: { force?: boolean } = {}): Promise<GitResult> {
  if (name.startsWith('-')) {
    return { ok: false, stdout: '', stderr: 'Invalid branch name.', exitCode: null, durationMs: 0 };
  }
  return runGit(options.force === true ? ['branch', '-D', '--', name] : ['branch', '-d', '--', name], { cwd });
}

/** True when the working tree is clean (no staged/unstaged/untracked entries). */
export async function isClean(cwd: string): Promise<boolean> {
  const entries = await status(cwd);
  return entries.length === 0;
}

/** True when a merge/rebase/conflict state is in progress. */
export async function inProgressState(cwd: string): Promise<{ merge: boolean; rebase: boolean; conflict: boolean }> {
  const common = await runGit(['rev-parse', '--git-common-dir'], { cwd });
  const dir = common.ok ? path.resolve(cwd, common.stdout.trim()) : undefined;
  const merge = dir !== undefined && fs.existsSync(path.join(dir, 'MERGE_HEAD'));
  const rebase =
    dir !== undefined &&
    (fs.existsSync(path.join(dir, 'rebase-merge')) || fs.existsSync(path.join(dir, 'rebase-apply')));
  const entries = await status(cwd);
  return {
    merge,
    rebase,
    conflict: entries.some((entry) => entry.conflict),
  };
}

/** True when `target` is inside the repository root (path-boundary protection). */
export async function isInsideRepository(cwd: string): Promise<boolean> {
  const info = await repoInfo(cwd);
  return info.isRepository;
}

export { isWithin };
