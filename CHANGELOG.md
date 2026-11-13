# Changelog

All notable changes to QuantsMind AI Coder are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.1.1] - 2026-11-13

Reliability, answer quality and mode-isolation correction milestone on the v3.1.0 base. No architecture replacement, no weakening of security controls, no schema or storage changes, no new provider integration.

### Ask and Agent mode isolation
Ask and Agent now own separate provider context. Every recorded message carries an explicit `mode` tag; provider replay uses only the active mode's messages, so Ask and Agent never share cross-mode context silently. Conversation restoration on window reload and conversation switch carries the mode field. Webview composer drafts are kept independently per mode, so switching modes never exposes or submits the other mode's draft. (`src/chat/session.ts`, `src/chat/persistence.ts`, `src/chat/attachmentContext.ts`, `src/chat/protocol.ts`, `src/chat/chatViewProvider.ts`, `media/chat.js`)

### Agent session lifecycle
The delete action now removes a session from persistent storage **before** dropping it from memory; a storage failure leaves both the visible list and stored envelope intact and surfaces the error instead of reporting success. Successful deletion removes the session from everywhere the user can see it; deleted Agent sessions stay deleted across reload. Failed and cancelled sessions can be deleted like finished ones; deleting while an operation is in flight remains guarded and explains why. (`src/agent/orchestrator.ts`, `src/chat/chatViewProvider.ts`)

### Ask-mode attachment and provider reliability
Ask-mode provider failures restore the user's prompt to the composer and preserve any attachments, so the request can be retried with the same context. A Retry request action resends the failed request with the stored transcript; the user message is recorded once and repeated attempts never duplicate it. Large attachments (including a 15,064-char fixture) now reach the provider in Ask mode on retry. Provider HTTP 4xx/5xx and malformed-body responses remain classified as `invalid_response`; no semantic change to rate limiting, auth or server errors. (`src/chat/chatViewProvider.ts`, `media/chat.js`)

### Read-only inspection versus plan execution
The Agent path now detects explicit read-only workspace requests (`Inspect …`, `Report …`, `Summarize …`, `Analyze …`) and handles them locally, before the orchestrator: no provider call, no plan, no change set, no command, no file writes. The report states what it inspected, what it counted but did not inspect, and what was unavailable, and includes inventory, manifest results, language/test heuristics and Git status when Git is available. (`src/workspace/inspectionReport.ts`) Normal change requests still go through the existing plan → approval → apply pipeline unchanged.

### Answer quality and rendering
Ask/Explain guidance now includes Python `__all__`/`__main__` descriptors and Java interface default/static/private method semantics. Fence language sanitizer in the webview normalizes Copy-suffixed fences (e.g. `javacopy`, `textcopy`) to canonical tags, preventing stray confusing labels in code output. (`src/languages/registry.ts`, `media/chat.js`)

### Changed
Version: 3.1.1. Engine range `^1.95.0`, configuration schema, settings, and storage formats unchanged. The extension was never published to a registry; publication remains a separate, explicitly authorized owner decision.

## [3.1.0] - 2026-11-12

Reliability, quality, and user experience hardening on the v3.0.0 GA base. No architecture, permission, schema or default changes; additive, bounded changes with regression coverage.

### Fixed — Agent workflow reliability

**Planning response validation.** The planning parser now classifies outcomes instead of collapsing them into one generic failure: `empty`, `truncated` (provider `finishReason=length` — an incomplete plan is never accepted, even if the partial text parses as JSON), `no-json`, `invalid-json`, `not-object`, `missing-tasks`, `invalid-tasks`, `missing-findings`, `invalid-kind` (an explicitly supplied, unsupported plan kind is never coerced to implementation; missing `kind` alone defaults to implementation for backward compatibility). Errors are actionable instead of a bare "could not be parsed" session failure. Plan validation failures are logged with a machine-readable category and the provider finish reason; the failed session record, diagnostics and timeline events carry the original error. (`src/agent/planning.ts`, `src/agent/orchestrator.ts`)

**Inspection-only plans.** Workspace-inspection requests ("inspect/review/analyze/explain this workspace") produce a read-only `kind: "inspection"` plan: it describes findings with file references and carries **no tasks at all** — explicitly parsed, validated and safe to approve; approving it runs nothing and reports the findings. Implementation plans are unchanged and remain strict. (`src/agent/planning.ts`, `src/agent/orchestrator.ts`, `src/agent/report.ts`, `src/agent/models.ts`)

**Checkpoint failure lifecycle.** Failed planning or cancellation before a validated execution plan exists no longer attempts to persist an execution checkpoint with an empty planId — the source of the v3.0.0 `checkpoint save rejected: invalid checkpoint` warnings. The checkpoint lifecycle is now explicit: execution checkpoints persist only after a validated plan exists; failures before that point are carried in the session record, diagnostics and events. A checkpoint persistence failure never hides the original planning error. (`src/agent/orchestrator.ts`)

