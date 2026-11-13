/**
 * Read-only workspace inspection — v3.1.1 WP3/WP4.
 *
 * Pure data assembly + deterministic classifier. Nothing here writes to the
 * workspace, executes commands, or calls a provider; the wrapper in the chat
 * view gathers local data and passes it in. This report never invents a
 * project name, version, branch, or Git state.
 */

export interface WorkspaceInspectionInput {
  readonly rootName: string;
  readonly rootPath?: string;
  /** Every path discovered by the workspace index (relative, forward slashes). */
  readonly paths: readonly string[];
  readonly maxIndexedFiles?: number;
  /** Explicitly read manifest state. */
  readonly manifest?:
    | { readonly found: true; readonly name?: string; readonly version?: string; readonly private?: boolean }
    | { readonly found: false }
    | { readonly unreadable: string };
  /** Git metadata (read-only). */
  readonly git?:
    | { readonly available: true; readonly repository: true; readonly branch?: string; readonly headShort?: string; readonly changed: readonly string[] }
    | { readonly available: true; readonly repository: false }
    | { readonly available: false; readonly unavailable: string };
  /** Maximum number of indexed paths to list explicitly. */
  readonly listLimit?: number;
}

export interface WorkspaceInspectionReport {
  readonly rootName: string;
  readonly totals: {
    readonly indexed: number;
    readonly listed: number;
    readonly uninspected: number;
  };
  readonly languages: readonly { readonly language: string; readonly files: number }[];
  readonly manifests: readonly string[];
  readonly packageVersion?: string;
  readonly sourceDirectories: readonly string[];
  readonly testDirectories: readonly string[];
  readonly testFiles: number;
  readonly gitDescription: string;
  readonly unavailable: readonly string[];
  readonly notes: readonly string[];
  readonly truncated: boolean;
  readonly text: string;
}

export type WorkspaceIntent =
  | 'read_only_inspection'
  | 'implementation_request'
  | 'undetermined';

const INSPECTION_VERBS =
  /\b(inspect|audit|inventory|overview|review|summari[sz]e|describe|explain|report|walk ?through|list|analy[sz]e|check what|see what|look at|contain|consist|what is (in|inside|here)|what's (in|inside|here))\b/i;
const MODIFYING_VERBS =
  /\b(add|create|implement|fix|update|rename|delete|remove|refactor|modify|change|replace|migrate|install|patch|write|build|compile|deploy|bump|upgrade|downgrade|enable|disable|run|execute|configure|set ?up|scaffold|generate|adjust|improve|optimi[sz]e|handle|design|port)\b/i;

/**
 * Deterministic intent classifier. Any modification verb disqualifies the
 * read-only path; unrecognized requests are treated as normal (gated) agent
 * requests. Returns `undetermined` when ambiguous.
 */
export function classifyWorkspaceIntent(requirement: string): WorkspaceIntent {
  const text = requirement.trim();
  if (text.length === 0) {
    return 'undetermined';
  }
  if (MODIFYING_VERBS.test(text)) {
    return 'implementation_request';
  }
  if (INSPECTION_VERBS.test(text)) {
    return 'read_only_inspection';
  }
  return 'undetermined';
}

const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin',
  cs: 'C#', fs: 'F#', rb: 'Ruby', php: 'PHP', c: 'C', h: 'C', cc: 'C++', cpp: 'C++', cxx: 'C++',
  hpp: 'C++', swift: 'Swift', scala: 'Scala', sh: 'Shell', bash: 'Shell', sql: 'SQL',
  vue: 'Vue', svelte: 'Svelte', dart: 'Dart', lua: 'Lua', r: 'R', zig: 'Zig',
};

const MANIFESTS = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile', 'poetry.lock',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'Cargo.toml', 'go.mod', 'composer.json', 'pubspec.yaml', 'Gemfile',
  'tsconfig.json', 'vite.config.ts', 'vite.config.js', 'webpack.config.js',
]);

const SOURCE_SEGMENTS = new Set(['src', 'source', 'lib', 'app', 'server', 'client', 'packages']);
const TEST_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'integration']);
export const DEFAULT_LIST_LIMIT = 60;

