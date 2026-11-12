# Known limitations

These are the boundaries of the v3.0.0 build. They are deliberate, not
undocumented behavior.

## Provider and model

- The OpenAI-compatible `/chat/completions` shape (OpenAI, OpenRouter-style
  routers, GitHub-compatible gateways, local OpenAI-compatible servers such as
  Ollama and LM Studio) and the Google Gemini protocol (`generativelanguage.
  googleapis.com`) are implemented. Provider SDKs, the Responses API, and native
  Anthropic SDKs are not implemented.
- Native tool calling is supported on OpenAI-compatible-class profiles with
  tool-capable model ids (for example, `gpt-4o-mini` and similar); the engine
  and orchestrator use approval-gated native tool calls there. Gemini does not
  advertise tool calling. Image inputs, audio, and other multimodal content are
  not supported. Tool-call responses on non-tool-capable models are rejected
  with an error, and no executable tool definitions are sent.
- The plan and change-set formats are strict JSON contracts. Models that cannot
  follow them produce an `invalid_response` or parse error. There is no general
  schema-repair loop beyond the bounded repair pass.
- Reasoning or hidden model output is not displayed.
- A live provider request requires a valid credential. CI never uses one; the
  two Pollinations live tests are pending unless the anonymous service is
  reachable.
- Capability flags are descriptive. `maxContextChars` is advisory; the
  extension does not provably enforce a provider's context window.

## Workspace intelligence

- Only one workspace root is indexed (the marker-scored selection from
  `src/workspace/rootPolicy.ts`). Multi-root workspaces are not fully indexed;
  the non-selected roots are never scanned.
- The index is path- and metadata-based. It does not build embeddings, a symbol
  graph, or a semantic code index.
- Retrieval is lexical ranking, not embedding similarity, so synonyms and
  conceptual matches can be missed.
- Very large repositories are truncated at `quantsmind.workspace.maxIndexedFiles`.
- Binary files are never read for context.
- `.gitignore` parsing covers common syntax but not every Git edge case.
- Files changed outside VS Code may not invalidate the cache immediately until
  the next file-system event or explicit refresh.
- Project intelligence detects facts; it does not verify that a declared script
  works or that a module boundary is correct.

## Planning and tasks

- A plan is capped at 20 tasks, 20 dependencies per task, 10 criteria per task,
  and 20 suggested files per task. The requirement is capped at 4,000
  characters.
- The scheduler is deterministic and runs one task at a time. There is no
  parallel task execution.
- A dependency failure blocks downstream tasks; the session does not re-plan
  around a failed task automatically.
- Plan quality depends on the model and the retrieved context. The parser
  validates shape and safety, not correctness. Truncated provider plans
  (`finishReason=length`) are never accepted; the session fails closed with a
  classified reason.
- Inspection-only plans (`kind: "inspection"`) are read-only: they carry
  findings, no tasks, and approving them never schedules work. Implementation
  plans remain strict.
- Empty plans are accepted and complete without file changes; they are not a
  substitute for a requirement that the model could not understand.

## Changes

- Text files only. Binary edits are not possible.
- Change sets are capped at 20 files and bounded content size.
- A partially failed apply is not rolled back automatically. Undo successful
  files explicitly.
- Undo is best-effort. If a file changed after apply, undo reports a conflict
  and leaves it in place.
- Renames are implemented as a move and are not tracked by Git as a rename in
  the extension; Git decides that on commit.
- Change history is capped at 50 entries and stored per VS Code profile.
- Backups live in extension global storage and survive window reloads, but
  uninstalling or clearing extension storage removes them.
- Approval is per file and per change set. There is no "approve everything for
  this session" control.

## Validation and repair

- Validation runs one exact allowlisted command. There is no general terminal.
- The process is not sandboxed. Allowlisted tooling can still modify files,
  access the network, or run dependency lifecycle scripts.
- Output is capped and merged; stderr is not shown separately.
- Commands run with a fixed working directory at the workspace root.
  Per-command working directories are not configurable in the UI.
- Commands are validated as exact text; shell pipelines and redirection are not
  supported.
- Diagnostics are derived from command output patterns. They can miss errors,
  misattribute a file, or report only the visible tail of a failure.
