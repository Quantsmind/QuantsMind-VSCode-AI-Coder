# Project intelligence

Project intelligence gives the planner a compact, local description of the
workspace before any provider request. It is implemented in
`src/project/intelligence.ts` and backed by `src/workspace/analyze.ts` and
`src/workspace/indexService.ts`.

## Principles

- **Local first.** Inspection consumes the workspace index and, at most, the
  contents of one `package.json`. No source file is sent during inspection.
- **Deterministic.** The same file list and manifest produce the same
  `ProjectContext`.
- **Untrusted input.** `package.json` is parsed as JSON with strict guards; a
  malformed manifest is a fact, not a crash.
- **Bounded.** Config files, facts, modules and scripts are capped, and strings
  are clamped before they can enter a prompt.

## What is detected

| Fact | Source |
| --- | --- |
| Languages and file counts | File extensions in the local index |
| Package manager | `pnpm-lock.yaml`, `yarn.lock`, `bun.lock(b)`, `package-lock.json`; npm assumed when only `package.json` exists |
| Scripts | `package.json` `scripts` with valid names and string values |
| Dependency counts and names | `package.json` `dependencies` and `devDependencies` (names only) |
| Configuration files | `tsconfig`, ESLint, Prettier, test runners, bundlers, CI workflows, Docker, Make, Python, Rust, Go, Java, .NET, Composer, Ruby and toolchain files |
| Modules | Top-level directories with file counts |
| Entry points | Conventional names such as `src/extension.ts`, `src/index.ts`, `src/main.ts`, `main.py` |
| Test files | Conventional test/spec paths |

## The `ProjectContext` object

```ts
interface ProjectContext {
  readonly rootName: string;
  readonly languages: readonly TechnologyLike[];
  readonly packageManager?: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly configFiles: readonly string[];
  readonly modules: readonly ModuleSummary[];
  readonly entryPoints: readonly string[];
  readonly testFiles: number;
  readonly facts: readonly ContextFact[];
  readonly summaryText: string;
}
```

`ContextFact` is `{ fact, path? }`. The optional path points at the workspace
file that produced the fact, which is how the UI can explain where a statement
came from.

The summary text is capped at 6,000 characters and is labelled as local
analysis in the planning prompt.

## Architecture analysis

The extension builds a source-based architecture view, implemented in
`src/project/architecture.ts` and backed by the repository intelligence
pipeline (`src/repository/repositoryIntelligence.ts`), which analyzes source
files with `src/repository/symbols.ts` and links them with
`src/repository/graph.ts`.

The analysis classifies every analyzed file into an architectural layer from
its path, its analyzed imports and the frameworks detected for the workspace:

| Layer | Meaning |
| --- | --- |
| `backend` | Server-side code: controllers, services, repositories, models, DTOs, database access, native sources |
| `frontend` | Client-side code: components, routes, hooks and page files of detected frontend frameworks |
| `shared` | Libraries and common code reused across layers |
| `unknown` | No reliable evidence either way |

Files are also assigned roles from their path segments (nearest segment to
the file wins) and names: `controller`, `service`, `repository`, `model`,
`dto`, `database`, `component`, `route`, `hook`, `config`, `test`, `module`.
Relationships come from the dependency graph: `imports`, plus `uses` when a
controller depends on a service or repository, or a service on a repository,
and `renders`/`routes-to` for frontend component wiring.

Framework detection reports Spring Boot, Angular, React, Next.js, Vue,
Svelte, Django, Flask, FastAPI, Express, NestJS, Gin and others, from manifest
contents, gated on the workspace actually containing the ecosystem's
language. Monorepositories and multi-module builds are detected from
`package.json` `workspaces`, `pnpm-workspace.yaml`, `turbo.json`, `nx.json`,
`lerna.json` and nested build manifests (`pom.xml`, `build.gradle`, `go.mod`,
`Cargo.toml`, `CMakeLists.txt`).

The architecture view, the module graph and the Karkain view are reported
through the existing webview by the "Repository intelligence" action; no
separate tool or panel was added.

## Karkain intelligence

The extension has first-class support for the Karkain language (`.kark`).
The grammar was taken from the language's own compiler (`pkg/lexer`,
`pkg/parser` and `pkg/module` in the Karkain repository), not from memory:

- `.kark` files are indexed as the `karkain` language and analyzed with the
  shared source analyzer, which reads `func`, `kernel`, `type ... struct`,
  `enum`, `type`, `actor` and `public` visibility, `let`/`var`/`const`, and
  `import module.path` declarations, with nested block comments and string
  literals masked first.
- Project detection recognizes `karkain.toml` and `.kark` sources.
- The module graph resolves `std.*` imports to `stdlib/<module>(.kark|/...)`
  and other imports to sibling `<name>.kark` files or sibling `<name>/`
  directories, reports unresolvable imports, detects import cycles and emits a
  deterministic, dependency-first order.
- `get_karkain_project`, `get_karkain_context` and `get_architecture` agent
  tools expose the same data to the coding agent, so Karkain-aware planning
  happens through the existing tool registry.

### Limits

- Karkain analysis is syntax-aware but deliberately not the full compiler:
  no borrow checking, type checking or diagnostics.
- The agent's Karkain view is built from the files a change can touch; very
  large Karkain trees are capped by the repository analysis limits.

## ProjectContext after v2.2.0

`ProjectContext` (`analyzeProject`) is unchanged: it consumes paths plus one
parsed `package.json`. For deeper evidence, the planner and the agent use the
architecture view and repository intelligence described above.

## Retrieval

Inspection describes the project; retrieval supplies *content* for a specific
requirement or task.

- `WorkspaceIndexService` indexes workspace paths with built-in exclusions,
  user globs, `.gitignore` and `.git/info/exclude`.
- Retrieval ranks candidate files lexically and by metadata, then reads and
  filters them through the same local context pipeline used by chat
  attachments.
- The content budget is
  `min(quantsmind.workspace.retrievalMaxChars, quantsmind.context.maxTotalChars)`.
- Files that are binary, empty, too large, secret-like or excluded are skipped
  with a reason.
- Retrieved content is redacted and wrapped in `<workspace_context>` as
  untrusted data before it enters a provider request.

The agent calls retrieval twice: once against the requirement to support
planning, and once per task using the task title, description and suggested
files.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `quantsmind.workspace.maxIndexedFiles` | `5000` | Index cap |
| `quantsmind.workspace.maxRetrievedFiles` | `8` | Files per retrieval |
| `quantsmind.workspace.retrievalMaxChars` | `40000` | Retrieval content budget |
| `quantsmind.context.maxTotalChars` | `48000` | Global context budget |
| `quantsmind.context.excludeGlobs` | `[]` | Additional exclusions |
| `quantsmind.context.maxFileSizeKb` | `256` | Per-file size limit |

## Limits

- Retrieval ranking is lexical; repository intelligence adds symbol and
  dependency evidence for selection and impact, but there is no embedding
  index.
- Only one manifest (`package.json`) is parsed; other ecosystems contribute
  configuration paths but not parsed metadata.
- Monorepos are indexed as one tree; there is no per-package planning.
- The index is bounded and may omit files beyond the configured cap.
