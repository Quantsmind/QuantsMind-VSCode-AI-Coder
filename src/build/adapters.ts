import type { WorkspaceEntry } from '../workspace/analyze';
import { normalizeWorkspacePath } from '../workspace/analyze';
import type { BuildAdapter, BuildAdapterDetection, DetectedFramework } from './types';

function hasPath(entries: readonly WorkspaceEntry[], pattern: RegExp): boolean {
  return entries.some((entry) => pattern.test(normalizeWorkspacePath(entry.path)));
}

function firstPath(entries: readonly WorkspaceEntry[], pattern: RegExp): string | undefined {
  for (const entry of entries) {
    const path = normalizeWorkspacePath(entry.path);
    if (pattern.test(path)) {
      return path;
    }
  }
  return undefined;
}

function contentsOf(
  configContents: Readonly<Record<string, string>>,
  baseName: string,
): string | undefined {
  for (const [path, content] of Object.entries(configContents)) {
    const normalized = normalizeWorkspacePath(path).toLowerCase();
    if (normalized === baseName || normalized.endsWith(`/${baseName}`)) {
      return content;
    }
  }
  return undefined;
}

function hasConfig(configContents: Readonly<Record<string, string>>, baseName: string): boolean {
  return contentsOf(configContents, baseName) !== undefined;
}

function karkEntryPoint(entries: readonly WorkspaceEntry[]): string | undefined {
  const main = firstPath(entries, /^main\.kark$/i) ?? firstPath(entries, /^src\/main\.kark$/i);
  if (main !== undefined) {
    return main;
  }
  const files = entries
    .map((entry) => normalizeWorkspacePath(entry.path))
    .filter((path) => path.toLowerCase().endsWith('.kark'))
    .sort((left, right) => left.localeCompare(right));
  return files[0];
}