- Repair is advisory and bounded by `quantsmind.agent.maxRepairIterations`
  (default 1). A repair can introduce new defects and never runs automatically.

## Agent sessions

- Sessions are stored locally and are not synced across machines or profiles.
- At most 50 sessions are retained, each capped at 200,000 serialized
  characters; event history and large validation output are compacted.
- A session belongs to one workspace root and is not restored in another.
- An interrupted write (`applying` or `repairing` at reload) is treated as
  failed rather than resumed, because the extension cannot prove what was
  written.
- Pausing is only allowed in `ready`, an awaiting-approval state, `diagnosing`,
  or `validating`. Running provider or command work must be cancelled instead.
- Session events are an audit aid, not a cryptographic log.

## Conversations

- Conversations are stored locally. They are not synced across machines or
  profiles.
- Storage is bounded: 30 conversations, 200 messages per conversation, and
  120,000 characters per conversation. Oldest data is dropped; when it is, the
  interface says which older messages were released and approximately how many
  characters disappeared.
- Responses that stop at the provider output token limit keep their partial
  output and can be resumed in place with a bounded **Continue response**
  control (at most 3 continuations per response; content is never re-sent or
  duplicated). Asking for lost content requires a new request; there is no
  infinite continuation.
- Attachments are not re-sent with every message; history carries text only.
- There is no export, search, or share feature.
- Deleting a conversation is immediate and has no undo.

## UI and platform

- The chat view is a webview. Rendering is validated structurally, not visually,
  and has not been audited for screen-reader completeness.
- Only VS Code desktop 1.95.0 or newer is supported. Web, Virtual Workspaces,
  and Remote Development are **not supported** (`capabilities.virtualWorkspaces`
  is `false` and there is no `browser` target); Restricted Mode is supported
  for the read-only/attach-your-own-content surface only.
- Windows, macOS, and Linux CI jobs are configured. See the completion report
  for which platforms and commands were actually executed locally.

## Build and test integration

- Commands run through the same allowlist, approval and no-shell runner as
  validation; there is no bypass for build or test tooling.
- Toolchain probing reports what is executable on the machine; missing
  executables are reported unavailable, never guessed.
- Builds and tests stop at the first failing step in a sequence; multi-step
  adapters (for example CMake) do not attempt later steps after a failure.
- Test counts come from the runner's own output and are `undefined` when the
  format is ambiguous; nothing is fabricated.
- Karkain compiler behaviour is not executed by CI on this machine (the real
  `karkain` toolchain fails to run there); Karkain build/check/test coverage
  uses a fixture compiler matching the documented contract, so real Karkain
  compilation and diagnostics are not verified end-to-end in this environment.
- Java builds only work when the required Maven/Gradle toolchain is installed;
  Gradle builds resolve plugins from the network or a local cache on first
  use.
- Diagnostics are pattern-matched from command output; they can miss errors
  or misattribute locations.
- Execution history is in-memory and bounded to the last 50 records; it is
  not persisted across sessions.

## Git, GitHub and change management

- Git integration targets the workspace root only. Nested repositories and submodules are not fully managed.
- Checkpoint snapshots are in-memory and capped at 50 entries; they are not persisted across sessions.
- The checkpoint restore never overwrites diverging user edits; conflicting files are left in place and listed as conflicts.
- Git read operations (status, diff, log) run without approval; every mutating operation requires explicit approval per action.
- Branch creation, switching, staging, unstaging, committing and force-deleting all require approval; `git add .`, `-a` and broad patterns are refused.
- Push, merge and release are not available in this milestone.
- GitHub integration uses the stored GitHub session token (repo scope) and operates on the `origin` remote; when no token is present, GitHub tools fail clearly and ordinary local Git tools keep working.
- GitHub and pull-request operations have not been tested against the real GitHub API in an automated way; fixture tests mock the REST API.
- Git does not keep per-file change approval history outside the change-set approval flow.

## Security and operations

- No telemetry, crash reporting, or update service exists.
- The extension trusts the configured provider and the local machine.
- A user who approves a plan or diff without reading it can still apply an
  unwanted change. Review is a required part of the workflow.
- The extension is a GA-qualified local candidate and is **not published** in
  this baseline (no signing, no Marketplace/Open VSX publication). Publication
  remains a separate, explicitly authorized step.
