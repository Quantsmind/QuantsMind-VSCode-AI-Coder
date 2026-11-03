# Changelog

All notable changes to QuantsMind AI Coder are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
