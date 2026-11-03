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

- Retrieval is lexical; there is no embedding index or symbol graph.
- Only one manifest (`package.json`) is parsed; other ecosystems contribute
  configuration paths but not parsed metadata.
- Monorepos are indexed as one tree; there is no per-package planning.
- The index is bounded and may omit files beyond the configured cap.