**Plan approval and execution remain strictly separated**, and rejected plans cannot execute; approving a zero-task or inspection plan schedules nothing. Session restoration never duplicates or corrupts task state: a replay against the same checkpoint lineage refuses as stale (`checkpoint-rejected`) rather than re-applying state. (`src/agent/orchestrator.ts`, regression coverage in `test/unit/agentOrchestrator.test.ts`)

### Ask, Explain, Generate quality

Base system prompt now requires facts-vs-assumptions labeling, forbids unverified execution claims, forbids unexplained mid-method stopping, and requires complete idiomatic examples. Ask/Explain/Generate mode prompts were rewritten: Ask demands fact/assumption separation and uncertainty disclosure; Explain covers language semantics, edge cases, thread safety and security, separates what the code actually does from recommendations, and refuses to overstate performance/concurrency/security properties; Generate requires complete, idiomatic implementations (with tests, documentation and complexity analysis where asked), explicit reporting of what could not be finished, and honesty about compilation/test status. Java chat guidance was updated for Java 21 (records, sealed hierarchies, pattern matching, virtual threads, carrier-thread pinning). Whitespace-only assistant turns are no longer replayed to the provider. (`src/chat/prompts.ts`, `src/languages/registry.ts`)

### Response completeness and continuation

Responses that end at the provider output token limit are now explicitly surfaced instead of silently stopping, and can be resumed **in place**: user-initiated only, capped at three continuations per response, context and system prompt rebuilt correctly, the partial output is preserved and the continuation is merged into the same transcript message (no duplicated content, no duplicate assistant messages). (`media/chat.js`, `src/chat/chatViewProvider.ts`, `src/chat/protocol.ts`)

### Context and attachments

Older context released from the provider window (trimmed by the conversation character budget) is now surfaced: the user is told which oldest messages were dropped and roughly how many characters disappeared, and restore-time budget drops are reported in the history status/warnings. (`src/chat/session.ts`, `src/chat/chatViewProvider.ts`)

### UI

- Copy: code-block Copy retained and tested; new always-visible **Copy response** action on every assistant message; new **Copy log** action copies the last 50 redacted log lines to the clipboard with success/failure feedback.
- Composer: manual vertical resize (drag handle with pointer capture, keyboard arrows/Home/End, double-click reset) alongside the existing auto-growth; responsive and bounded by window height.
- Sessions: Refresh is now a compact icon button with an aria-label, spinning busy indicator and a completion notice.
- Conversation/session deletion: wording aligned across webview and host flows; each destructive action asks exactly once, with explicit success feedback notices (agent sessions state transcripts are unaffected; conversation deletion states agent sessions are unaffected).
- Navigation: jump-to-latest button; assistant messages are keyboard focusable; focus-visible outline.

### Provider reliability and observability

Chat request lifecycle logging distinguishes request started (with full budget breakdown), provider response received (with `finishReason`), streaming completion, cancellation, provider failure (with redacted normalized code) and continuation events, correlated by request id. MCP `clientInfo` now advertises the real extension version. The logger retains a bounded, redacted 300-line in-memory ring buffer backing the copy-log action. (`src/chat/chatViewProvider.ts`, `src/chat/requestMetrics.ts`, `src/mcp/client.ts`, `src/security/logger.ts`)

### Tests and qualification

130+ new regression tests (planning/checkpoint lifecycle, inspection plans, prompt quality, truncation/continuation integration, session accounting, log ring, protocol parsing, webview affordances). Focused suites green; the full v3.0.0 qualification chain (lint, unit, integration, packaged, `verify:vsix`, `verify:install`) is re-run on this release candidate; 2 Pollinations live tests remain pending by policy (offline environment, never converted to pass/fail).

### Changed

**Version: 3.1.0.** quantsmind.agenticEngine.\* defaults and bounds unchanged. The VS Code engine range (`^1.95.0`), configuration schema, settings, and storage formats are backward compatible with 3.0.0. The extension was never published to a registry; publication remains a separate, explicitly authorized owner decision.

## [3.0.0] - 2026-11-11

General Availability. Unified bounded agent execution across both agent entry paths; four v2.5.7 contract gaps closed; the per-task and session-wide budgets are enforced at execution boundaries; backward compatible with v2.5.x-series settings where they were ever combined into a build (the 2.5.x line was an internal milestone series and was never tagged in package.json — this is the first 3.x release).

### Security (v3.0.0 project-wide qualification remediation)

**Project-wide audit and fix pass** (`docs/audit/V3.0.0-PROJECT-WIDE-GAP-AUDIT.md`, commit `1c650f9` and follow-ups): a launch-gate bypass in the MCP management UI (`discoverTools` connected/launched servers without workspace trust or launch approval — fixed with a shared approval gate); command runner, orchestrator and runtime authorization defaults fail closed; approval binds to the exact command/cwd shown and is re-validated before execution; secret redaction no longer falls back across provider credential scopes; tool exceptions and MCP server error payloads are redacted before they reach the model; Streamable HTTP timeouts can no longer collapse to NaN; mid-stream responses are never retried (no duplicated generation); changed-file/patch budgets charge only for calls that succeeded; the cumulative patch budget is charged only for changes actually applied (rejected proposals no longer consume it, with an apply-time backstop); failed restores keep history `partial`/`undoable` instead of reading as undone; plaintext backup before-images are retention-bounded (`src/changes/prune.ts`) and pruning preserves non-backup content; path-containment coverage added (`test/unit/workspacePathSafety.test.ts`).

