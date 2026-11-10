import type { CancellationTokenLike } from '../providers/types';
import {
  buildWorkspaceSummary,
  normalizeWorkspacePath,
  type WorkspaceEntry,
} from '../workspace/analyze';
import {
  clampText,
  type ContextFact,
  type ModuleSummary,
  type ProjectContext,
  type RetrievalResult,
  type TechnologyLike,
} from '../agent/models';

export interface ProjectConfigFile {
  readonly path: string;
  readonly content?: string;
}

export interface AnalyzeProjectInput {
  readonly rootName: string;
  readonly entries: readonly WorkspaceEntry[];
  readonly configFiles?: readonly ProjectConfigFile[];
}

const CONFIG_PATTERNS: readonly RegExp[] = [
  /^package\.json$/i,
  /^package-lock\.json$/i,
  /^yarn\.lock$/i,
  /^pnpm-lock\.yaml$/i,
  /^bun\.lockb?$/i,
  /^tsconfig(?:\.[^/]+)?\.json$/i,
  /^jsconfig\.json$/i,
  /(^|\/)\.eslintrc(?:\.[^/]+)?$/i,
  /(^|\/)eslint\.config\.[cm]?[jt]s$/i,
  /(^|\/)\.eslintignore$/i,
  /(^|\/)(jest|vitest|playwright)\.config\.[cm]?[jt]s$/i,
  /(^|\/)\.prettierrc(?:\.[^/]+)?$/i,
  /(^|\/)prettier\.config\.[cm]?[jt]s$/i,
  /(^|\/)(vite|next|svelte|nuxt|astro)\.config\.[cm]?[jt]s$/i,
  /^angular\.json$/i,
  /^\.github\/workflows\/[^/]+\.ya?ml$/i,
  /^Dockerfile$/i,
  /(^|\/)docker-compose\.ya?ml$/i,
  /^Makefile$/i,
  /^CMakeLists\.txt$/i,
  /^pyproject\.toml$/i,
  /^requirements[^/]*\.txt$/i,
  /^setup\.(?:py|cfg)$/i,
  /^Pipfile$/i,
  /^Cargo\.toml$/i,
  /^go\.mod$/i,
  /^karkain\.toml$/i,
  /^pom\.xml$/i,
  /^build\.gradle(?:\.kts)?$/i,
  /^settings\.gradle(?:\.kts)?$/i,
  /\.csproj$/i,
  /^composer\.json$/i,
  /^Gemfile$/i,
  /^\.nvmrc$/i,
  /^\.node-version$/i,
  /^rust-toolchain(?:\.toml)?$/i,
  /^turbo\.json$/i,
  /^nx\.json$/i,
  /^lerna\.json$/i,
  /^justfile$/i,
  /^Taskfile\.ya?ml$/i,
];

const LOCKFILE_MANAGERS: readonly { readonly file: string; readonly manager: string }[] = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'Yarn' },
  { file: 'bun.lockb', manager: 'Bun' },
  { file: 'bun.lock', manager: 'Bun' },
  { file: 'package-lock.json', manager: 'npm' },
];

export function isProjectConfigPath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  if (normalized.length === 0) {
    return false;
  }
  const base = normalized.split('/').pop() ?? normalized;
  return CONFIG_PATTERNS.some((pattern) => pattern.test(base) || pattern.test(normalized));
}

function packageJsonOf(configFiles: readonly ProjectConfigFile[]): ProjectConfigFile | undefined {
  return configFiles
    .filter(
      (file) =>
        file.content !== undefined &&
        (normalizeWorkspacePath(file.path) === 'package.json' ||
          normalizeWorkspacePath(file.path).endsWith('/package.json')),
    )
    .sort(
      (left, right) =>
        normalizeWorkspacePath(left.path).split('/').length -
          normalizeWorkspacePath(right.path).split('/').length ||
        left.path.localeCompare(right.path),
    )[0];
}

interface PackageFacts {
  readonly packageManager?: string;
  readonly scripts: Record<string, string>;
  readonly facts: ContextFact[];
}

