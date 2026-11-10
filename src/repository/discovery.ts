import { isPathExcluded } from '../context/filters';
import { isProjectConfigPath } from '../project/intelligence';
import {
  buildWorkspaceSummary,
  entryPointsOf,
  isTestPath,
  normalizeWorkspacePath,
  type WorkspaceEntry,
  type WorkspaceSummary,
} from '../workspace/analyze';
import {
  isBinaryPath,
  isSupportedSourcePath,
  languageForPath,
  type Confidence,
  type SupportedLanguage,
} from './symbols';

export interface DiscoverRepositoryInput {
  readonly rootName: string;
  readonly entries: readonly WorkspaceEntry[];
  /** Small manifest/config contents keyed by workspace-relative path. */
  readonly configContents?: Readonly<Record<string, string>>;
  readonly excludeGlobs?: readonly string[];
  readonly maxEntries?: number;
}

export interface DiscoveredDirectory {
  readonly path: string;
  readonly files: number;
  readonly sourceFiles: number;
  readonly languages: readonly SupportedLanguage[];
}

export interface DiscoveredLanguage {
  readonly name: string;
  readonly files: number;
  readonly extensions: readonly string[];
  readonly confidence: Confidence;
}

export interface DiscoveredTechnology {
  readonly name: string;
  readonly kind: 'framework' | 'tooling' | 'build' | 'test' | 'package-manager';
  readonly evidence: readonly string[];
  readonly confidence: Confidence;
}

export interface RepositoryManifest {
  readonly path: string;
  readonly kind: 'package' | 'lockfile' | 'build' | 'config';
  readonly ecosystem: string;
  readonly confidence: Confidence;
}

export interface RepositoryBuildSystem {
  readonly name: string;
  readonly manifest: string;
  readonly commands: readonly string[];
  readonly confidence: Confidence;
}

export interface RepositoryModule {
  readonly name: string;
  readonly path: string;
  readonly files: number;
  readonly sourceFiles: number;
  readonly languages: readonly SupportedLanguage[];
}

export interface RepositoryMonorepo {
  readonly isMonorepo: boolean;
  readonly packages: readonly string[];
  readonly workspaces: readonly string[];
  readonly evidence: readonly string[];
  readonly confidence: Confidence;
}

export interface RepositoryOverview {
  readonly rootName: string;
  readonly summary: WorkspaceSummary;
  readonly fileCount: number;
  readonly sourceFileCount: number;
  readonly testFileCount: number;
  readonly directories: readonly DiscoveredDirectory[];
  readonly languages: readonly DiscoveredLanguage[];
  readonly technologies: readonly DiscoveredTechnology[];
  readonly manifests: readonly RepositoryManifest[];
  readonly buildSystems: readonly RepositoryBuildSystem[];
  readonly entryPoints: readonly string[];
  readonly configFiles: readonly string[];
  readonly modules: readonly RepositoryModule[];
  readonly monorepo: RepositoryMonorepo;
  readonly ignored: {
    readonly files: number;
    readonly directories: number;
    readonly reasons: Readonly<Record<string, number>>;
  };
  readonly limits: {
    readonly maxEntries: number;
    readonly maxDirectories: number;
    readonly maxModules: number;
    readonly maxConfigFiles: number;
    readonly truncated: boolean;
  };
}

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.vscode-test',
  '.yarn',
  '.pnpm-store',
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor',
  'third_party',
  'dist',
  'build',
  'out',
  'target',
  'obj',
  'bin',
  'coverage',
  '.nyc_output',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.gradle',
  '.idea',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  'generated',
  'gen',
  'tmp',
  '.tmp',
  'logs',
  'Pods',
  'DerivedData',
]);

const LANGUAGE_NAMES: Readonly<Record<SupportedLanguage, string>> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  java: 'Java',
  go: 'Go',
  c: 'C',
  cpp: 'C++',
  karkain: 'Karkain',
};

const SOURCE_EXTENSIONS: Readonly<Record<SupportedLanguage, readonly string[]>> = {
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  python: ['py'],
  java: ['java'],
  go: ['go'],
  c: ['c', 'h'],
  cpp: ['cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx'],
  karkain: ['kark'],
};