function baseName(path: string): string {
  const clean = path.replace(/\\/g, '/');
  const slash = clean.lastIndexOf('/');
  return slash >= 0 ? clean.slice(slash + 1) : clean;
}

function topSegment(path: string): string {
  const clean = path.replace(/\\/g, '/');
  const slash = clean.indexOf('/');
  return slash >= 0 ? clean.slice(0, slash) : clean;
}

function extensionOf(path: string): string | undefined {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  return name.slice(dot + 1).toLowerCase();
}

function isTestPath(path: string): boolean {
  const clean = path.replace(/\\/g, '/');
  const inTestDir = clean.split('/').some((segment) => TEST_SEGMENTS.has(segment.toLowerCase()));
  return inTestDir || /(\.test|\.spec)\.[a-z0-9]+$/i.test(clean);
}

function isSourcePath(path: string): boolean {
  const ext = extensionOf(path);
  if (ext === undefined || EXTENSION_LANGUAGE[ext] === undefined || isTestPath(path)) {
    return false;
  }
  const clean = path.replace(/\\/g, '/');
  return clean.split('/').some((segment) => SOURCE_SEGMENTS.has(segment.toLowerCase()));
}

export function buildWorkspaceInspection(input: WorkspaceInspectionInput): WorkspaceInspectionReport {
  const paths = [...new Set(input.paths.map((p) => p.replace(/\\/g, '/')))].sort((a, b) => a.localeCompare(b));
  const total = paths.length;
  const listedLimit = Math.min(input.listLimit ?? DEFAULT_LIST_LIMIT, total);
  const listedPaths = paths.slice(0, listedLimit);
  const listed = listedPaths.length;
  const uninspected = total - listed;

  const languageCounts = new Map<string, number>();
  for (const p of paths) {
    const ext = extensionOf(p);
    const language = ext === undefined ? undefined : EXTENSION_LANGUAGE[ext];
    if (language !== undefined) {
      languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
    }
  }
  const languages = [...languageCounts.entries()]
    .map(([language, files]) => ({ language, files }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));

  const manifests = [...new Set(paths.map(baseName).filter((name) => MANIFESTS.has(name)))].sort();

  const manifest = input.manifest;
  const packageVersion =
    manifest && 'found' in manifest && manifest.found === true && typeof manifest.version === 'string' && manifest.version.length > 0
      ? `${manifest.name ?? '(unnamed package)'}@${manifest.version} (from package.json)`
      : undefined;

  const sourceDirSet = new Set<string>();
  for (const p of paths) {
    if (isSourcePath(p)) {
      sourceDirSet.add(topSegment(p));
    }
  }
  const sourceDirectories = [...sourceDirSet].sort();

  const testDirCounts = new Map<string, number>();
  for (const p of paths) {
    if (!isTestPath(p)) {
      continue;
    }
    const segment = p.split('/').find((s) => TEST_SEGMENTS.has(s.toLowerCase())) ?? topSegment(p);
    testDirCounts.set(segment, (testDirCounts.get(segment) ?? 0) + 1);
  }
  const testDirectories = [...testDirCounts.keys()].sort();
  const testFiles = paths.filter(isTestPath).length;

  const unavailable: string[] = [];
  const notes: string[] = [];

  let gitDescription = 'unavailable';
  const git = input.git;
  if (git && git.available) {
    if (!git.repository) {
      gitDescription = 'inspected: not a Git repository';
    } else {
      const branch = git.branch ?? 'detached HEAD';
      const head = git.headShort ?? 'unknown HEAD';
      const dirty = git.changed.length > 0
        ? `working tree has ${git.changed.length} changed/untracked file(s)`
        : 'working tree clean';
      gitDescription = `${branch} @ ${head}, ${dirty}`;
      if (git.changed.length > 0) {
        notes.push(`${git.changed.length} uncommitted change(s): ${git.changed.slice(0, 10).join(', ')}${git.changed.length > 10 ? ', …' : ''}.`);
      }
    }
  } else if (git && !git.available) {
    unavailable.push(`Git status unavailable: ${git.unavailable}`);
  }

  if (manifest) {
    if ('found' in manifest) {
      if (!manifest.found) {
        notes.push('No package.json found at the workspace root (inspected).');
        unavailable.push('Project name and version are not determinable without a verified root manifest.');
      } else if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
        unavailable.push('package.json is missing a "version" field (inspected).');
      }
    } else if ('unreadable' in manifest) {
      unavailable.push(`package.json could not be read: ${manifest.unreadable}`);
    }
  } else {
    unavailable.push('Manifest details were not inspected for this report.');
  }

  if (input.maxIndexedFiles !== undefined && total >= input.maxIndexedFiles) {
    notes.push(`Workspace index hit the cap of ${input.maxIndexedFiles} file(s); large or excluded subtrees are absent from this inventory.`);
  }

  const truncated = listedLimit < total ||
    (input.maxIndexedFiles !== undefined && total >= input.maxIndexedFiles);

  const lines: string[] = [];
  lines.push(`Workspace inspection report — ${input.rootName}`);
  lines.push('');
  lines.push('This inspection is read-only: no files were written, created, renamed, or deleted, and no commands were executed.');
  lines.push('');
  lines.push('## Overview');
  lines.push(`- Root: ${input.rootName}${input.rootPath !== undefined ? ` (${input.rootPath})` : ''}`);
  lines.push(`- Indexed files: ${total}`);
  if (languages.length > 0) {
    lines.push(`- Languages: ${languages.map(({ language, files }) => `${language} (${files})`).join(', ')}`);
  }
  if (manifests.length > 0) {
    lines.push(`- Manifests found: ${manifests.join(', ')}`);
  }
  if (packageVersion !== undefined) {
    lines.push(`- Project identity: ${packageVersion}`);
  }
  if (sourceDirectories.length > 0) {
    lines.push(`- Main source directories: ${sourceDirectories.join(', ')}`);
  }
  if (testDirectories.length > 0) {
    lines.push(`- Test directories: ${testDirectories.join(', ')}`);
  }
  lines.push(`- Test files (heuristic): ${testFiles}`);
  lines.push(`- Git status: ${gitDescription}`);
  lines.push('');
  lines.push('## Explicitly inspected (evidence)');
  lines.push(`Listed ${listed} of ${total} indexed file(s); ${uninspected} file(s) were indexed and counted but not individually inspected.`);
  for (const path of listedPaths) {
    lines.push(`- ${path}`);
  }
  if (uninspected > 0) {
    lines.push(`- … and ${uninspected} more indexed file(s)`);
  }
  lines.push('');
  lines.push('## Unavailable or not determinable');
  if (unavailable.length === 0) {
    lines.push('- (none recorded)');
  } else {
    for (const item of unavailable) {
      lines.push(`- ${item}`);
    }
  }
  lines.push('');
  lines.push('## Notes and risks');
  if (notes.length === 0) {
    lines.push('- Nothing notable.');
  } else {
    for (const note of notes) {
      lines.push(`- ${note}`);
    }
  }
  lines.push('');
  lines.push('## Verification basis');
  lines.push('- Workspace index (paths only; no file contents read unless read operation was explicitly listed)');
  if (manifest && 'found' in manifest) {
    lines.push(manifest.found ? '- package.json (local read)' : '- package.json presence check (not found)');
  } else if (manifest && 'unreadable' in manifest) {
    lines.push('- package.json presence check (unreadable)');
  }
  if (git && git.available) {
    lines.push('- Git CLI (rev-parse / symbolic-ref / status --porcelain=v1 -z; read-only)');
  }

  return {
    rootName: input.rootName,
    totals: { indexed: total, listed, uninspected },
    languages,
    manifests,
    ...(packageVersion !== undefined ? { packageVersion } : {}),
    sourceDirectories,
    testDirectories,
    testFiles,
    gitDescription,
    unavailable,
    notes,
    truncated,
    text: lines.join('\n'),
  };
}