function readPackageFacts(
  configFiles: readonly ProjectConfigFile[],
  entries: readonly WorkspaceEntry[],
): PackageFacts {
  const facts: ContextFact[] = [];
  const scripts: Record<string, string> = {};
  const bases = new Set(entries.map((entry) => normalizeWorkspacePath(entry.path).split('/').pop() ?? ''));

  const lock = LOCKFILE_MANAGERS.find((candidate) => bases.has(candidate.file));
  let packageManager = lock?.manager;
  if (packageManager !== undefined) {
    facts.push({
      fact: `Package manager detected from ${lock?.file ?? 'lockfile'}`,
      path: lock?.file,
    });
  } else if (bases.has('package.json')) {
    packageManager = 'npm';
    facts.push({ fact: 'package.json without a lockfile; npm assumed', path: 'package.json' });
  }

  const packageJson = packageJsonOf(configFiles);
  if (packageJson?.content === undefined) {
    return { packageManager, scripts, facts };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson.content);
  } catch {
    facts.push({ fact: 'package.json could not be parsed as JSON', path: packageJson.path });
    return { packageManager, scripts, facts };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { packageManager, scripts, facts };
  }
  const record = parsed as Record<string, unknown>;

  const rawScripts = record.scripts;
  if (typeof rawScripts === 'object' && rawScripts !== null && !Array.isArray(rawScripts)) {
    let count = 0;
    for (const [name, value] of Object.entries(rawScripts)) {
      if (count >= 30) {
        break;
      }
      if (!/^[A-Za-z0-9:._-]{1,100}$/.test(name) || typeof value !== 'string') {
        continue;
      }
      scripts[name] = clampText(value, 300);
      count += 1;
    }
    facts.push({
      fact:
        count > 0
          ? `package.json defines ${count} script(s): ${Object.keys(scripts).join(', ')}`
          : 'package.json defines no usable scripts',
      path: normalizeWorkspacePath(packageJson.path),
    });
  }

  const dependencies = record.dependencies;
  const devDependencies = record.devDependencies;
  const runtimeCount =
    typeof dependencies === 'object' && dependencies !== null && !Array.isArray(dependencies)
      ? Object.keys(dependencies).length
      : 0;
  const devCount =
    typeof devDependencies === 'object' &&
    devDependencies !== null &&
    !Array.isArray(devDependencies)
      ? Object.keys(devDependencies).length
      : 0;
  if (runtimeCount + devCount > 0) {
    const names = [
      ...(typeof dependencies === 'object' && dependencies !== null && !Array.isArray(dependencies)
        ? Object.keys(dependencies)
        : []),
      ...(typeof devDependencies === 'object' &&
      devDependencies !== null &&
      !Array.isArray(devDependencies)
        ? Object.keys(devDependencies)
        : []),
    ]
      .filter((name) => /^[@A-Za-z0-9._/-]{1,100}$/.test(name))
      .slice(0, 30);
    facts.push({
      fact: `${runtimeCount} runtime and ${devCount} development dependencies${
        names.length > 0 ? ` (${names.join(', ')})` : ''
      }`,
      path: normalizeWorkspacePath(packageJson.path),
    });
  }

  return { packageManager, scripts, facts };
}

/**
 * Pure local analysis. It consumes file names plus optional small config file
 * contents and never reads the disk or a provider.
 */