const MANIFESTS: readonly {
  readonly test: (path: string) => boolean;
  readonly kind: RepositoryManifest['kind'];
  readonly ecosystem: string;
}[] = [
  { test: (path) => baseName(path) === 'package.json', kind: 'package', ecosystem: 'Node.js' },
  { test: (path) => baseName(path) === 'karkain.toml', kind: 'package', ecosystem: 'Karkain' },
  { test: (path) => baseName(path) === 'package-lock.json', kind: 'lockfile', ecosystem: 'npm' },
  { test: (path) => baseName(path) === 'yarn.lock', kind: 'lockfile', ecosystem: 'Yarn' },
  { test: (path) => baseName(path) === 'pnpm-lock.yaml', kind: 'lockfile', ecosystem: 'pnpm' },
  { test: (path) => /^bun\.lockb?$/.test(baseName(path)), kind: 'lockfile', ecosystem: 'Bun' },
  { test: (path) => baseName(path) === 'tsconfig.json', kind: 'build', ecosystem: 'TypeScript' },
  { test: (path) => baseName(path) === 'pyproject.toml', kind: 'package', ecosystem: 'Python' },
  { test: (path) => /^requirements[^/]*\.txt$/i.test(baseName(path)), kind: 'package', ecosystem: 'pip' },
  { test: (path) => baseName(path) === 'setup.py' || baseName(path) === 'setup.cfg', kind: 'package', ecosystem: 'Python' },
  { test: (path) => baseName(path) === 'Pipfile', kind: 'package', ecosystem: 'Pipenv' },
  { test: (path) => baseName(path) === 'poetry.lock', kind: 'lockfile', ecosystem: 'Poetry' },
  { test: (path) => baseName(path) === 'go.mod', kind: 'package', ecosystem: 'Go modules' },
  { test: (path) => baseName(path) === 'go.sum', kind: 'lockfile', ecosystem: 'Go modules' },
  { test: (path) => baseName(path) === 'pom.xml', kind: 'build', ecosystem: 'Maven' },
  { test: (path) => /^build\.gradle(?:\.kts)?$/.test(baseName(path)), kind: 'build', ecosystem: 'Gradle' },
  { test: (path) => /^settings\.gradle(?:\.kts)?$/.test(baseName(path)), kind: 'build', ecosystem: 'Gradle' },
  { test: (path) => baseName(path) === 'Cargo.toml', kind: 'package', ecosystem: 'Cargo' },
  { test: (path) => baseName(path) === 'Cargo.lock', kind: 'lockfile', ecosystem: 'Cargo' },
  { test: (path) => baseName(path) === 'CMakeLists.txt', kind: 'build', ecosystem: 'CMake' },
  { test: (path) => baseName(path) === 'Makefile', kind: 'build', ecosystem: 'Make' },
  { test: (path) => /\.(?:csproj|sln)$/i.test(path), kind: 'build', ecosystem: '.NET' },
  { test: (path) => baseName(path) === 'Gemfile', kind: 'package', ecosystem: 'Bundler' },
  { test: (path) => baseName(path) === 'composer.json', kind: 'package', ecosystem: 'Composer' },
  { test: (path) => /^docker-compose\.ya?ml$/i.test(baseName(path)), kind: 'config', ecosystem: 'Docker Compose' },
  { test: (path) => baseName(path) === 'Dockerfile', kind: 'config', ecosystem: 'Docker' },
];

