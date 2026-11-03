# Changelog

All notable changes to QuantsMind AI Coder are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
