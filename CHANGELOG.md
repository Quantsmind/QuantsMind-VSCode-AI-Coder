# Changelog

All notable changes to QuantsMind AI Coder are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Deleting a conversation no longer promotes an empty one as the new active chat; the
  next conversation that actually holds messages is selected, and an all-empty store
  falls back to a fresh chat.
- `src/extension.ts` contained raw Windows-1252 separator bytes, so the compiled status
  bar rendered a replacement character instead of the intended separator. The file is
  now valid UTF-8 end to end.
- The CI release job uploaded `quantsmind-vscode-ai-coder-0.3.0.vsix`, a name no build
  has produced since 0.3.0, with `if-no-files-found: error` — so the job could only ever
  fail on a current release.

### Changed

- Release verification is version-agnostic: artefact names, the installed-extension
  identity check and the VSIX identity marker are derived from `package.json`, so a
  version bump no longer requires editing scripts, test configs and assertions.
- New `npm run verify:release` guard fails the chain when an artefact name, extension id
  or user-agent is pinned to a literal version; new `npm run release` performs the
  package.json and lockfile bump and prints the follow-up steps without committing,
  tagging or publishing; new `npm run sha256` records artefact checksums.
- The provider `User-Agent` reports the version supplied at activation instead of a
  string baked into the source, which would otherwise keep shipping the previous
  release's number.
- CI now also runs on `release/**` branches and manual dispatch, executes the literal
  guard, reports (without blocking on) `npm audit --audit-level=high`, and publishes the
  VSIX plus its SHA-256 checksum as build artifacts.

## [1.1.0] - 2026-11-07

### Added

- Bounded coding-agent runtime with a tool registry and read-only workspace tools.
- Safe file-change tools using the existing ChangeService, approval, backup, diff,
  and undo mechanisms.
- Approved, allowlisted command execution for validation.
- Repository context tools for overview, context selection, symbol search, and
  change-impact analysis.
- Native OpenAI-compatible tool-call support and tool-result feedback.
- Chat persistence for coding-agent runs and tool results.
- Tool progress and result rendering in the chat view.

### Changed

- Agent system prompt now guides propose, apply, validate, repair, and revalidate.
- Provider messages now carry assistant tool calls and tool result messages.

### Tests

- Unit and integration suites pass after the agent runtime changes.

## [0.3.4] - 2026-11-04

### Added

- Conversation history visibility: the chat sidebar now shows whether history was
  restored, how many previous messages the provider will receive, and a per-request
  breakdown that separates system instructions, replayed history, the current prompt
  and attached-file context.
- Attachment context persistence: the context actually supplied to the provider is
  captured with each user turn (schema v2, bounded, already redacted) and replayed
  verbatim when the conversation is restored, instead of only storing file names.
- Read-only freshness audit for restored attachments: captured context is compared
  with the file on disk and any difference is reported. Disk content is never
  substituted for the original captured context.
- `Clear` and `Restore` conversation actions; destructive conversation operations now
  require an explicit native confirmation.
- Sanitized provider-request diagnostics in the Output channel: provider id, model,
  message counts, size of each request part, streaming state, duration, finish reason
  and failure category. No prompt text, file content, keys or headers are logged.

### Changed

- Conversation records carry a schema marker; older (pre-0.3.4) conversations are read,
  ordered and upgraded in place without data loss. Unreadable records are salvaged
  before the list is rewritten.
- Local-only assistant output (workspace summaries) is marked as never sent and is
  excluded from provider history.

### Fixed

- `Restore` now opens the conversation selected in the history dropdown instead of
  the most recently updated record; without a selection it falls back to the newest
  conversation that still has messages, so it can no longer land on an empty chat.
- Empty conversations are no longer offered as history entries. The dropdown keeps the
  conversation currently open and labels it `New chat — current, empty`, so a New Chat
  placeholder can no longer be mistaken for the `New chat` action row.
- Saving a conversation with no messages keeps its previous `updatedAt`, so clearing a
  conversation or re-saving a placeholder no longer moves it to the top of the history.

## [0.3.2] - 2026-11-03

### Added

- Visible extension version badge in the QuantsMind chat sidebar (sourced from package.json).
- `QuantsMind: About QuantsMind / Version` command (Command Palette) showing product name, version, extension ID, and provider status.
- Version included in diagnostic/support reporting via the About command.

### Changed

- Extension manifest version bumped to 0.3.2.