const CONFIG_PATTERNS: readonly RegExp[] = [
  /^\.editorconfig$/i,
  /^\.gitignore$/i,
  /^\.gitattributes$/i,
  /^\.nvmrc$/i,
  /^\.node-version$/i,
  /^\.python-version$/i,
  /^\.ruby-version$/i,
  /^\.tool-versions$/i,
  /(^|\/)tsconfig(?:\.[^/]+)?\.json$/i,
  /(^|\/)jsconfig\.json$/i,
  /(^|\/)\.eslintrc(?:\.[^/]+)?$/i,
  /(^|\/)eslint\.config\.[cm]?[jt]s$/i,
  /(^|\/)\.prettierrc(?:\.[^/]+)?$/i,
  /(^|\/)prettier\.config\.[cm]?[jt]s$/i,
  /(^|\/)(jest|vitest|playwright|cypress)\.config\.[cm]?[jt]s$/i,
  /(^|\/)(vite|next|nuxt|svelte|astro|angular)\.config\.[cm]?[jt]s$/i,
  /^angular\.json$/i,
  /^\.github\/workflows\/[^/]+\.ya?ml$/i,
  /(^|\/)\.vscode\/[^/]+\.json$/i,
  /(^|\/)(pytest|tox|mypy|ruff)\.(?:ini|toml)$/i,
  /^karkain\.toml$/i,
  /(^|\/)conftest\.py$/i,
  /(^|\/)(\.?phpunit[^/]*|phpstan[^/]*|psalm[^/]*)\.(?:xml|neon|json)$/i,
  /(^|\/)(checkstyle|spotbugs|pmd)[^/]*\.xml$/i,
  /(^|\/)\.golangci\.ya?ml$/i,
];