export function analyzeProject(input: AnalyzeProjectInput): ProjectContext {
  const entries = input.entries.map((entry) => ({
    path: normalizeWorkspacePath(entry.path),
    size: entry.size,
  }));
  const summary = buildWorkspaceSummary(input.rootName, entries);
  const configFiles = [...(input.configFiles ?? [])]
    .map((file) => ({ ...file, path: normalizeWorkspacePath(file.path) }))
    .filter((file) => file.path.length > 0)
    .slice(0, 40);
  const packageFacts = readPackageFacts(configFiles, entries);

  const languages: TechnologyLike[] = summary.technologies
    .filter((technology) => technology.kind === 'language')
    .slice(0, 8)
    .map((technology) => ({ ...technology }));
  const tooling = summary.technologies.filter((technology) => technology.kind !== 'language');

  const directoryNames = new Set<string>();
  for (const entry of entries) {
    const segments = entry.path.split('/');
    if (segments.length > 1) {
      directoryNames.add(segments[0] ?? '');
    }
  }
  const modules: ModuleSummary[] = summary.topLevel
    .filter((item) => directoryNames.has(item.name) && !item.name.startsWith('.'))
    .slice(0, 12)
    .map((item) => ({ name: item.name, files: item.files }));

  const facts: ContextFact[] = [...packageFacts.facts];
  if (languages.length > 0) {
    facts.push({
      fact: `Languages: ${languages.map((language) => `${language.name} (${language.files})`).join(', ')}`,
    });
  }
  if (summary.entryPoints.length > 0) {
    facts.push({ fact: `Likely entry points: ${summary.entryPoints.join(', ')}` });
  }
  facts.push({ fact: `Test files: ${summary.testFiles}` });
  if (modules.length > 0) {
    facts.push({
      fact: `Top-level modules: ${modules.map((item) => `${item.name} (${item.files})`).join(', ')}`,
    });
  }
  for (const config of configFiles.slice(0, 12)) {
    facts.push({ fact: 'Project configuration file', path: config.path });
  }

  const summaryText = clampText(
    [
      `Project ${input.rootName}: ${entries.length.toLocaleString()} indexed file(s).`,
      languages.length > 0
        ? `Languages: ${languages.map((language) => `${language.name} (${language.files})`).join(', ')}.`
        : 'Languages: none detected from file extensions.',
      tooling.length > 0
        ? `Project markers: ${tooling
            .slice(0, 8)
            .map((technology) => `${technology.name} (${technology.evidence})`)
            .join(', ')}.`
        : '',
      packageFacts.packageManager !== undefined
        ? `Package manager: ${packageFacts.packageManager}.`
        : '',
      Object.keys(packageFacts.scripts).length > 0
        ? `Scripts: ${Object.keys(packageFacts.scripts).join(', ')}.`
        : '',
      modules.length > 0
        ? `Top-level modules: ${modules.map((item) => `${item.name} (${item.files})`).join(', ')}.`
        : '',
      summary.entryPoints.length > 0
        ? `Likely entry points: ${summary.entryPoints.join(', ')}.`
        : '',
      `Test files: ${summary.testFiles}.`,
      configFiles.length > 0
        ? `Configuration files: ${configFiles.slice(0, 12).map((file) => file.path).join(', ')}.`
        : '',
    ]
      .filter((line) => line.length > 0)
      .join('\n'),
    6_000,
  );

  return {
    rootName: input.rootName,
    languages,
    packageManager: packageFacts.packageManager,
    scripts: packageFacts.scripts,
    configFiles: configFiles.map((file) => file.path),
    modules,
    entryPoints: [...summary.entryPoints],
    testFiles: summary.testFiles,
    facts: facts.slice(0, 40),
    summaryText,
  };
}

export interface ProjectWorkspaceSource {
  readonly rootName: string | (() => string);
  listEntries(): Promise<readonly WorkspaceEntry[]>;
  readText(path: string): Promise<string | undefined>;
  retrieve(query: string, token: CancellationTokenLike): Promise<RetrievalResult>;
}

export interface IProjectIntelligence {
  inspect(token: CancellationTokenLike): Promise<ProjectContext>;
  retrieve(query: string, token: CancellationTokenLike): Promise<RetrievalResult>;
}

/**
 * Adapter that feeds local workspace metadata into the pure analyzer. Only
 * package.json is read for parsing; all other config files contribute their
 * path only.
 */
export class ProjectIntelligenceService implements IProjectIntelligence {
  constructor(private readonly source: ProjectWorkspaceSource) {}

  private rootName(): string {
    return typeof this.source.rootName === 'function'
      ? this.source.rootName()
      : this.source.rootName;
  }

  async inspect(token: CancellationTokenLike): Promise<ProjectContext> {
    const entries = await this.source.listEntries();
    if (token.isCancellationRequested) {
      return analyzeProject({ rootName: this.rootName(), entries: [] });
    }
    const configs = entries
      .map((entry) => normalizeWorkspacePath(entry.path))
      .filter((path) => isProjectConfigPath(path))
      .slice(0, 40);
    const packagePath = configs.find(
      (path) => path === 'package.json' || path.endsWith('/package.json'),
    );
    let packageContent: string | undefined;
    if (packagePath !== undefined) {
      try {
        packageContent = await this.source.readText(packagePath);
      } catch {
        packageContent = undefined;
      }
    }
    return analyzeProject({
      rootName: this.rootName(),
      entries,
      configFiles: configs.map((path) =>
        path === packagePath && packageContent !== undefined
          ? { path, content: packageContent }
          : { path },
      ),
    });
  }

  retrieve(query: string, token: CancellationTokenLike): Promise<RetrievalResult> {
    return this.source.retrieve(query, token);
  }
}
