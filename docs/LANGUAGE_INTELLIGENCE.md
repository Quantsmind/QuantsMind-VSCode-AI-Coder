# Language intelligence — v2.5.4

QuantsMind does not train or fine-tune models. This page documents what the
**extension** understands: how it identifies the languages in a workspace,
how that information reaches context selection and prompts, and what it does
not do.

## What is implemented

- A **language capability registry** (`src/languages/registry.ts`) — one
  definition per language family with extensions, manifests, prompt guidance,
  testing expectations and honest qualification levels.
- A **workspace language inventory** (`src/languages/inventory.ts`) — a
  bounded, deterministic, content-free count of language families in the
  workspace, distinguishing primary from supporting languages, with
  detection-quality reporting (`confident` / `partial` / `unknown`).
- **Language-adaptive prompts** — the coding agent's system prompt carries a
  short, evidence-based section naming the primary language, relevant
  secondary languages, detected tooling and an explicit uncertainty note when
  detection is partial or unknown. The chat prompt carries a bounded
  active-document section when a document is open.
- **Cross-language relationship awareness** (`src/languages/relationships.ts`) —
  deterministic pairings (shared API contracts, SQL schema ↔ models,
  frontend clients ↔ backend routes, build files ↔ compiled sources) that
  feed context selection with an explicit, labelled reason. Selection never
  silently edits anything.
- **Context selection** — the repository context selector accepts the
  relations; cross-language neighbours of high-scoring files gain bounded
  score and an explicit `cross-language` relationship with reasons and
  confidence. They cannot outrank direct path/symbol matches and never
  bypass token budgets or character caps.

## Supported language families and qualification levels

| Family | Extensions | Qualification |
|---|---|---|
| TypeScript | ts, tsx, mts, cts, d.ts | analysis |
| JavaScript | js, jsx, mjs, cjs | analysis |
| Python | py, pyi | analysis |
| Java | java | analysis |
| C | c, h | analysis |
| C++ | cc, cpp, cxx, hh, hpp, hxx | analysis |
| Karkain | kark | analysis |
| Go | go | analysis |
| C# | cs, csx | detection |
| Rust | rs | detection |
| PHP | php, phtml | detection |
| Ruby | rb, rake, gemspec | detection |
| Kotlin | kt, kts | detection |
| Swift | swift | detection |
| SQL | sql | detection |
| HTML/CSS/Web | html, htm, css, scss, sass, less | detection |
| Shell | sh, bash, zsh, fish, ash, ksh | detection |
| YAML | yaml, yml | detection |
| JSON | json, jsonc, json5 | detection |
| TOML | toml | detection |

- **analysis** — files are parsed by the lightweight symbols layer
  (declarations, imports, exports) to feed context selection and relations.
- **detection** — the family is recognised by extension/manifests and gets
  prompt guidance; no symbol analysis is performed.
- Unknown extensions degrade gracefully: they are ignored by the inventory
  and are never errors. Unsupported or unrecognized active files produce a
  single explicit line in prompts ("treat conventions as unknown") instead of
  invented advice.

## Workspace detection and inventory behavior

- Detection uses **file extensions and manifest file names only**; file
  contents are never read for inventory purposes (markers are reported by
  path, not by content).
- Default bounded scan: at most 10,000 entries are considered, at most 5 MB
  per file is eligible, at most 32 languages are reported. Oversized or
  out-of-bound entries are skipped, and `truncated: true` is reported when
  the entry bound is hit.
- Vendored/generated/foreign directories are skipped (including
  `node_modules`, `dist`, `out`, `build`, `target`, `vendor`, `third_party`,
  `.venv`, `__pycache__`, VCS internals).
- The primary language is the dominant `source` or `query` family by file
  count (smallest ties broken deterministically); everything else is
  *supporting*. Detection is `confident` when the primary language has at
  least 3 files, `partial` otherwise or when only non-source files were
  recognized, and `unknown` when no registry-matched file exists.
