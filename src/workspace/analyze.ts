export interface WorkspaceEntry {
  readonly path: string;
  readonly size?: number;
}

export interface Technology {
  readonly name: string;
  readonly kind: 'language' | 'tooling' | 'framework';
  readonly evidence: string;
  readonly files: number;
}

export interface WorkspaceSummary {
  readonly rootName: string;
  readonly fileCount: number;
  readonly technologies: readonly Technology[];
  readonly topLevel: readonly { readonly name: string; readonly files: number }[];
  readonly entryPoints: readonly string[];
  readonly testFiles: number;
  readonly text: string;
}

export interface RelevantFile {
  readonly path: string;
  readonly score: number;
  readonly reason: string;
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  cs: 'C#',
  fs: 'F#',
  rb: 'Ruby',
  php: 'PHP',
  c: 'C',
  h: 'C',
  cc: 'C++',
  cpp: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  swift: 'Swift',
  scala: 'Scala',
  sh: 'Shell',
  bash: 'Shell',
  ps1: 'PowerShell',
  sql: 'SQL',
  vue: 'Vue',
  svelte: 'Svelte',
  dart: 'Dart',
  lua: 'Lua',
  r: 'R',
  ex: 'Elixir',
  exs: 'Elixir',
  zig: 'Zig',
};

interface Marker {
  readonly test: (path: string) => boolean;
  readonly name: string;
  readonly kind: Technology['kind'];
}

const MARKERS: readonly Marker[] = [
  { test: (p) => baseName(p) === 'package.json', name: 'Node.js', kind: 'tooling' },
  { test: (p) => baseName(p) === 'package-lock.json', name: 'npm', kind: 'tooling' },
  { test: (p) => baseName(p) === 'yarn.lock', name: 'Yarn', kind: 'tooling' },
  { test: (p) => baseName(p) === 'pnpm-lock.yaml', name: 'pnpm', kind: 'tooling' },
  { test: (p) => baseName(p) === 'tsconfig.json', name: 'TypeScript', kind: 'tooling' },
  { test: (p) => baseName(p) === 'go.mod', name: 'Go modules', kind: 'tooling' },
  { test: (p) => baseName(p) === 'Cargo.toml', name: 'Cargo', kind: 'tooling' },
  { test: (p) => baseName(p) === 'pyproject.toml', name: 'Python packaging', kind: 'tooling' },
  { test: (p) => baseName(p) === 'requirements.txt', name: 'pip', kind: 'tooling' },
  { test: (p) => baseName(p) === 'Gemfile', name: 'Bundler', kind: 'tooling' },
  { test: (p) => baseName(p) === 'composer.json', name: 'Composer', kind: 'tooling' },
  { test: (p) => baseName(p) === 'pom.xml', name: 'Maven', kind: 'tooling' },
  { test: (p) => baseName(p) === 'build.gradle' || baseName(p) === 'build.gradle.kts', name: 'Gradle', kind: 'tooling' },
  { test: (p) => p.endsWith('.csproj') || p.endsWith('.sln'), name: '.NET', kind: 'tooling' },
  { test: (p) => baseName(p) === 'CMakeLists.txt', name: 'CMake', kind: 'tooling' },
  { test: (p) => baseName(p) === 'Makefile', name: 'Make', kind: 'tooling' },
  { test: (p) => baseName(p) === 'Dockerfile' || p.endsWith('/Dockerfile'), name: 'Docker', kind: 'tooling' },
  { test: (p) => /docker-compose\.ya?ml$/i.test(p), name: 'Docker Compose', kind: 'tooling' },
  { test: (p) => /^\.github\/workflows\//i.test(p), name: 'GitHub Actions', kind: 'tooling' },
  { test: (p) => /(^|\/)next\.config\.[cm]?[jt]s$/i.test(p), name: 'Next.js', kind: 'framework' },
  { test: (p) => /(^|\/)vite\.config\.[cm]?[jt]s$/i.test(p), name: 'Vite', kind: 'framework' },
  { test: (p) => /(^|\/)electron(?:-builder)?\.(?:json|ya?ml)$/i.test(p), name: 'Electron', kind: 'framework' },
  { test: (p) => /(^|\/)(jest|vitest)\.config\.[cm]?[jt]s$/i.test(p), name: 'JavaScript tests', kind: 'tooling' },
  { test: (p) => /(^|\/)(\.eslintrc|eslint\.config\.)/i.test(p), name: 'ESLint', kind: 'tooling' },
  { test: (p) => /(^|\/)playwright\.config\.[cm]?[jt]s$/i.test(p), name: 'Playwright', kind: 'tooling' },
];

const ENTRY_POINT_PATHS: readonly string[] = [
  'src/extension.ts',
  'src/main.ts',
  'src/index.ts',
  'src/app.ts',
  'src/index.js',
  'src/main.js',
  'index.ts',
  'index.js',
  'main.ts',
  'main.js',
  'main.py',
  'app.py',
  'manage.py',
  'main.go',
  'src/main.rs',
  'src/main.go',
  'Program.cs',
];

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'into',
  'please',
  'make',
  'add',
  'fix',
  'update',
  'change',
  'code',
  'file',
  'files',
  'workspace',
  'project',
  'can',
  'you',
  'use',
  'using',
]);

