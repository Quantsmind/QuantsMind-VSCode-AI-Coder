# Known limitations

These are the boundaries of the v0.3.0 alpha preview. They are deliberate, not
undocumented behavior.

## Provider and model

- Only the OpenAI-compatible `/chat/completions` shape is supported. Provider
  SDKs, Responses API, and native Anthropic/Gemini protocols are not implemented.
- Tool calling, function calling, image inputs, audio, and multimodal content
  are not supported. Tool-call responses are rejected with an error, and no
  executable tool definitions are sent.
- The plan and change-set formats are strict JSON contracts. Models that cannot
  follow them produce an `invalid_response` or parse error. There is no general
  schema-repair loop beyond the bounded repair pass.
- Reasoning or hidden model output is not displayed.
- A live provider request requires a valid credential. CI never uses one.
- Capability flags are descriptive. `maxContextChars` is advisory; the
  extension does not provably enforce a provider's context window.

## Workspace intelligence

- The index covers the first workspace root only. Multi-root workspaces are not
  fully indexed.
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
  validates shape and safety, not correctness.
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
- Pausing is only allowed in `ready`, an awaiting-approval state, or
  `diagnosing`. Running provider or command work must be cancelled instead.
- Session events are an audit aid, not a cryptographic log.

## Conversations

- Conversations are stored locally. They are not synced across machines or
  profiles.
- Storage is bounded: 30 conversations, 200 messages per conversation, and
  120,000 characters per conversation. Oldest data is dropped.
- Attachments are not re-sent with every message; history carries text only.
- There is no export, search, or share feature.
- Deleting a conversation is immediate and has no undo.

## UI and platform

- The chat view is a webview. Rendering is validated structurally, not visually,
  and has not been audited for screen-reader completeness.
- Only VS Code desktop 1.95.0 or newer is supported. Web, Virtual Workspaces, and
  Remote Development are declared compatible but not exercised by the test suite
  in this baseline.
- Windows, macOS, and Linux CI jobs are configured. See the completion report
  for which platforms and commands were actually executed locally.

## Security and operations

- No telemetry, crash reporting, or update service exists.
- The extension trusts the configured provider and the local machine.
- A user who approves a plan or diff without reading it can still apply an
  unwanted change. Review is a required part of the workflow.
- There is no signing, Marketplace publication, or Open VSX publication in this
  baseline.
- The extension is a preview and is not general availability.