const FRAMEWORK_KEYWORDS: readonly {
  readonly name: string;
  readonly kind: DiscoveredTechnology['kind'];
  readonly pattern: RegExp;
  readonly ecosystem: string;
}[] = [
  { name: 'React', kind: 'framework', pattern: /(^|["'\s])react(?=["'\s@])/i, ecosystem: 'Node.js' },
  { name: 'Next.js', kind: 'framework', pattern: /\bnext\b/i, ecosystem: 'Node.js' },
  { name: 'Vue', kind: 'framework', pattern: /(^|["'\s])vue(?=["'\s@])/i, ecosystem: 'Node.js' },
  { name: 'Nuxt', kind: 'framework', pattern: /\bnuxt\b/i, ecosystem: 'Node.js' },
  { name: 'Angular', kind: 'framework', pattern: /@angular\/core/i, ecosystem: 'Node.js' },
  { name: 'Svelte', kind: 'framework', pattern: /\bsvelte\b/i, ecosystem: 'Node.js' },
  { name: 'Astro', kind: 'framework', pattern: /\bastro\b/i, ecosystem: 'Node.js' },
  { name: 'Express', kind: 'framework', pattern: /\bexpress\b/i, ecosystem: 'Node.js' },
  { name: 'Fastify', kind: 'framework', pattern: /\bfastify\b/i, ecosystem: 'Node.js' },
  { name: 'NestJS', kind: 'framework', pattern: /@nestjs\//i, ecosystem: 'Node.js' },
  { name: 'Electron', kind: 'framework', pattern: /\belectron\b/i, ecosystem: 'Node.js' },
  { name: 'Jest', kind: 'test', pattern: /\bjest\b/i, ecosystem: 'Node.js' },
  { name: 'Vitest', kind: 'test', pattern: /\bvitest\b/i, ecosystem: 'Node.js' },
  { name: 'Mocha', kind: 'test', pattern: /\bmocha\b/i, ecosystem: 'Node.js' },
  { name: 'Playwright', kind: 'test', pattern: /@playwright\/test/i, ecosystem: 'Node.js' },
  { name: 'ESLint', kind: 'tooling', pattern: /\beslint\b/i, ecosystem: 'Node.js' },
  { name: 'Django', kind: 'framework', pattern: /\bdjango\b/i, ecosystem: 'Python' },
  { name: 'Flask', kind: 'framework', pattern: /\bflask\b/i, ecosystem: 'Python' },
  { name: 'FastAPI', kind: 'framework', pattern: /\bfastapi\b/i, ecosystem: 'Python' },
  { name: 'SQLAlchemy', kind: 'tooling', pattern: /\bsqlalchemy\b/i, ecosystem: 'Python' },
  { name: 'pytest', kind: 'test', pattern: /\bpytest\b/i, ecosystem: 'Python' },
  { name: 'Ruff', kind: 'tooling', pattern: /\bruff\b/i, ecosystem: 'Python' },
  { name: 'Spring Boot', kind: 'framework', pattern: /spring-boot|springframework[._]boot/i, ecosystem: 'Java' },
  { name: 'JUnit', kind: 'test', pattern: /\bjunit\b/i, ecosystem: 'Java' },
  { name: 'Gradle', kind: 'build', pattern: /\bgradle\b/i, ecosystem: 'Java' },
  { name: 'Maven', kind: 'build', pattern: /<artifactId>\s*maven/i, ecosystem: 'Java' },
  { name: 'Gin', kind: 'framework', pattern: /\bgin-gonic\/gin\b/i, ecosystem: 'Go' },
  { name: 'Echo', kind: 'framework', pattern: /\blabstack\/echo\b/i, ecosystem: 'Go' },
  { name: 'Fiber', kind: 'framework', pattern: /\bgofiber\/fiber\b/i, ecosystem: 'Go' },
  { name: 'Qt', kind: 'framework', pattern: /\bqt[56]?\b/i, ecosystem: 'C/C++' },
  { name: 'CMake', kind: 'build', pattern: /\bcmake_minimum_required\b/i, ecosystem: 'C/C++' },
  { name: 'GoogleTest', kind: 'test', pattern: /\b(?:gtest|google_test|googletest)\b/i, ecosystem: 'C/C++' },
];

function baseName(path: string): string {
  const segments = path.split('/');
  return segments[segments.length - 1] ?? path;
}

function dirName(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '' : path.slice(0, index);
}

function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * Paths that are generated, vendored or build output are excluded before any
 * content is read. The check is deliberately case-insensitive on Windows-like
 * manifests but preserves the original path elsewhere.
 */
export function isIgnoredRepositoryPath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  if (normalized.length === 0) {
    return true;
  }
  const segments = normalized.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';
    if (IGNORED_DIRECTORIES.has(segment)) {
      return true;
    }
    if (segment === '__MACOSX' || segment === 'Thumbs.db' || segment === '.DS_Store') {
      return true;
    }
  }
  if (isBinaryPath(normalized)) {
    return true;
  }
  return false;
}

function readJsonRecord(content: string | undefined): Record<string, unknown> | undefined {
  if (content === undefined || content.length > 200_000) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      result[key] = entry;
    }
  }
  return result;
}

function selectedCommands(manager: string, scripts: Record<string, string>): string[] {
  const commands: string[] = [];
  const interesting = Object.keys(scripts).filter((name) =>
    /^(?:test|tests|compile|build|lint|typecheck|check|verify|unit|integration)(?::|$)/i.test(name),
  );
  for (const name of interesting.slice(0, 8)) {
    commands.push(name === 'test' ? `${manager} test` : `${manager} run ${name}`);
  }
  return [...new Set(commands)];
}

function technologiesFromText(
  files: readonly { readonly path: string; readonly content: string }[],
  languages: readonly DiscoveredLanguage[],
): DiscoveredTechnology[] {
  const found = new Map<string, DiscoveredTechnology>();
  const languageNames = new Set(languages.map((language) => language.name));
  for (const file of files) {
    for (const keyword of FRAMEWORK_KEYWORDS) {
      if (!keyword.pattern.test(file.content)) {
        continue;
      }
      const ecosystemMatches =
        keyword.ecosystem === 'Node.js'
          ? languageNames.has('JavaScript') || languageNames.has('TypeScript')
          : keyword.ecosystem === 'Python'
            ? languageNames.has('Python')
            : keyword.ecosystem === 'Java'
              ? languageNames.has('Java')
              : keyword.ecosystem === 'Go'
                ? languageNames.has('Go')
                : languageNames.has('C') || languageNames.has('C++');
      if (!ecosystemMatches && file.path !== 'package.json') {
        continue;
      }
      const existing = found.get(keyword.name);
      if (existing !== undefined) {
        if (!existing.evidence.includes(file.path)) {
          found.set(keyword.name, {
            ...existing,
            evidence: [...existing.evidence, file.path].slice(0, 4),
          });
        }
      } else {
        found.set(keyword.name, {
          name: keyword.name,
          kind: keyword.kind,
          evidence: [file.path],
          confidence: file.path === 'package.json' || file.path.endsWith('/package.json') ? 'confirmed' : 'heuristic',
        });
      }
    }
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function languageOverview(paths: readonly string[]): DiscoveredLanguage[] {
  const counts = new Map<SupportedLanguage, number>();
  const extensions = new Map<SupportedLanguage, Set<string>>();
  for (const path of paths) {
    const language = languageForPath(path);
    if (language === undefined) {
      continue;
    }
    counts.set(language, (counts.get(language) ?? 0) + 1);
    const set = extensions.get(language) ?? new Set<string>();
    set.add(extensionOf(path));
    extensions.set(language, set);
  }
  return [...counts.entries()]
    .map<DiscoveredLanguage>(([language, files]) => ({
      name: LANGUAGE_NAMES[language],
      files,
      extensions: [...(extensions.get(language) ?? [])].sort(),
      confidence: 'confirmed',
    }))
    .sort((left, right) => right.files - left.files || left.name.localeCompare(right.name));
}

function buildDirectories(paths: readonly string[], limit: number): DiscoveredDirectory[] {
  const counts = new Map<string, { files: number; sourceFiles: number; languages: Set<SupportedLanguage> }>();
  for (const path of paths) {
    const directory = dirName(path);
    const current = counts.get(directory) ?? { files: 0, sourceFiles: 0, languages: new Set<SupportedLanguage>() };
    current.files += 1;
    const language = languageForPath(path);
    if (language !== undefined) {
      current.sourceFiles += 1;
      current.languages.add(language);
    }
    counts.set(directory, current);
  }
  return [...counts.entries()]
    .filter(([path]) => path.length > 0)
    .map<DiscoveredDirectory>(([path, value]) => ({
      path,
      files: value.files,
      sourceFiles: value.sourceFiles,
      languages: [...value.languages].sort(),
    }))
    .sort((left, right) => right.sourceFiles - left.sourceFiles || left.path.localeCompare(right.path))
    .slice(0, limit);
}

function buildModules(paths: readonly string[], limit: number): RepositoryModule[] {
  const counts = new Map<string, { files: number; languages: Set<SupportedLanguage> }>();
  for (const path of paths) {
    const language = languageForPath(path);
    if (language === undefined) {
      continue;
    }
    const directory = dirName(path);
    const segments = directory.split('/').filter((segment) => segment.length > 0);
    const modulePath = segments.slice(0, 2).join('/');
    const current = counts.get(modulePath) ?? { files: 0, languages: new Set<SupportedLanguage>() };
    current.files += 1;
    current.languages.add(language);
    counts.set(modulePath, current);
  }
  return [...counts.entries()]
    .map<RepositoryModule>(([path, value]) => ({
      name: path.length === 0 ? '(root)' : path,
      path: path.length === 0 ? '.' : path,
      files: value.files,
      sourceFiles: value.files,
      languages: [...value.languages].sort(),
    }))
    .sort((left, right) => right.files - left.files || left.name.localeCompare(right.name))
    .slice(0, limit);
}

const MONOREPO_MANIFESTS: readonly string[] = [
  'pnpm-workspace.yaml',
  'pnpm-workspace.yml',
  'turbo.json',
  'nx.json',
  'lerna.json',
];

const MULTI_MODULE_MANIFESTS: readonly string[] = [
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'go.mod',
  'Cargo.toml',
  'CMakeLists.txt',
];

function workspaceGlobs(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string').slice(0, 20);
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const packages = (value as Record<string, unknown>).packages;
    if (Array.isArray(packages)) {
      return packages.filter((entry): entry is string => typeof entry === 'string').slice(0, 20);
    }
  }
  return [];
}

/**
 * Detects monorepositories and multi-module builds from manifests alone. A
 * single root manifest is not a monorepo; two or more package manifests, a
 * workspace manifest, or declared workspaces are.
 */
export function detectMonorepo(
  paths: readonly string[],
  configContents: Readonly<Record<string, string>>,
): RepositoryMonorepo {
  const evidence: string[] = [];
  const packagePaths = paths.filter((path) => baseName(path) === 'package.json');
  const packageDirs = [
    ...new Set(packagePaths.map((path) => (dirName(path) === '' ? '.' : dirName(path)))),
  ].sort();
  const workspaceManifests = paths.filter((path) => MONOREPO_MANIFESTS.includes(baseName(path)));
  const workspaces: string[] = [];

  const rootPackage =
    packagePaths.find((path) => dirName(path) === '') ??
    (packagePaths.length === 1 ? packagePaths[0] : undefined);
  if (rootPackage !== undefined) {
    const parsed = readJsonRecord(configContents[rootPackage]);
    const globs = workspaceGlobs(parsed?.workspaces);
    workspaces.push(...globs);
    if (globs.length > 0) {
      evidence.push(`${rootPackage} declares ${globs.length} workspace(s)`);
    }
  }

  if (packagePaths.length >= 2) {
    evidence.push(`${packagePaths.length} package.json manifests`);
  }
  for (const manifest of workspaceManifests) {
    evidence.push(`${manifest} workspace manifest`);
  }

  const moduleManifests = paths.filter((path) => MULTI_MODULE_MANIFESTS.includes(baseName(path)));
  const moduleDirs = [
    ...new Set(moduleManifests.map((path) => (dirName(path) === '' ? '.' : dirName(path)))),
  ];
  if (moduleDirs.length >= 2) {
    evidence.push(`${moduleDirs.length} nested build manifests`);
  }

  const isMonorepo =
    packagePaths.length >= 2 || workspaceManifests.length > 0 || workspaces.length > 0;
  return {
    isMonorepo,
    packages: packageDirs,
    workspaces: workspaces.sort(),
    evidence: [...new Set(evidence)].slice(0, 8),
    confidence: isMonorepo ? 'confirmed' : 'heuristic',
  };
}

function buildManifests(paths: readonly string[]): RepositoryManifest[] {
  const manifests: RepositoryManifest[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    for (const manifest of MANIFESTS) {
      if (!manifest.test(path)) {
        continue;
      }
      const key = `${manifest.ecosystem}:${path}`;
      if (!seen.has(key)) {
        seen.add(key);
        manifests.push({
          path,
          kind: manifest.kind,
          ecosystem: manifest.ecosystem,
          confidence: 'confirmed',
        });
      }
    }
  }
  return manifests.slice(0, 30);
}

function buildSystems(
  paths: readonly string[],
  configContents: Readonly<Record<string, string>>,
  languages: readonly DiscoveredLanguage[],
): RepositoryBuildSystem[] {
  const byPath = new Map(paths.map((path) => [baseName(path), path]));
  const systems: RepositoryBuildSystem[] = [];
  const packagePath = paths.find((path) => baseName(path) === 'package.json');
  const packageJson = readJsonRecord(packagePath === undefined ? undefined : configContents[packagePath]);
  const scripts = stringRecord(packageJson?.scripts);
  const manager =
    paths.some((path) => baseName(path) === 'pnpm-lock.yaml')
      ? 'pnpm'
      : paths.some((path) => baseName(path) === 'yarn.lock')
        ? 'yarn'
        : paths.some((path) => /^bun\.lockb?$/.test(baseName(path)))
          ? 'bun'
          : 'npm';
  if (packagePath !== undefined) {
    systems.push({
      name: manager,
      manifest: packagePath,
      commands: selectedCommands(manager, scripts),
      confidence: 'confirmed',
    });
  }
  if (byPath.has('tsconfig.json')) {
    systems.push({
      name: 'TypeScript compiler',
      manifest: byPath.get('tsconfig.json') ?? 'tsconfig.json',
      commands: ['npx tsc --noEmit'],
      confidence: 'confirmed',
    });
  }
  const testFramework = ['jest.config.ts', 'jest.config.js', 'jest.config.mjs', 'vitest.config.ts', 'vitest.config.js'].find(
    (name) => byPath.has(name),
  );
  if (testFramework !== undefined) {
    systems.push({
      name: testFramework.startsWith('vitest') ? 'Vitest' : 'Jest',
      manifest: byPath.get(testFramework) ?? testFramework,
      commands: [testFramework.startsWith('vitest') ? 'npx vitest run' : 'npx jest'],
      confidence: 'confirmed',
    });
  }
  if (byPath.has('pyproject.toml') || byPath.has('setup.py') || byPath.has('requirements.txt')) {
    const manifest = byPath.get('pyproject.toml') ?? byPath.get('setup.py') ?? byPath.get('requirements.txt') ?? 'pyproject.toml';
    systems.push({
      name: 'Python tests',
      manifest,
      commands: ['pytest'],
      confidence: languages.some((language) => language.name === 'Python') ? 'confirmed' : 'heuristic',
    });
  }
  if (byPath.has('go.mod')) {
    systems.push({
      name: 'Go modules',
      manifest: byPath.get('go.mod') ?? 'go.mod',
      commands: ['go test ./...', 'go build ./...'],
      confidence: 'confirmed',
    });
  }
  if (byPath.has('pom.xml')) {
    systems.push({
      name: 'Maven',
      manifest: byPath.get('pom.xml') ?? 'pom.xml',
      commands: ['mvn test', 'mvn verify'],
      confidence: 'confirmed',
    });
  }
  if (byPath.has('build.gradle') || byPath.has('build.gradle.kts')) {
    const manifest = byPath.get('build.gradle') ?? byPath.get('build.gradle.kts') ?? 'build.gradle';
    systems.push({
      name: 'Gradle',
      manifest,
      commands: [manifest.endsWith('.kts') ? './gradlew test' : './gradlew test'],
      confidence: 'confirmed',
    });
  }
  if (byPath.has('CMakeLists.txt')) {
    systems.push({
      name: 'CMake',
      manifest: byPath.get('CMakeLists.txt') ?? 'CMakeLists.txt',
      commands: ['cmake --build build', 'ctest --test-dir build'],
      confidence: 'confirmed',
    });
  }
  if (byPath.has('Makefile')) {
    systems.push({
      name: 'Make',
      manifest: byPath.get('Makefile') ?? 'Makefile',
      commands: ['make test'],
      confidence: 'heuristic',
    });
  }
  return systems;
}

function configFilesOf(paths: readonly string[], limit: number): string[] {
  return paths
    .filter((path) => isProjectConfigPath(path) || CONFIG_PATTERNS.some((pattern) => pattern.test(path)))
    .slice(0, limit);
}

function entryPointsWithManifest(paths: readonly string[], packageJson: Record<string, unknown> | undefined): string[] {
  const result = entryPointsOf(paths.map((path) => ({ path })));
  const add = (value: unknown): void => {
    if (typeof value !== 'string') {
      return;
    }
    const normalized = normalizeWorkspacePath(value);
    if (normalized.length > 0 && paths.includes(normalized) && !result.includes(normalized)) {
      result.push(normalized);
    }
  };
  add(packageJson?.main);
  add(packageJson?.module);
  const bin = packageJson?.bin;
  if (typeof bin === 'string') {
    add(bin);
  } else if (typeof bin === 'object' && bin !== null && !Array.isArray(bin)) {
    for (const value of Object.values(bin)) {
      add(value);
    }
  }
  return result.slice(0, 12);
}

/**
 * Pure repository discovery over an already-collected workspace entry list.
 * No disk or provider access happens here.
 */
export function discoverRepository(input: DiscoverRepositoryInput): RepositoryOverview {
  const maxEntries = Math.max(1, input.maxEntries ?? 20_000);
  const maxDirectories = 60;
  const maxModules = 24;
  const maxConfigFiles = 40;
  const configContents = input.configContents ?? {};
  const reasons: Record<string, number> = {};
  const paths: string[] = [];
  let ignoredFiles = 0;
  const ignoredDirectories = new Set<string>();

  for (const entry of input.entries.slice(0, maxEntries)) {
    const path = normalizeWorkspacePath(entry.path);
    if (path.length === 0) {
      ignoredFiles += 1;
      reasons.empty = (reasons.empty ?? 0) + 1;
      continue;
    }
    if (isPathExcluded(path, input.excludeGlobs ?? [])) {
      ignoredFiles += 1;
      reasons.excluded = (reasons.excluded ?? 0) + 1;
      continue;
    }
    if (isIgnoredRepositoryPath(path)) {
      ignoredFiles += 1;
      reasons.generated = (reasons.generated ?? 0) + 1;
      const first = path.split('/')[0] ?? path;
      ignoredDirectories.add(first);
      continue;
    }
    if (entry.size !== undefined && entry.size > 2_000_000) {
      ignoredFiles += 1;
      reasons.large = (reasons.large ?? 0) + 1;
      continue;
    }
    paths.push(path);
  }

  const summary = buildWorkspaceSummary(input.rootName, paths.map((path) => ({ path })));
  const languages = languageOverview(paths);
  const sourcePaths = paths.filter((path) => isSupportedSourcePath(path));
  const testPaths = paths.filter((path) => isTestPath(path));
  const manifests = buildManifests(paths);
  const packagePath = paths.find((path) => baseName(path) === 'package.json');
  const packageJson = readJsonRecord(packagePath === undefined ? undefined : configContents[packagePath]);
  const configPaths = paths.filter((path) => path === packagePath || configContents[path] !== undefined);
  const technologies = technologiesFromText(
    configPaths.map((path) => ({ path, content: configContents[path] ?? '' })),
    languages,
  );
  const manifestTechnologies: DiscoveredTechnology[] = manifests
    .filter((manifest) => manifest.kind === 'build' || manifest.kind === 'lockfile')
    .map((manifest) => ({
      name: manifest.ecosystem,
      kind: manifest.kind === 'lockfile' ? 'package-manager' : 'build',
      evidence: [manifest.path],
      confidence: 'confirmed' as const,
    }));
  const byTechnology = new Map<string, DiscoveredTechnology>();
  for (const technology of [...technologies, ...manifestTechnologies]) {
    const existing = byTechnology.get(technology.name);
    if (existing === undefined) {
      byTechnology.set(technology.name, technology);
    } else {
      byTechnology.set(technology.name, {
        ...existing,
        evidence: [...new Set([...existing.evidence, ...technology.evidence])].slice(0, 6),
        confidence: existing.confidence === 'confirmed' || technology.confidence === 'confirmed' ? 'confirmed' : 'heuristic',
      });
    }
  }

  return {
    rootName: input.rootName,
    summary,
    fileCount: paths.length,
    sourceFileCount: sourcePaths.length,
    testFileCount: testPaths.length,
    directories: buildDirectories(paths, maxDirectories),
    languages,
    technologies: [...byTechnology.values()].sort((left, right) => left.name.localeCompare(right.name)).slice(0, 24),
    manifests,
    buildSystems: buildSystems(paths, configContents, languages),
    entryPoints: entryPointsWithManifest(paths, packageJson),
    configFiles: configFilesOf(paths, maxConfigFiles),
    modules: buildModules(paths, maxModules),
    monorepo: detectMonorepo(paths, configContents),
    ignored: {
      files: ignoredFiles,
      directories: ignoredDirectories.size,
      reasons,
    },
    limits: {
      maxEntries,
      maxDirectories,
      maxModules,
      maxConfigFiles,
      truncated: input.entries.length > maxEntries,
    },
  };
}

export function extensionForLanguage(language: SupportedLanguage): readonly string[] {
  return SOURCE_EXTENSIONS[language];
}

export function architectureSummary(overview: RepositoryOverview): string {
  const parts = [
    `${overview.fileCount} file(s), ${overview.sourceFileCount} source file(s), ${overview.testFileCount} test file(s).`,
    overview.languages.length > 0
      ? `Languages: ${overview.languages.map((language) => `${language.name} (${language.files})`).join(', ')}.`
      : 'Languages: none detected.',
    overview.technologies.length > 0
      ? `Technologies: ${overview.technologies.map((technology) => `${technology.name} [${technology.confidence}]`).join(', ')}.`
      : '',
    overview.buildSystems.length > 0
      ? `Build/test systems: ${overview.buildSystems.map((system) => system.name).join(', ')}.`
      : '',
    overview.entryPoints.length > 0 ? `Entry points: ${overview.entryPoints.join(', ')}.` : '',
    overview.modules.length > 0
      ? `Modules: ${overview.modules.slice(0, 12).map((module) => `${module.name} (${module.files})`).join(', ')}.`
      : '',
  ];
  return parts.filter((part) => part.length > 0).join('\n');
}