export function normalizeWorkspacePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '')
    .trim();
}

function baseName(path: string): string {
  const segments = path.split('/');
  return segments[segments.length - 1] ?? path;
}

function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function isTestPath(path: string): boolean {
  return (
    /(^|\/)(__tests__|tests?|specs?)\//i.test(path) ||
    /\.(test|spec)\.[^/]+$/i.test(path) ||
    /(^|\/)(test|spec)_[^/]+\.py$/i.test(path)
  );
}

export function entryPointsOf(entries: readonly WorkspaceEntry[]): string[] {
  const byPath = new Map(entries.map((entry) => [normalizeWorkspacePath(entry.path), entry.path]));
  const result: string[] = [];
  for (const candidate of ENTRY_POINT_PATHS) {
    const match = byPath.get(candidate);
    if (match !== undefined && !result.includes(match)) {
      result.push(match);
      if (result.length >= 8) {
        break;
      }
    }
  }
  return result;
}

export function detectTechnologies(entries: readonly WorkspaceEntry[]): Technology[] {
  const languages = new Map<string, number>();
  const tooling = new Map<string, string>();

  for (const entry of entries) {
    const path = normalizeWorkspacePath(entry.path);
    const language = LANGUAGE_BY_EXTENSION[extensionOf(path)];
    if (language !== undefined) {
      languages.set(language, (languages.get(language) ?? 0) + 1);
    }
    for (const marker of MARKERS) {
      if (!tooling.has(marker.name) && marker.test(path)) {
        tooling.set(marker.name, path);
      }
    }
  }

  const languageEntries = [...languages.entries()]
    .map<Technology>(([name, files]) => ({
      name,
      kind: 'language',
      evidence: `${files} source file${files === 1 ? '' : 's'}`,
      files,
    }))
    .sort((left, right) => right.files - left.files || left.name.localeCompare(right.name));

  const toolingEntries = [...tooling.entries()].map<Technology>(([name, evidence]) => ({
    name,
    kind: 'tooling',
    evidence,
    files: 1,
  }));

  return [...languageEntries, ...toolingEntries].slice(0, 16);
}