## [0.3.0] - 2026-11-03

Agentic development and execution preview. This is an alpha build and is **not**
a general availability release.

### Added

- Agent sessions with an explicit lifecycle: requirement, inspection, planning,
  plan approval, task scheduling, implementation, change review, apply,
  validation, diagnosis, repair, revalidation and completion report.
- A typed development plan with tasks, dependencies, acceptance criteria,
  suggested files and allowlisted validation commands.
- A deterministic dependency scheduler with blocked-task handling, duplicate
  execution guards and bounded provider-call budgets.
- Project intelligence that derives languages, package manager, scripts,
  configuration files and modules locally, reading only `package.json` content.
- Session control-center UI: session list, state and stage timeline, plan card,
  task cards, per-file diff approvals, repair approvals, validation evidence,
  diagnostics and completion report.
- Pause, resume, cancel, restore and delete for persisted sessions.
- Versioned session storage with schema migration, validation on read, event
  caps and `needs-review` recovery instead of automatic resume.
- Applied-file SHA-256 revalidation when a stored session is restored.
- Session undo that restores the backups of the most recent applied change set.
- Command risk policy that classifies validation, read-only, destructive and
  unknown commands; destructive commands are always rejected.
- Diagnostic extraction from real validation output, with bounded repair
  proposals that require fresh per-file approval and revalidation.
- Evidence-based completion reports with `completed`, `failed`, `cancelled` or
  `rejected` outcomes and unresolved-item lists.
- Capability descriptors for the provider layer; native tool calling remains
  disabled and the model receives no executable tool channel.
- Unit coverage for the state machine, scheduler, planning parser, command
  policy, session repository, project intelligence, protocol and orchestrator;
  integration coverage for the full session approval flow.

### Changed

- The chat view now uses a session protocol (`session`, `sessions`,
  `sessionError`) instead of the v0.2.0 single-task message.
- **Start Agent Task** is now **Start Agent Session**; the command id remains
  `quantsmind.startAgentTask` for compatibility.
- The mode label is **Agent session (plan -> execute)**.
- Version, packaging, verification scripts and tests target 0.3.0.

### Preserved

- All v0.2.0 provider, context, workspace, change, command and security
  behavior, including approval-first writes, backups, hash preflight, undo,
  SecretStorage credentials and webview CSP.

## [0.2.0] - 2026-11-03

Approval-first workspace assistant preview. This is an alpha build and is **not**
a general availability release. It includes the release-hardening work that had
been staged for an unreleased 0.1.1 build.

### Added

- Workspace intelligence: local file index, technology and entry-point
  detection, `.gitignore`-aware filtering, and relevance ranking against a task
  description. The index never leaves the machine on its own.
- **Summarize Workspace** and **Attach Relevant Workspace Files** commands.
- Structured multi-file change plans supporting create, modify, delete, and
  rename, with per-file reasons and a plan summary.
- Unified diffs in the review view, including create/delete/rename headers,
  hunk context, large-file fallback, and per-file warnings.
- Approval flow with per-file selection, reject-all, cancellation, stale-file
  detection using SHA-256 baseline hashes, and workspace-containment checks.
- Workspace-scoped apply with per-file backups and an undo path that refuses to
  overwrite files edited after apply.
- Change history in extension storage (50 entries) with restore from backups.
- Agent task workflow with explicit stages (retrieve, plan, review, approval,
  apply, validate, repair), provider-call limits, repair-iteration limits, an
  overall timeout, and cancellation.
- Approved validation command execution: allowlist, no shell, sanitized
  environment, workspace containment, output caps, timeouts, cancellation, and
  redaction. Commands are displayed exactly before running.
- Bounded repair planning after a failed validation; repairs are reviewed and
  approved like any other plan.
- Persisted conversations with create, switch, and delete, bounded to 30
  conversations and 120,000 characters each.
- Markdown and fenced-code rendering, per-block copy, inline file references,
  streaming status, and actionable error panels in the chat view.
- New commands: **Summarize Workspace**, **Attach Relevant Workspace Files**,
  **Start Agent Task (Plan Changes)**, and **Show Change History**.
- New settings for workspace indexing/retrieval, agent limits, and approved
  command execution.

### Changed

- The extension is now workspace-aware and can apply approved changes; the
  previous "read-only, no file writes, no command execution" boundary no longer
  applies.
