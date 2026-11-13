/**
 * Central language capability registry for workspace intelligence.
 *
 * One definition per language family; everything else (inventory, prompt
 * guidance, diagnostics, context relations) reads this table instead of
 * scattering language-specific conditionals across the extension.
 *
 * Degradation contract: unknown languages and unlisted extensions are not
 * errors. Registry lookups return `undefined` and callers degrade to
 * generic behavior.
 *
 * Qualifications are honest about what exists in this codebase:
 * - `analysis` — symbols.ts parses declarations/imports for this family.
 * - `detection` — extensions and manifests are recognised; no symbol analysis.
 */
export type LanguageKind = 'source' | 'query' | 'markup' | 'script' | 'config';

export type LanguageQualification = 'analysis' | 'detection';

export interface LanguageCapability {
  /** Registry id; also the value stored in internal contexts. */
  readonly id: string;
  /** Human-readable display name. */
  readonly displayName: string;
  /** Lower-case extensions without the dot, including ambiguous ones. */
  readonly extensions: readonly string[];
  /** Exact file-name matchers (case-insensitive basenames), e.g. `Dockerfile`. Optional. */
  readonly filenames?: readonly string[];
  /** Broad family used to order inventory output. */
  readonly kind: LanguageKind;
  /** What this language supports in this codebase. */
  readonly qualification: LanguageQualification;
  /** Manifest/marker file names that indicate this language's ecosystem. */
  readonly manifests: readonly string[];
  /** 1–4 language-specific guidance bullets safe to place in prompts. */
  readonly guidance: readonly string[];
  /** Testing expectation the agent can rely on, when reliably known. */
  readonly testHint?: string;
  /** Known limitations of the registry entry (honesty over marketing). */
  readonly limitations: readonly string[];
}