const adapters: BuildAdapter[] = [
  {
    id: 'karkain',
    ecosystem: 'Karkain',
    languages: ['karkain'],
    configFiles: ['karkain.toml'],
    toolchain: { name: 'karkain', executable: 'karkain', versionArgs: ['--version'] },
    detect: (entries) =>
      hasPath(entries, /^karkain\.toml$/i) || hasPath(entries, /\/karkain\.toml$/i) || hasPath(entries, /\.kark$/i),
    buildCommands: (context) => [`karkain build ${context?.karkainEntry ?? 'main.kark'}`],
    testCommands: () => ['karkain test .'],
    testOutputFormat: 'karkain',
  },
  {
    id: 'maven',
    ecosystem: 'Java (Maven)',
    languages: ['java'],
    configFiles: ['pom.xml'],
    toolchain: { name: 'maven', executable: 'mvn', versionArgs: ['--version'] },
    detect: (entries) => hasPath(entries, /(^|\/)pom\.xml$/i),
    buildCommands: () => ['mvn -q package'],
    testCommands: () => ['mvn -q test'],
    testOutputFormat: 'junit',
  },
  {
    id: 'gradle',
    ecosystem: 'Java (Gradle)',
    languages: ['java', 'kotlin'],
    configFiles: ['build.gradle', 'build.gradle.kts'],
    toolchain: { name: 'gradle', executable: 'gradle', versionArgs: ['--version'] },
    detect: (entries) => hasPath(entries, /(^|\/)build\.gradle(\.kts)?$/i),
    buildCommands: () => ['gradle build'],
    testCommands: () => ['gradle test'],
    testOutputFormat: 'junit',
  },
  {
    id: 'npm',
    ecosystem: 'Node.js (npm)',
    languages: ['typescript', 'javascript'],
    configFiles: ['package.json'],
    toolchain: { name: 'npm', executable: 'npm', versionArgs: ['--version'] },
    detect: (entries, configContents) =>
      hasPath(entries, /(^|\/)package\.json$/i) &&
      !hasPath(entries, /(^|\/)(pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pnpm-workspace\.ya?ml)$/i) &&
      !hasConfig(configContents, 'pnpm-lock.yaml'),
    buildCommands: () => ['npm run build'],
    testCommands: () => ['npm test'],
    testOutputFormat: 'node',
  },
  {
    id: 'pnpm',
    ecosystem: 'Node.js (pnpm)',
    languages: ['typescript', 'javascript'],
    configFiles: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    toolchain: { name: 'pnpm', executable: 'pnpm', versionArgs: ['--version'] },
    detect: (entries, configContents) =>
      hasPath(entries, /(^|\/)(pnpm-lock\.yaml|pnpm-workspace\.ya?ml)$/i) || hasConfig(configContents, 'pnpm-lock.yaml'),
    buildCommands: () => ['pnpm build'],
    testCommands: () => ['pnpm test'],
    testOutputFormat: 'node',
  },
  {
    id: 'yarn',
    ecosystem: 'Node.js (Yarn)',
    languages: ['typescript', 'javascript'],
    configFiles: ['package.json', 'yarn.lock'],
    toolchain: { name: 'yarn', executable: 'yarn', versionArgs: ['--version'] },
    detect: (entries) => hasPath(entries, /(^|\/)yarn\.lock$/i),
    buildCommands: () => ['yarn build'],
    testCommands: () => ['yarn test'],
    testOutputFormat: 'node',
  },
  {
    id: 'pip',
    ecosystem: 'Python (pip)',
    languages: ['python'],
    configFiles: ['requirements.txt', 'setup.py', 'setup.cfg'],
    toolchain: { name: 'python', executable: 'python', versionArgs: ['--version'] },
    detect: (entries) =>
      hasPath(entries, /(^|\/)(requirements[^/]*\.txt|setup\.py|setup\.cfg)$/i),
    buildCommands: () => [],
    testCommands: () => ['python -m pytest'],
    testOutputFormat: 'pytest',
  },
  {
    id: 'poetry',
    ecosystem: 'Python (Poetry)',
    languages: ['python'],
    configFiles: ['pyproject.toml', 'poetry.lock'],
    toolchain: { name: 'poetry', executable: 'poetry', versionArgs: ['--version'] },
    detect: (entries, configContents) =>
      (contentsOf(configContents, 'pyproject.toml')?.includes('[tool.poetry]') ?? false) || hasPath(entries, /(^|\/)poetry\.lock$/i),
    buildCommands: () => ['poetry install'],
    testCommands: () => ['poetry run pytest'],
    testOutputFormat: 'pytest',
  },
  {
    id: 'uv',
    ecosystem: 'Python (uv)',
    languages: ['python'],
    configFiles: ['uv.lock', 'pyproject.toml'],
    toolchain: { name: 'uv', executable: 'uv', versionArgs: ['--version'] },
    detect: (entries) => hasPath(entries, /(^|\/)uv\.lock$/i),
    buildCommands: () => ['uv sync'],
    testCommands: () => ['uv run pytest'],
    testOutputFormat: 'pytest',
  },
  {
    id: 'hatch',
    ecosystem: 'Python (Hatch)',
    languages: ['python'],
    configFiles: ['pyproject.toml'],
    toolchain: { name: 'hatch', executable: 'hatch', versionArgs: ['--version'] },
    detect: (_entries, configContents) => contentsOf(configContents, 'pyproject.toml')?.includes('[tool.hatch]') ?? false,
    buildCommands: () => ['hatch env create'],
    testCommands: () => ['hatch run test'],
    testOutputFormat: 'pytest',
  },
  {
    id: 'go',
    ecosystem: 'Go',
    languages: ['go'],
    configFiles: ['go.mod', 'go.sum'],
    toolchain: { name: 'go', executable: 'go', versionArgs: ['version'] },
    detect: (entries) => hasPath(entries, /(^|\/)go\.mod$/i),
    buildCommands: () => ['go build ./...'],
    testCommands: () => ['go test ./...'],
    testOutputFormat: 'go',
  },
  {
    id: 'cargo',
    ecosystem: 'Rust (Cargo)',
    languages: ['rust'],
    configFiles: ['Cargo.toml', 'Cargo.lock'],
    toolchain: { name: 'cargo', executable: 'cargo', versionArgs: ['--version'] },
    detect: (entries) => hasPath(entries, /(^|\/)(Cargo\.toml|Cargo\.lock)$/i),
    buildCommands: () => ['cargo build'],
    testCommands: () => ['cargo test'],
    testOutputFormat: 'cargo',
  },
  {
    id: 'cmake',
    ecosystem: 'C/C++ (CMake)',
    languages: ['c', 'cpp'],
    configFiles: ['CMakeLists.txt'],
    toolchain: { name: 'cmake', executable: 'cmake', versionArgs: ['--version'] },
    detect: (entries) => hasPath(entries, /(^|\/)CMakeLists\.txt$/i),
    buildCommands: () => ['cmake -S . -B build', 'cmake --build build'],
    testCommands: () => ['ctest --test-dir build --output-on-failure'],
    testOutputFormat: 'ctest',
  },
  {
    id: 'make',
    ecosystem: 'C/C++ (Make)',
    languages: ['c', 'cpp'],
    configFiles: ['Makefile', 'makefile'],
    toolchain: { name: 'make', executable: 'make', versionArgs: ['--version'] },
    detect: (entries) => hasPath(entries, /(^|\/)makefile$/i),
    buildCommands: () => ['make'],
    testCommands: () => ['make test'],
    testOutputFormat: 'unknown',
  },
  {
    id: 'ninja',
    ecosystem: 'C/C++ (Ninja)',
    languages: ['c', 'cpp'],
    configFiles: ['build.ninja'],
    toolchain: { name: 'ninja', executable: 'ninja', versionArgs: ['--version'] },
    detect: (entries) => hasPath(entries, /(^|\/)build\.ninja$/i),
    buildCommands: () => ['ninja'],
    testCommands: () => [],
    testOutputFormat: 'unknown',
  },
  {
    id: 'dotnet',
    ecosystem: 'C#/.NET (dotnet)',
    languages: ['csharp'],
    configFiles: ['.csproj', '.sln'],
    toolchain: { name: 'dotnet', executable: 'dotnet', versionArgs: ['--version'] },
    detect: (entries) => hasPath(entries, /\.(csproj|sln)$/i),
    buildCommands: () => ['dotnet build'],
    testCommands: () => ['dotnet test'],
    testOutputFormat: 'dotnet',
  },
  {
    id: 'msbuild',
    ecosystem: 'C#/.NET (MSBuild)',
    languages: ['csharp'],
    configFiles: ['.sln', '.csproj'],
    toolchain: { name: 'msbuild', executable: 'msbuild', versionArgs: ['-version'] },
    detect: (entries) =>
      hasPath(entries, /\.sln$/i) && hasPath(entries, /\.(cs|vb)proj$/i),
    buildCommands: () => ['msbuild'],
    testCommands: () => [],
    testOutputFormat: 'unknown',
  },
  {
    id: 'composer',
    ecosystem: 'PHP (Composer)',
    languages: ['php'],
    configFiles: ['composer.json'],
    toolchain: { name: 'composer', executable: 'composer', versionArgs: ['--version'] },
    detect: (entries) => hasPath(entries, /(^|\/)composer\.json$/i),
    buildCommands: () => ['composer install'],
    testCommands: () => ['composer test'],
    testOutputFormat: 'phpunit',
  },
  {
    id: 'bundler',
    ecosystem: 'Ruby (Bundler)',
    languages: ['ruby'],
    configFiles: ['Gemfile', 'Gemfile.lock'],
    toolchain: { name: 'bundle', executable: 'bundle', versionArgs: ['--version'] },
    detect: (entries) => hasPath(entries, /(^|\/)Gemfile(\.lock)?$/i),
    buildCommands: () => ['bundle install'],
    testCommands: () => ['bundle exec rspec'],
    testOutputFormat: 'rspec',
  },
  {
    id: 'dart',
    ecosystem: 'Dart',
    languages: ['dart'],
    configFiles: ['pubspec.yaml'],
    toolchain: { name: 'dart', executable: 'dart', versionArgs: ['--version'] },
    detect: (entries, configContents) =>
      (hasPath(entries, /(^|\/)pubspec\.yaml$/i) || hasConfig(configContents, 'pubspec.yaml')) &&
      !(contentsOf(configContents, 'pubspec.yaml')?.includes('flutter:') ?? false),
    buildCommands: () => ['dart pub get'],
    testCommands: () => ['dart test'],
    testOutputFormat: 'dart',
  },
  {
    id: 'flutter',
    ecosystem: 'Flutter/Dart',
    languages: ['dart'],
    configFiles: ['pubspec.yaml'],
    toolchain: { name: 'flutter', executable: 'flutter', versionArgs: ['--version'] },
    detect: (entries, configContents) =>
      (hasPath(entries, /(^|\/)pubspec\.yaml$/i) || hasConfig(configContents, 'pubspec.yaml')) &&
      (contentsOf(configContents, 'pubspec.yaml')?.includes('flutter:') ?? false),
    buildCommands: () => ['flutter pub get'],
    testCommands: () => ['flutter test'],
    testOutputFormat: 'dart',
  },
  {
    id: 'swift',
    ecosystem: 'Swift (SPM)',
    languages: ['swift'],
    configFiles: ['Package.swift'],
    toolchain: { name: 'swift', executable: 'swift', versionArgs: ['--version'] },
    detect: (entries) => hasPath(entries, /(^|\/)Package\.swift$/i),
    buildCommands: () => ['swift build'],
    testCommands: () => ['swift test'],
    testOutputFormat: 'swift',
  },
];

export const BUILD_ADAPTERS: readonly BuildAdapter[] = Object.freeze(adapters);

/** Exposed for the Karkain adapter entry-point resolution. */
export function resolveKarkainEntry(entries: readonly WorkspaceEntry[]): string | undefined {
  return karkEntryPoint(entries);
}

/** The adapters whose detection rules match the current index. */
export function detectBuildAdapters(
  entries: readonly WorkspaceEntry[],
  configContents: Readonly<Record<string, string>> = {},
): BuildAdapterDetection[] {
  const detections: BuildAdapterDetection[] = [];
  for (const adapter of adapters) {
    if (adapter.detect(entries, configContents)) {
      const configFile = adapter.configFiles[0] ?? 'unknown';
      detections.push({ adapter, configFile });
    }
  }
  return detections;
}

/** Lightweight summary for prompts and the repository overview. */
export function describeDetectedFrameworks(detections: readonly BuildAdapterDetection[]): DetectedFramework[] {
  return detections.map(({ adapter, configFile }) => ({
    id: adapter.id,
    ecosystem: adapter.ecosystem,
    languages: adapter.languages,
    configFile,
  }));
}