- Chat history survives window reloads through extension `Memento` storage.
- Tool-call responses from a provider are rejected with a message that refers to
  the current release rather than v0.1.0.
- CI runs lint, compile, unit tests, extension-host tests, dependency
  verification, VSIX packaging, archive inspection, and packaged-host tests, with
  Windows and macOS jobs alongside Ubuntu.

### Security

- Fixed provider-masked API-key redaction: the exact stored credential and
  masked forms such as `sk-…abcd` are now scrubbed from prompts, error bodies,
  and logs.
- Authorization headers, URL userinfo, JWTs, bearer tokens, and common provider
  key formats are sanitized before display or logging.
- Error messages are normalized with actionable hints and never echo a
  credential.
- Change paths reject absolute paths, drive letters, Windows drive-relative
  paths, alternate data streams, UNC paths, control characters, and traversal.
- Command validation rejects path-qualified executables and shell
  metacharacters, and execution never uses a shell.
- Reconciled GHSA-g3hv-75wg-m249. Runtime minimatch 11.0.4 is patched. The
  nested 9.0.9 and 10.2.6 copies are development-only build and test tooling and
  are not shipped in the VSIX.
- Offline dependency guard (`npm run verify:deps`) fails if the shipped
  minimatch runtime dependency drops below the patched 11.0.1 release.

### Tests

- Unit coverage for workspace analysis and ignore matching, configuration
  clamping, change model/diff/plan/review/apply/history, command validation and
  execution, conversation persistence, agent task stages, and redaction.
- Extension-host coverage for workspace indexing/redaction and a full
  plan, approve, write, and undo cycle.
- Regression coverage for masked-key redaction, Windows path containment,
  executable-path validation, and the empty-plan response.

## [0.1.0] - 2026-11-03

First preview baseline. This is an alpha build and is **not** a general
availability release.

### Added

- Standalone VS Code extension with an Activity Bar sidebar chat view.
- Provider-neutral `AiProvider` contract and registry.
- OpenAI-compatible chat completions provider with configurable HTTPS endpoint
  and model, plus opt-in loopback HTTP for local models.
- Streaming responses over server-sent events with incremental UI rendering.
- Cancellation through a Stop control and a total request timeout.
- Normalized provider errors (`configuration`, `authentication`, `rate_limit`,
  `timeout`, `cancelled`, `network`, `server`, `http`, `invalid_response`) with
  actionable hints.
- API keys stored only in VS Code SecretStorage. No credential setting exists.
- Explicit context attachment from the current selection, the active file, or
  user-picked workspace files.
- Mandatory secret/dependency/build-output exclusions plus configurable glob
  exclusions and context size limits.
- Secret redaction at attachment time, before sending, in error bodies, and in
  every log line.
- Strict webview content security policy, nonce-based scripts, DOM text
  rendering for untrusted attachment metadata, and no remote resources.
- Commands for opening chat, starting a new chat, explaining or asking about a
  selection, generating a suggestion, attaching the active file, managing the
  API key, configuring the provider, selecting a model, and opening the log.
- Unit tests for endpoint validation, error normalization, redaction,
  credentials, SecretStorage wrapper, logging, SSE parsing, cancellation,
  provider request construction, context filtering, prompts, setting
  resolution, chat sessions, webview protocol, webview HTML, and the completion
  service.
- Extension-host integration tests for activation, command registration,
  manifest scopes, credential commands, context selection, streaming chat,
  cancellation, error surfacing, attachment redaction, and workspace
  immutability.
- Packaged-VSIX tests and install verification scripts.
- GitHub Actions CI for lint, compile, unit tests, extension-host tests,
  packaging, VSIX inspection, and packaged activation.

### Security

- Workspace content is never sent without an explicit user action.
- v0.1.0 never writes to workspace files and never executes workspace commands.
- Provider settings are application-scoped so workspace settings cannot
  redirect credentials to another host.
- Remote endpoints must use HTTPS. Plain HTTP is limited to loopback hosts and
  can be disabled.
- Endpoint URLs with embedded credentials, query strings, or fragments are
  rejected.

### Known limitations

- Only the OpenAI-compatible `/chat/completions` API shape is supported.
- Tool calls, images, and multimodal content are not supported.
- Conversation history is in memory only and is not persisted.
- No telemetry, update service, backend, database, or remote service is used.
- The extension is not published to any Marketplace in this baseline.
- No automatic file edits, patches, or command execution are implemented.