export const LANGUAGE_REGISTRY: readonly LanguageCapability[] = Object.freeze([
  {
    id: 'typescript',
    displayName: 'TypeScript',
    extensions: ['ts', 'tsx', 'mts', 'cts', 'd.ts'],
    kind: 'source',
    qualification: 'analysis',
    manifests: ['package.json', 'tsconfig.json', 'jsconfig.json'],
    guidance: [
      'TypeScript is statically typed; prefer explicit types at module boundaries and for exported APIs.',
      'Keep `strict`-compatible code: no implicit `any`, no unchecked nulls at boundaries.',
      'Prefer named exports and small, single-responsibility modules.',
    ],
    testHint: 'Jest/Vitest-style `*.test.ts` or `*.spec.ts` next to the sources or under `test/` or `__tests__/`.',
    limitations: ['`d.ts` merges into TypeScript; `.d.ts` declaration parsing is shallow.'],
  },
  {
    id: 'javascript',
    displayName: 'JavaScript',
    extensions: ['js', 'jsx', 'mjs', 'cjs'],
    kind: 'source',
    qualification: 'analysis',
    manifests: ['package.json', 'jsconfig.json'],
    guidance: [
      'JavaScript is dynamically typed; keep JSDoc types at boundaries where the ecosystem uses them.',
      'CommonJS and ESM interop matters; match the module system already in the file.',
      'Prefer small modules with explicit exports over implicit globals.',
    ],
    testHint: 'Jest/Vitest-style `*.test.js` or `*.spec.js` under `test/`, `__tests__/` or beside sources.',
    limitations: ['Type inference is absent; behavior is only understood heuristically.'],
  },
  {
    id: 'python',
    displayName: 'Python',
    extensions: ['py', 'pyi'],
    kind: 'source',
    qualification: 'analysis',
    manifests: ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile'],
    guidance: [
      'Explain `__all__` precisely: it controls only which names are exported when another module does `from module import *`; it does not prevent module import-time side effects or restrict explicit imports. Explain `if __name__ == "__main__":` as the idiom for "only run when executed directly, not when imported".',
      'Respect PEP 8 layout and type hints at public boundaries where the codebase uses them.',
      'Virtual environments and dependency resolution matter; identify the packaging tool (pip/Poetry/uv) before suggesting installs.',
      'Prefer explicit imports and small, composable functions over deep class hierarchies.',
    ],
    testHint: 'pytest-style `test_*.py` / `*_test.py` under `tests/` with `conftest.py` when present.',
    limitations: ['Imports and decorators are parsed textually; metaprogramming is invisible.'],
  },
  {
    id: 'java',
    displayName: 'Java',
    extensions: ['java'],
    kind: 'source',
    qualification: 'analysis',
    manifests: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
    guidance: [
      'Cover interface members completely: abstract, default, static and private interface methods (Java 9+). Only unannotated interface methods are implicitly public and abstract; default/static methods carry implementations.',
      'Match the Java release in use: records, sealed hierarchies and pattern matching (instanceof/switch) are standard from Java 21; virtual threads (Thread.ofVirtual()) suit blocking-I/O concurrency and are not a substitute for CPU-bound parallelism. Watch for carrier-thread pinning inside synchronized blocks.',
      'Identify the build tool (Maven `pom.xml` vs Gradle) before suggesting compile or test commands.',
      'Prefer immutable value types (records are idiomatic since Java 16) and explicit constructors/factories at module boundaries.',
      'Java is statically typed and package-scoped; keep public APIs and package-private internals consistent.',
    ],
    testHint: 'JUnit suites under `src/test/java` mirroring `src/main/java`.',
    limitations: ['Annotation processing and generated sources are not modeled.'],
  },
  {
    id: 'c',
    displayName: 'C',
    extensions: ['c', 'h'],
    kind: 'source',
    qualification: 'analysis',
    manifests: ['CMakeLists.txt', 'Makefile'],
    guidance: [
      'C requires explicit ownership and bounds discipline; check every allocation and buffer size.',
      'Headers declare the ABI; keep declarations in `.h` files minimal and consistent with definitions.',
      'Treat compiler warnings as defects; avoid undefined behavior at the type level.',
    ],
    testHint: 'GoogleTest or CTest suites (`*_test.c`, `_tests` directories) or a project-specific runner.',
    limitations: ['Preprocessor macros and implicit promotions are opaque to the analyzer.'],
  },
  {
    id: 'cpp',
    displayName: 'C++',
    extensions: ['cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx'],
    kind: 'source',
    qualification: 'analysis',
    manifests: ['CMakeLists.txt', 'Makefile', 'vcpkg.json', 'conanfile.txt', 'conanfile.py'],
    guidance: [
      'C++ lifetime and ownership rules apply; prefer RAII and explicit value semantics.',
      'Match the standard in use (e.g. C++17/20) and avoid features beyond it in older trees.',
      'Headers declare the interface; keep definitions in translation units consistent with them.',
    ],
    testHint: 'GoogleTest/Catch2 suites under `test/` or `tests/`, commonly driven by CTest.',
    limitations: ['Templates are not instantiated in analysis; macro-generated code is invisible.'],
  },
  {
    id: 'csharp',
    displayName: 'C#',
    extensions: ['cs', 'csx'],
    kind: 'source',
    qualification: 'detection',
    manifests: ['*.csproj', '*.sln', 'Directory.Build.props', 'global.json', 'nuget.config'],
    guidance: [
      'C# is statically typed; keep nullable reference types and `async`/`await` flows consistent.',
      'Identify the target framework (`net8.0`, …) before suggesting SDK or language features.',
      'Prefer records and explicit interfaces for data crossing module boundaries.',
    ],
    testHint: 'xUnit/NUnit/MSTest projects under `test/`, usually `*.Tests.csproj`.',
    limitations: ['No symbol analysis; generated code and source generators are invisible.'],
  },
  {
    id: 'go',
    displayName: 'Go',
    extensions: ['go'],
    kind: 'source',
    qualification: 'analysis',
    manifests: ['go.mod', 'go.sum'],
    guidance: [
      'Go favors simple, explicit error handling; avoid swallowing errors and shadowed variables.',
      'Exported identifiers start with a capital; keep package APIs small and documented.',
      '`go test` is the standard; table-driven tests are the house style.',
    ],
    testHint: '`*_test.go` next to the package sources, run with `go test ./...`.',
    limitations: ['Generics and reflection are not instantiated in analysis.'],
  },
  {
    id: 'rust',
    displayName: 'Rust',
    extensions: ['rs'],
    kind: 'source',
    qualification: 'detection',
    manifests: ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'],
    guidance: [
      'Rust ownership and borrowing rules apply; do not fight the borrow checker — restructure ownership instead.',
      'Pattern match exhaustively and propagate errors with `?` instead of unwrapping in libraries.',
      'Match the edition and the workspace layout before suggesting features.',
    ],
    testHint: '`cargo test`; unit tests in `#[cfg(test)]` modules, integration tests in `tests/`.',
    limitations: ['No symbol analysis; macro-generated code and `cfg` branches are invisible.'],
  },
  {
    id: 'php',
    displayName: 'PHP',
    extensions: ['php', 'phtml'],
    kind: 'source',
    qualification: 'detection',
    manifests: ['composer.json', 'composer.lock'],
    guidance: [
      'PHP is dynamically typed with optional type declarations; keep parameter/return types explicit on new code.',
      'Composer maps autoloading; check `composer.json` before assuming class locations.',
      'Treat input as untrusted at every boundary and use parameterized queries for SQL.',
    ],
    testHint: 'PHPUnit suites in `tests/` with `phpunit.xml` when present.',
    limitations: ['No symbol analysis; runtime metaprogramming (mixins, magic methods) is invisible.'],
  },
  {
    id: 'ruby',
    displayName: 'Ruby',
    extensions: ['rb', 'rake', 'gemspec'],
    kind: 'source',
    qualification: 'detection',
    manifests: ['Gemfile', 'Gemfile.lock'],
    guidance: [
      'Ruby favors small objects and expressive names; keep public APIs narrow.',
      'Identify the framework (Rails, Sinatra) from `Gemfile` before proposing structure.',
      'Prefer explicit requires and dependency injection over global state.',
    ],
    testHint: 'RSpec (`spec/`) or Minitest (`test/`); check the Gemfile for the choice.',
    limitations: ['No symbol analysis; metaprogramming is invisible.'],
  },
  {
    id: 'kotlin',
    displayName: 'Kotlin',
    extensions: ['kt', 'kts'],
    kind: 'source',
    qualification: 'detection',
    manifests: ['build.gradle.kts', 'build.gradle', 'settings.gradle.kts'],
    guidance: [
      'Kotlin is statically typed with null safety; keep nullable types explicit at boundaries.',
      'Prefer immutable data classes and sealed hierarchies where the codebase uses them.',
      'Identify Gradle/Android layout from manifests before suggesting build or test commands.',
    ],
    testHint: 'JUnit/kotest suites under `src/test/kotlin` mirroring main sources.',
    limitations: ['No symbol analysis; compiler plugins and generated code are invisible.'],
  },
  {
    id: 'swift',
    displayName: 'Swift',
    extensions: ['swift'],
    kind: 'source',
    qualification: 'detection',
    manifests: ['Package.swift', '*.xcodeproj', '*.xcworkspace', 'project.pbxproj'],
    guidance: [
      'Swift is statically and optionally typed; prefer safe unwrapping and value types.',
      'Identify SwiftPM vs Xcode project layout from manifests before suggesting build steps.',
      'Respect actor/async concurrency boundaries rather than sprinkling locks.',
    ],
    testHint: 'XCTest suites in `Tests/` (SwiftPM) or `<Name>Tests/` targets.',
    limitations: ['No symbol analysis; property wrappers and macros are invisible.'],
  },
  {
    id: 'sql',
    displayName: 'SQL',
    extensions: ['sql'],
    kind: 'query',
    qualification: 'detection',
    manifests: ['schema.sql', 'flyway.conf', 'alembic.ini'],
    guidance: [
      'Schema changes are data changes; write migrations idempotently where the tool supports it.',
      'Keep table naming consistent with model classes (snake_case tables ↔ PascalCase models).',
      'Prefer explicit column lists and parameterized queries at application boundaries.',
    ],
    testHint: 'Schema tests via migration dry-runs or fixture databases; there is no universal test runner.',
    limitations: ['Dialect-specific syntax is parsed minimally (CREATE TABLE extraction only).'],
  },
  {
    id: 'web',
    displayName: 'HTML/CSS/Web',
    extensions: ['html', 'htm', 'css', 'scss', 'sass', 'less'],
    kind: 'markup',
    qualification: 'detection',
    manifests: ['angular.json', 'vite.config.ts', 'next.config.js', 'svelte.config.js'],
    guidance: [
      'Markup and styles are declarative; keep structure semantic and styles layered (layout → component).',
      'Treat templates as untrusted for injection: escape interpolated values.',
      'Keep design tokens/variables centralized rather than duplicating literals.',
    ],
    testHint: 'No universal runner; use component/browser tests where present (Playwright, Testing Library).',
    limitations: ['No symbol analysis; templating directives are not understood.'],
  },
  {
    id: 'shell',
    displayName: 'Shell',
    extensions: ['sh', 'bash', 'zsh', 'fish', 'ash', 'ksh'],
    kind: 'script',
    qualification: 'detection',
    manifests: ['.bashrc', '.zshrc', 'justfile', 'Taskfile.yml'],
    guidance: [
      'Quote every expansion; unquoted variables are the most common shell defect.',
      'Prefer `set -euo pipefail` (bash) and explicit exit codes for CI scripts.',
      'Keep scripts idempotent and side-effect-aware; avoid destructive defaults.',
    ],
    testHint: 'bats-core or shellspec suites when present; often absent — test by running in a scratch environment.',
    limitations: ['No symbol analysis; sourced files and subshells are not resolved.'],
  },
  {
    id: 'yaml',
    displayName: 'YAML',
    extensions: ['yaml', 'yml'],
    kind: 'config',
    qualification: 'detection',
    manifests: ['docker-compose.yml', 'docker-compose.yaml', '.github/workflows'],
    guidance: [
      'YAML is whitespace-significant; keep indentation consistent and never tabs.',
      'Anchors and merge keys reduce duplication but obscure structure; use them sparingly.',
      'Treat environment-specific values as configuration, not code.',
    ],
    testHint: 'No standard unit tests; validate with schema linters in CI when present.',
    limitations: ['Custom tag constructors are not understood.'],
  },
  {
    id: 'json',
    displayName: 'JSON',
    extensions: ['json', 'jsonc', 'json5'],
    kind: 'config',
    qualification: 'detection',
    manifests: ['package.json', 'tsconfig.json', '.babelrc'],
    guidance: [
      'JSON is strict; no comments (except jsonc), no trailing commas in strict files.',
      'Keep machine-consumed manifests stable — additive changes over renames.',
      'Sensitive values never belong here; use secret storage.',
    ],
    testHint: 'Schema validation (ajv-style) in CI where present.',
    limitations: ['jsonc/json5 are treated as JSON by the validator downstream.'],
  },
  {
    id: 'toml',
    displayName: 'TOML',
    extensions: ['toml'],
    kind: 'config',
    qualification: 'detection',
    manifests: ['pyproject.toml', 'Cargo.toml', 'karkain.toml', 'rust-toolchain.toml'],
    guidance: [
      'TOML is explicit and typed; prefer it for tool manifests where supported.',
      'Tables and arrays must keep consistent shapes; do not mix types across keys.',
    ],
    testHint: 'Tool-native validation (e.g. cargo/pip) rather than test suites.',
    limitations: ['No symbol analysis.'],
  },
  {
    id: 'karkain',
    displayName: 'Karkain',
    extensions: ['kark'],
    kind: 'source',
    qualification: 'analysis',
    manifests: ['karkain.toml'],
    guidance: [
      'Karkain is the project language; module imports (including std.*) and cross-file type usage must stay consistent with its module system.',
      'Respect the compiler-verified grammar instead of transcribing imperative patterns from other languages.',
    ],
    testHint: 'Karkain projects validate with their own toolchain (`kark build`); verify locally before claiming success.',
    limitations: ['The Karkain toolchain may be unavailable on this machine; do not claim compilation success without it.'],
  },
]);