### Fixed

**v2.5.7 GA-gap closures.** (1) Per-task duration budget: task executions now measure elapsed time from the task's first startedAt, not from session creation; a long-lived session cannot consume a newly started task's budget, and a restored task with a spent budget is refused instead of silently resumed. (2) Honest tool-call accounting: outcomes report actual dispatched and refused tool calls counted at the shared dispatch boundary, never inferred from provider calls or model plans. (3) Repair-envelope patch-size protection: prepared and repair change sets are checked before any approval is built, including the cumulative patch budget across the session, not just the largest single change set; refuse-before-dispatch (engine) and refuse-before-approval (orchestrator) now agree. (4) Consistent consecutive-failure handling: both entry paths use the same maxConsecutiveFailures accounting semantics; a passing validation resets the sequence; the third consecutive failure stops the session with an honest outcome instead of repairing forever. All are covered by new deterministic regression tests in test/unit/v3GapClosure.test.ts.

### Changed

**Version: 3.0.0.** quantsmind.agenticEngine.* defaults and bounds are unchanged. Completion reporting is evidence-based on both paths (failed tool calls, failed validations, over-budget patches and unapproved actions can never read as complete). The VS Code engine range (`^1.95.0`), configuration schema, and MCP/transport guarantees are unchanged. The extension was never published to a registry; publication is a separate, explicitly authorized decision.
## [2.0.0] - 2026-11-08

Release bundling the agentic coding work merged on top of 1.3.0 and
the Gate 3 qualification remediation.

### Added
- Permanent regression coverage for the agent orchestrator and the bounded
  provider retry loop (62 tests, D5): session lifecycle, plan/change/
  validation/repair approvals, exact-operation-set guards, scheduler bounds,
  cancellation and recovery, and the documented retry cap.
- Native tool-calling cycle integrity and capability gating (D1): tool
  transcripts, per-profile tool support, and Gemini tool-message handling.
- Execution-time (not construction-time) configuration for validation
  commands: allowlist, credential resolver, timeout and output limit are read
  when the command runs; trust is rechecked at every boundary (D3).
- Quota-exhaustion classification (HTTP 402, 403/429 `insufficient_quota`)
  separate from rate limiting (D6); retry metadata agreement (D8) and
  Retry-After passthrough with a bounded single retry (D7/D9).
- Provider-switch model planning: an explicit incompatible model prompts for a
  choice with the target default offered; approval-modal detail rendering and
  secret-change detection were refreshed (D10).
- Workspace-root consistency across every consumer (indexing, retrieval,
  change service, agent, diagnostics) with a multi-root scoring policy (D4).
- `validating` is a pausable, user-controlled resting state (D7): nothing is
  in flight until the user runs the approved validation command.
- Session recovery reporting and approval bookkeeping hardening (task consent
  is bound to the exact request the user saw).

### Fixed
- Rejected change sets are now marked `rejected` instead of staying `pending`,
  so they cannot be re-approved; pending approvals are always consumed
  atomically with the user's decision.
- Cancelling an in-flight task no longer strands the session in a working
  state with nothing in flight: the session is settled (completed, failed, or
  parked in `ready`) so pause stays truthful (D7).
- Pausing no longer reports "work is still in progress" for a resting
  `validating` session or a session whose tasks are all terminal.
- The diagnostics report shows the selected workspace root instead of the
  arbitrary first folder (multi-root consistency, D4).
- The integration suite no longer runs twice concurrently in two extension
  hosts (a stale multi-root window in the test profile was restored on every
  run), which caused shared-state races; integration runs are now
  deterministic.

### Tests
- Unit suite: 733 passing, 0 failing.
- Integration suite: 65 passing on a single extension host, reproducibly.
- `npm run verify` passes end to end (package, VSIX inspection, packaged-host
  tests, install verification).

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

## [1.2.0] - 2026-11-07

### Added

- Validation diagnostics as a standalone tool: `diagnose_validation_failure`.
- Validation command results now include structured diagnostics and plan binding.
- Change preparation output now includes the full plan for validation binding.
- Richer chat tool-result rendering for diffs and command output.

### Changed

- Agent system prompt now guides the model through validate, repair, and revalidate.
- Command validation output now exposes diagnostics for failed runs.

### Tests

- Unit and integration suites pass after the v1.2.0 validation and UX changes.

## [1.3.0] - 2026-11-07

### Changed

- Coding-agent prompts now restore provider history from the persisted conversation.
- Provider history restoration excludes local-only tool-result messages, so tool output is preserved in the transcript without being replayed to the model.
- Version bumped to 1.3.0.

### Tests

- Compile, lint, unit tests, and integration tests pass after the history-restoration changes.

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
  conversation currently open and labels it `New chat ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â current, empty`, so a New Chat
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
  masked forms such as `sk-ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦abcd` are now scrubbed from prompts, error bodies,
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