- The repository overview (`get_repository_overview`) reports
  `languageDetection`, `primaryLanguage` and `supportingLanguages` alongside
  the existing technologies list.
- The self-diagnostics report includes the same inventory plus whether the
  language-intelligence setting is enabled — never file contents.

### Caching and invalidation

`cachedLanguageInventory(entries)` memoizes on a signature of every
(path, size) pair: any add/remove/rename/resize invalidates automatically.
The cache is bounded to 8 entries and is cleared by
`__clearLanguageInventoryCache()` in tests. `repositoryIntelligence` builds
the inventory from the same entry set it already indexes, so it follows the
indexer's existing invalidation (workspace-change events) too.

## Context selection and prompt adaptation

- The active authoring file is the strongest context signal; the chat path
  also receives a bounded (≤ 600 chars) active-language guidance block.
- The coding agent system prompt gains a language block (≤ ~2,400 chars,
  deterministic) with the primary language, up to 3 secondary languages,
  testing hints and the uncertainty note when relevant.
- `select_repository_context` labels cross-language neighbours as
  `cross-language` with reasons and confidence; they rank below direct
  path/symbol matches and outside direct dependencies' influence tier.

## Cross-language task awareness

Examples the extension now handles deterministically (heuristic labels are
used honestly; nothing is edited automatically):

- TypeScript client calling into a Java/Python/Go service — `src/api/…` ↔
  `routes/…`/`controllers/…` pairs sharing a path token are linked.
- SQL schema ↔ application models — `CREATE TABLE` names are matched to model
  classes across TS/JS/Java/Python/Kotlin/Ruby/Swift/PHP (plural↔singular
  tolerant); when contents were not read, path tokens pair `*.sql` with
  model-ish files (`src/models/…`).
- Shared API contracts — `.proto`/`.graphql`/`.thrift`/`.wsdl`/`.xsd` and
  openapi/swagger manifests are paired with files importing them (confirmed)
  or co-located bindings in another language (heuristic).
- Compiled languages — C/C++ sources in a tree are paired with its
  `CMakeLists.txt`/`Makefile`/Gradle files.

## Configuration

- `quantsmind.languageIntelligence.enabled` (application scope, default
  `true`): master switch for language-adaptive prompts and the inventory's
  use in the coding agent, chat and repository tooling. Setting it to `false`
  restores the generic prompts and path-only ranking. Nothing is sent to
  any external service either way; the analysis is local and deterministic.

No other settings were added; existing users need not migrate anything.

## Performance limits and privacy

- Inventory: content-free (extensions/paths only); 10k entry cap, 5 MB file
  cap, 32 language cap, 8-entry cache.
- Relations: bounded to 20 per selection query; token tables per path are
  cached per call.
- Prompts: language guidance ≤ 2,000 chars; chat block ≤ 600 chars.
- Exclusions: vendored/generated/VCS paths skipped; secrets are never read
  or echoed by any of these paths (inventory never opens files).
- Workspace trust gates all on-disk access exactly as before; the inventory
  is computed from the already-trusted, already-indexed entry list.

## Known limitations

- Detection is extension-based; misnamed or extension-less files (e.g.
  `Dockerfile`) are ignored by the inventory (the `dockerfile`/`makefile`
  build systems are still recognised by the existing build adapter layer).
- No compiler, language server or type checker is involved; guidance is
  convention text, not verified advice.
- SQL relation extraction is minimal (`CREATE TABLE` only); dialects with
  exotic quoting may miss matches — the relation is simply absent, never
  wrong.
- Cross-language linking is heuristic for clients/servers; a shared token
  is required. False negatives are common by design; false positives are
  labelled `heuristic`.
- `.d.ts` is folded into TypeScript; config families (YAML/JSON/TOML) are
  detection-only and do not produce relations.
- Language detection does not change provider capabilities: models are not
  fine-tuned and nothing here proves the underlying model "knows" a language.