export function buildWorkspaceSummary(
  rootName: string,
  entries: readonly WorkspaceEntry[],
): WorkspaceSummary {
  const normalized = entries.map((entry) => ({
    path: normalizeWorkspacePath(entry.path),
    size: entry.size,
  }));
  const technologies = detectTechnologies(normalized);
  const entryPoints = entryPointsOf(normalized);

  const topLevelCounts = new Map<string, number>();
  for (const entry of normalized) {
    const segment = entry.path.split('/')[0] ?? entry.path;
    topLevelCounts.set(segment, (topLevelCounts.get(segment) ?? 0) + 1);
  }
  const topLevel = [...topLevelCounts.entries()]
    .map(([name, files]) => ({ name, files }))
    .sort((left, right) => right.files - left.files || left.name.localeCompare(right.name))
    .slice(0, 12);

  const testFiles = normalized.filter((entry) => isTestPath(entry.path)).length;
  const languages = technologies.filter((technology) => technology.kind === 'language');
  const tooling = technologies.filter((technology) => technology.kind !== 'language');

  const text = [
    `Workspace ${rootName}: ${normalized.length.toLocaleString()} indexed files.`,
    languages.length > 0
      ? `Languages: ${languages
          .slice(0, 6)
          .map((language) => `${language.name} (${language.files})`)
          .join(', ')}.`
      : 'Languages: none detected from file extensions.',
    tooling.length > 0
      ? `Project markers: ${tooling
          .slice(0, 10)
          .map((technology) => `${technology.name} (${technology.evidence})`)
          .join(', ')}.`
      : 'Project markers: none detected.',
    `Top-level entries: ${topLevel.map((item) => `${item.name} (${item.files})`).join(', ')}.`,
    entryPoints.length > 0 ? `Likely entry points: ${entryPoints.join(', ')}.` : '',
    `Test files: ${testFiles}.`,
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  return {
    rootName,
    fileCount: normalized.length,
    technologies,
    topLevel,
    entryPoints,
    testFiles,
    text: text.slice(0, 4_000),
  };
}

function tokenizeQuery(query: string): string[] {
  const matches = query.match(/[A-Za-z0-9_$.-]{2,}/g) ?? [];
  const tokens = new Set<string>();
  for (const match of matches) {
    const lower = match.toLowerCase();
    if (STOP_WORDS.has(lower)) {
      continue;
    }
    tokens.add(lower);
    const camelParts = match.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? [];
    for (const part of camelParts) {
      const normalized = part.toLowerCase();
      if (normalized.length >= 3 && !STOP_WORDS.has(normalized)) {
        tokens.add(normalized);
      }
    }
  }
  return [...tokens].slice(0, 24);
}

export interface RankOptions {
  readonly maxFiles: number;
}

/**
 * Scores workspace paths against a user request. Only paths are inspected;
 * file contents are read later, and only for the selected files.
 */
export function rankRelevantFiles(
  query: string,
  entries: readonly WorkspaceEntry[],
  options: RankOptions,
): RelevantFile[] {
  const tokens = tokenizeQuery(query);
  const entryPointSet = new Set(entryPointsOf(entries));
  const wantsTests = tokens.some((token) => ['test', 'tests', 'spec', 'specs'].includes(token));
  const ranked: RelevantFile[] = [];

  for (const entry of entries) {
    const path = normalizeWorkspacePath(entry.path);
    const lowerPath = path.toLowerCase();
    const name = baseName(lowerPath);
    const language = LANGUAGE_BY_EXTENSION[extensionOf(lowerPath)]?.toLowerCase();

    let score = 0;
    const reasons: string[] = [];

    for (const token of tokens) {
      if (name.includes(token)) {
        score += 6;
        if (!reasons.includes('file name matches the request')) {
          reasons.push('file name matches the request');
        }
      } else if (lowerPath.includes(token)) {
        score += 3;
        if (!reasons.includes('path matches the request')) {
          reasons.push('path matches the request');
        }
      }
      if (language !== undefined && language.includes(token)) {
        score += 2;
        if (!reasons.includes('language matches the request')) {
          reasons.push('language matches the request');
        }
      }
    }

    if (entryPointSet.has(entry.path)) {
      score += 4;
      reasons.push('likely entry point');
    }
    if (isTestPath(path)) {
      score += wantsTests ? 3 : 1;
      reasons.push('test file');
    }
    if (entry.size !== undefined && entry.size > 200_000) {
      score -= 2;
    }

    if (score > 0) {
      ranked.push({ path: entry.path, score, reason: reasons.join(', ') || 'related file' });
    }
  }

  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      left.path.length - right.path.length ||
      left.path.localeCompare(right.path),
  );

  const selected = ranked.slice(0, Math.max(0, options.maxFiles));
  if (selected.length < Math.min(3, options.maxFiles)) {
    for (const entryPoint of entryPointsOf(entries)) {
      if (selected.length >= options.maxFiles) {
        break;
      }
      if (!selected.some((item) => item.path === entryPoint)) {
        selected.push({ path: entryPoint, score: 4, reason: 'likely entry point' });
      }
    }
  }

  return selected;
}