const BY_ID = new Map(LANGUAGE_REGISTRY.map((entry) => [entry.id, entry]));

/** Capability record by id, or undefined for unknown languages. */
export function getLanguageCapability(id: string): LanguageCapability | undefined {
  return BY_ID.get(id.toLowerCase());
}

const BY_EXTENSION = new Map<string, LanguageCapability>();
for (const entry of LANGUAGE_REGISTRY) {
  for (const extension of entry.extensions) {
    // `d.ts`-style compound extensions win over their suffixes where present.
    if (!BY_EXTENSION.has(extension) || extension.includes('.')) {
      BY_EXTENSION.set(extension, entry);
    }
  }
}

function baseNameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

/**
 * Detects the registry language for a workspace-relative path, or undefined
 * for unknown languages. Extension matching is case-insensitive; filename
 * matchers (compound names such as `d.ts`) take precedence over plain
 * extension matching.
 */
export function detectLanguageForPath(path: string): LanguageCapability | undefined {
  const name = baseNameOf(path).toLowerCase();
  // Compound extension first (e.g. `foo.d.ts`).
  for (const entry of LANGUAGE_REGISTRY) {
    for (const extension of entry.extensions) {
      if (extension.includes('.') && name.endsWith(`.${extension}`)) {
        return entry;
      }
    }
  }
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  return BY_EXTENSION.get(name.slice(dot + 1));
}

/** Registry ids for all known language families. */
export function knownLanguageIds(): readonly string[] {
  return LANGUAGE_REGISTRY.map((entry) => entry.id);
}
