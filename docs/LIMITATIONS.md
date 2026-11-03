# Known limitations

These are the boundaries of the v0.2.0 alpha preview. They are deliberate, not
undocumented behavior.

## Provider and model

- Only the OpenAI-compatible `/chat/completions` shape is supported. Provider
  SDKs, Responses API, and native Anthropic/Gemini protocols are not implemented.
- Tool calling, function calling, image inputs, audio, and multimodal content
  are not supported. Tool-call responses are rejected with an error.
- The plan format is a strict JSON contract. Models that cannot follow it will
  produce an `invalid_response` or plan-parse error. There is no schema-repair
  loop beyond the configured repair pass.
- Reasoning or hidden model output is not displayed.
- A live provider request requires a valid credential. CI never uses one.

## Workspace index

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

## Changes

- Text files only. Binary edits are not possible.
- Plans are capped at 20 changes and bounded content size.
- A partially failed apply is not rolled back automatically. Undo successful
  files explicitly.
- Undo is best-effort. If a file changed after apply, undo reports a conflict
  and leaves it in place.
- Renames are implemented as a move and are not tracked by Git as a rename in
  the extension; Git decides that on commit.
- Change history is capped at 50 entries and stored per VS Code profile.
- Backups live in extension global storage and survive window reloads, but
  uninstalling or clearing extension storage removes them.

## Commands

- Only allowlisted commands run. There is no general terminal.
- The process is not sandboxed. Allowlisted tooling can still modify files,
  access the network, or run dependency lifecycle scripts.
- Output is capped and merged; stderr is not shown separately.
- Commands run with a fixed working directory at the workspace root. Per-command
  working directories are not configurable in the UI.
- Commands are validated as exact text; shell pipelines and redirection are not
  supported.

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
- Windows, macOS, and Linux CI jobs are configured. Only the Windows verification
  in this build was executed locally; see the completion report for actual
  executed evidence.

## Security and operations

- No telemetry, crash reporting, or update service exists.
- The extension trusts the configured provider and the local machine.
- A user who approves a plan without reading it can still apply an unwanted
  change. Review is a required part of the workflow.
- There is no signing, Marketplace publication, or Open VSX publication in this
  baseline.
- The extension is a preview and is not general availability.
