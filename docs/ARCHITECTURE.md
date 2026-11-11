# Architecture

QuantsMind AI Coder is a single VS Code extension written in TypeScript. It has
no backend, database, telemetry service, Python runtime, or QuantsMind project
dependency.

## Layers

```text
VS Code host
  extension.ts
    commands, status bar, SecretStorage, OutputChannel, Memento stores
        |
        +-- ChatViewProvider (webview lifecycle, chat and task orchestration)
        |     +-- protocol.ts, session.ts, persistence.ts, prompts.ts,
        |         webviewHtml.ts
        |
        +-- CompletionService (provider-neutral request orchestration)
        |     +-- registry.ts -> openaiCompatible.ts, geminiCompatible.ts
        |           +-- endpoint.ts, cancellation.ts, errors.ts, sse.ts
        |
        +-- ContextService (explicit VS Code file/editor access)
        |     +-- filters.ts (exclusions, limits, redaction)
        |
        +-- WorkspaceIndexService (local index and relevance retrieval)
        |     +-- analyze.ts, ignore.ts
        |
        +-- AgentOrchestrator (session lifecycle and approvals)
        |     +-- stateMachine.ts, planning.ts, scheduler.ts,
        |         diagnostics.ts, report.ts, toolRouter.ts
        |     +-- ProjectIntelligenceService (project/intelligence.ts)
        |     +-- SessionRepository (sessions/repository.ts)
        |
        +-- ChangeService (prepare, apply, undo, history)
        |     +-- model.ts, diff.ts, review.ts, apply.ts, fs.ts, history.ts
        |
        +-- CommandExecutionService (risk policy, allowlist, process runner)
        |     +-- commands/policy.ts, commands/runner.ts
        |
        +-- SettingsService / resolve.ts / defaults.ts
        |
        +-- security: credential.ts, secretStore.ts, redact.ts, logger.ts
```

Pure modules do not import `vscode`, which keeps them unit-testable in plain
Node. The agent orchestrator, planning, scheduler, state machine, diagnostics,
report builder, session repository, and project intelligence are pure and
receive their VS Code access through injected functions. VS Code adapters are
limited to `extension.ts`, `config/settings.ts`, `context/contextService.ts`,
`workspace/indexService.ts`, `changes/changeService.ts`, `changes/fs.ts`,
`agent/runtime.ts`, and `chat/chatViewProvider.ts`.

The v0.2.0 single-task runner (`taskRunner`) has been removed; the control
center and agent sessions use `AgentOrchestrator`.

## Activation and deactivation

`src/extension.ts` activates on `onStartupFinished`. It:

1. Creates a redacting logger over an OutputChannel.
2. Constructs SecretStorage, settings, completion, context, workspace index,
   change history, change service, agent runtime (orchestrator, project
   intelligence, session repository), and chat services.
3. Registers the `quantsmind.chatView` webview view provider.
4. Creates a status bar item that reports provider readiness.
5. Registers all contributed commands with a guard that logs sanitized errors
   and shows a normalized message.
6. Subscribes to configuration, SecretStorage, workspace-folder, and file
   changes to refresh status and invalidate the index.
7. Returns a narrow public API (`src/api.ts`): version, provider status, and
   reveal-chat. The API does not expose credentials, file content, or a
   completion-execution hook.

`deactivate()` disposes the chat provider, hides the status bar, and logs
deactivation. All disposables are registered in the extension context.

## Provider abstraction

`src/providers/types.ts` defines the provider-neutral contract:

- `ChatMessage` and `CompletionRequest`.
- `CompletionOptions` with a cancellation token, total timeout, and optional
  streaming callback.
- `CompletionResult` with text, model, finish reason, and usage.
- `AiProvider` with `id`, `displayName`, and `complete`.

`src/providers/registry.ts` maps a provider type to a factory. It registers two
adapters — the OpenAI-compatible adapter (all OpenAI-compatible profiles:
OpenAI, Groq, OpenRouter, Ollama, LM Studio, llama.cpp, vLLM, Pollinations and
the generic endpoint) and the Google Gemini adapter — fed by ten provider
profiles in `profiles.ts`. Adding a provider means implementing `AiProvider` and
registering a factory; the chat and agent layers do not change. See
[PROVIDERS.md](PROVIDERS.md).

`CompletionService` reads settings and the credential, validates the endpoint,
decides whether a credential is required for loopback, creates the provider, and
normalizes errors. Its log lines contain request metadata only.

## OpenAI-compatible adapter

`src/providers/openaiCompatible.ts`:

- Validates configuration: endpoint, model name, timeout, temperature, token
  limit, and credential shape.
- Validates the request: roles, non-empty messages, total size, stream flag.
- Builds `POST <baseUrl>/chat/completions` with JSON body fields `model`,
  `messages`, `stream`, optional `temperature`, and optional `max_tokens`.
- Sends `Content-Type: application/json`, an `Accept` header that matches the
  requested mode, a product `User-Agent`, and a bearer token when a credential
  is available.
- Rejects redirects (`redirect: 'error'`) so a request cannot be silently
  forwarded to another host.
- Detects JSON responses via content type and otherwise parses server-sent
  events when streaming is enabled.
- Supports message content as a string or an array of text parts, and refusal
  text.
- Native tool calling on tool-capable models sends and parses `tools` /
  `tool_calls` across the JSON and SSE paths (see PROVIDER_CONFIGURATION.md);
  the agent engine and the approval-gated orchestrator use them there. Image,
  audio and other multimodal inputs are not supported.
- Bounds error bodies to 64 KB, JSON bodies to 20 MB, a single SSE event to
  1,000,000 characters, and request content to 2,000,000 characters.

## Request lifecycle (chat)

```text
User presses Send
  -> ChatViewProvider checks provider status
  -> builds redacted context from current attachments
  -> builds system prompt + conversation history + user content
  -> CompletionService resolves settings and credential
  -> registry creates the adapter
  -> withAbort composes cancellation token and total timeout
  -> HTTPS request
  -> JSON or SSE parsing
  -> assistant deltas posted to the webview
  -> assistant text appended to the persisted conversation
```

Chat requests never write workspace files or execute commands.

## Workspace index and retrieval

`src/workspace/indexService.ts` builds a local, in-memory index on demand:

- Enumerates workspace files with `vscode.workspace.findFiles`, bounded by
  `quantsmind.workspace.maxIndexedFiles`.
- Applies built-in exclusions, user `excludeGlobs`, `.gitignore`, and
  `.git/info/exclude` through `ignore.ts`.
- Records language, size, test-path, and entry-point metadata.
- Produces a `WorkspaceSummary` with technology markers and top-level structure.
- Ranks files against a query using path/name tokens, language, entry points,
  test-path status, and size penalties.
- Reads the selected files, then runs the same `buildContext` filtering and
  redaction pipeline used by manual attachments.

`analyze.ts` and `ignore.ts` are pure and unit-tested. `indexService.ts` is the
only workspace-index module that imports `vscode`. See [WORKSPACE.md](WORKSPACE.md).

## Agent session workflow

`AgentOrchestrator` (`src/agent/orchestrator.ts`) owns a versioned
`AgentSession` and advances it through an explicit state machine:

```text
idle -> analyzing -> inspecting -> planning -> awaiting-plan-approval
     -> ready -> executing -> awaiting-change-approval -> applying
     -> validating -> (executing | diagnosing)
     -> awaiting-repair-approval -> repairing -> validating
     -> completed | rejected | failed | cancelled
```

- **analyzing / inspecting** builds a local `ProjectContext` through
  `ProjectIntelligenceService`; no file content is sent at this point.
- **planning** asks the provider for a JSON `DevelopmentPlan`. The parser
  validates task ids, dependencies, paths, and commands, and rejects cycles.
- **awaiting-plan-approval** is a terminal pause until the user decides. No
  file has been written.
- **ready** lets the deterministic scheduler choose one runnable task.
- **executing** asks the provider for a change set for that task only.
- **awaiting-change-approval** is a second, per-file approval pause.
- **applying** writes only selected files, with containment, baseline hashes,
  and backups.
- **validating** waits for the user to run the task's approved command.
- **diagnosing / awaiting-repair-approval / repairing** handles a bounded
  repair proposal, which is reviewed and approved like any other change set.

States, transitions, and stage derivation live in
`src/agent/stateMachine.ts`. The scheduler in `src/agent/scheduler.ts` is pure
and returns `runnable`, `waiting`, `done`, `deadlock`, or `stopped`. Provider
calls are limited by `quantsmind.agent.maxSteps`, repair passes by
`quantsmind.agent.maxRepairIterations`, and each step by
`quantsmind.agent.timeoutMs`.

A final state of `applied` is only set after approved writes complete. A failed
validation transitions to `diagnosing`, never `completed`. Cancellation marks
active and pending work `skipped` or `cancelled` and clears pending approvals.
See [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md) and
[PLANNING_AND_TASKS.md](PLANNING_AND_TASKS.md).

### Project intelligence

`src/project/intelligence.ts` distills local workspace facts: package manager,
scripts, languages, config files, modules, entry points, and test-file counts.
`ContextFact` entries may cite a path. Detected scripts are facts only; a task
may use a validation command only when it exactly matches the user's allowlist.
Retrieval delegates to the workspace index and adds relevance reasons. See
[PROJECT_INTELLIGENCE.md](PROJECT_INTELLIGENCE.md).

### Session persistence

`src/sessions/repository.ts` stores up to 50 sessions under
`quantsmind.agent.sessions.v1`. It validates every field, re-validates the task
graph and change paths, migrates legacy records, and enforces a 200,000-character
serialized cap. Restore refuses sessions from another workspace root, re-hashes
applied files, fails sessions interrupted during writes, and marks sessions
whose integrity could not be checked `needsReview`. See
[SESSIONS_AND_RESUME.md](SESSIONS_AND_RESUME.md).

### Completion report

`src/agent/report.ts` builds a `CompletionReport` from recorded tasks,
validation runs, diagnostics, repairs, and unresolved problems. It is generated
when the session reaches a terminal state and is persisted with the session.

## Change model, review, apply, and undo

- `changes/model.ts` defines create/modify/delete/rename, path normalization,
  SHA-256 hashing, and plan validation.
- `changes/diff.ts` produces unified diffs with an LCS-based implementation, a
  context window, and a linear fallback for large files.
- `changes/review.ts` maps a plan plus baseline content into per-file review
  records: old/new hashes, diff, warnings, and a human description.
- `changes/apply.ts` re-checks hashes, writes only approved IDs, creates
  backups, and reports skipped/conflicted files. Undo restores backups in
  reverse order and refuses to overwrite files that changed after apply.
- `changes/fs.ts` is the only file-writing adapter. It resolves
  workspace-relative paths, rejects escapes, and stores backups under
  `globalStorageUri/backups/<taskId>`.
- `changes/history.ts` persists up to 50 change sets in extension `Memento`
  storage and can restore them.

See [EDITING.md](EDITING.md) for user-facing behavior.

## Command execution

`src/commands/policy.ts` classifies a command as `validation`, `read-only`,
`destructive`, or `unknown`. Destructive commands are refused even if they were
added to the allowlist. `src/commands/runner.ts` then:

- Tokenizes a command without shell expansion.
- Rejects empty, overlong, control-character, or metacharacter-containing
  input.
- Requires the executable token to be a bare command name (no path separators
  or drive letters).
- Requires an exact allowlist match from `quantsmind.commands.allowlist`.
- Requires the working directory to be inside the workspace root.
- Spawns with `shell: false`, a sanitized environment, ignored stdin, and
  captured stdout/stderr.
- Applies an output cap, a timeout, and cancellation.
- Redacts captured output before returning it to the UI.

See [COMMAND_EXECUTION.md](COMMAND_EXECUTION.md) and
[TERMINAL_SECURITY.md](TERMINAL_SECURITY.md).

## Persistence

- Conversations and change history use `context.workspaceState` /
  `context.globalState` `Memento` stores.
- `chat/persistence.ts` caps 30 conversations, 200 messages, and 120,000
  characters per conversation, dropping the oldest entries.
- `changes/history.ts` caps 50 change sets.
- `sessions/repository.ts` stores up to 50 agent sessions under
  `quantsmind.agent.sessions.v1`, each capped at 200,000 serialized characters.
- Credentials remain in SecretStorage and are never part of any store.

## Cancellation and timeout

`src/providers/cancellation.ts` uses an `AbortController`. A cancellation token
listener aborts the request, and a timer aborts it after the total timeout. If
both fire, cancellation wins so the UI can distinguish a user stop from a
timeout. The timer is unref'd and cleared, and the token listener is disposed in
`finally`.

The chat Stop control cancels the active `CancellationTokenSource`. Request
sequence numbers prevent late deltas or errors from a previous request from
being posted after a new chat or a newer request. Agent tasks use the same token
and additionally mark unfinished stages as skipped.

## Errors

`src/providers/errors.ts` normalizes:

| Code | Typical cause |
| --- | --- |
| `configuration` | Invalid endpoint, model, or request shape |
| `authentication` | HTTP 401/403, or missing credential for a remote endpoint |
| `rate_limit` | HTTP 429 |
| `timeout` | HTTP 408 or local total timeout |
| `cancelled` | User stop or abort |
| `network` | DNS, TLS, connection, or redirect rejection |
| `server` | HTTP 5xx |
| `http` | Other HTTP status |
| `invalid_response` | Malformed JSON/SSE or missing completion text |

Messages are control-character-stripped, whitespace-collapsed, truncated, and
redacted. Raw response bodies are never logged or posted wholesale. Authentication
headers and URL userinfo are removed before any error text is surfaced.

## Context pipeline

`src/context/contextService.ts` performs explicit VS Code access:

- `fromSelection`: non-empty selection with 1-based inclusive line numbers.
- `fromActiveFile`: the complete active document.
- `readUris`: stat and read user-picked files with size checks.
- `listAttachableFiles`: enumerate workspace files for an explicit picker,
  filtering exclusions first.

`src/context/filters.ts` is provider-neutral and enforces:

1. Duplicate detection by path, selection kind, and line range.
2. Built-in and user-supplied exclusions with minimatch.
3. Empty, binary, and oversized rejection.
4. Maximum file count.
5. Total character budget with a truncation marker when at least 500 characters
   remain.
6. Secret redaction, including the exact stored credential and masked forms,
   before content can be sent.

`SettingsService.getContextSettings()` always merges the mandatory exclusion
list with user patterns. User settings cannot remove the built-in list.

## Prompts and conversation state

`src/chat/prompts.ts` defines separate read-only and planning system prompts.
Both:

- State which content the model actually received.
- Forbid claiming terminal, file-write, or unobserved workspace access.
- Treat attached content as untrusted data, not instructions.
- Forbid revealing, repeating, or requesting credentials.

The planning prompts require JSON. Chat planning asks for one change set with
`summary`, optional `notes`, and a `changes` array. Agent sessions ask for a
`DevelopmentPlan` with tasks, dependencies, files, criteria, and an optional
allowlisted command. An explicitly empty array is the documented response for
an ambiguous request; the user still reviews and rejects it.

Attached content is wrapped in an `<attached_context>` block with a fenced code
block per item. A fence is lengthened if the content contains backticks, so
content cannot escape its code block. Agent planning and repair wrap retrieved
content in `<workspace_context>` and label it as untrusted reference data.

`src/chat/session.ts` holds the active in-memory session; `persistence.ts`
mirrors it into extension storage within fixed caps.

## Webview security

`src/chat/webviewHtml.ts` emits:

- `default-src 'none'`
- `style-src <cspSource>`
- `script-src 'nonce-<random>`
- `img-src <cspSource> data:`

Scripts and styles are local extension resources with a random nonce. There are
no remote assets and no inline executable script. Attribute values are escaped.

`media/chat.js` treats attachment metadata, diffs, and model output as
untrusted. Metadata uses DOM text APIs. Model output goes through an
escape-first markdown-lite renderer that supports fenced code, inline code, bold
text, and headings without injecting HTML. Streaming updates are batched with
`requestAnimationFrame`.

`src/chat/protocol.ts` strictly parses webview messages. Unknown or malformed
messages are ignored. File writes and command execution require a distinct
approval message carrying the task and change IDs; there is no "apply
everything" message.

## Settings model

`src/config/defaults.ts` defines defaults, mandatory exclusions, and limits.
`src/config/resolve.ts` defensively clamps and normalizes raw VS Code values.
`src/config/settings.ts` reads configuration on demand and exposes a change
listener.

Provider settings are `application` scoped; `context.*` and `workspace.*`
settings are `resource` scoped; `agent.*`, `commands.*`, `agenticEngine.*`,
`languageIntelligence.*` and `mcp.*` settings are `application` scoped. The
API key is not a setting.

## Security boundaries

| Boundary | Control |
| --- | --- |
| Webview to host | Strict message parser; writes require task and change IDs |
| Host to provider | Explicit Send or task start; HTTPS-only remote; redirects rejected |
| Workspace to prompt | Explicit attachment or local retrieval, then review; exclusions and limits |
| Provider plan to disk | Review, per-file approval, hash check, workspace containment |
| Content to prompt/log | Exact-credential, masked-key, token, and userinfo redaction |
| Command execution | Exact allowlist, independent destructive classification, no shell, bare executable, workspace cwd, caps |
| Model to tools | Typed tool router with no default write or execute handler |
| Session restore | Schema validation, workspace-root check, applied-file hash revalidation |
| Credential storage | VS Code SecretStorage; no settings, no logs, no Memento |
| Webview rendering | CSP, nonce, escaped output, no remote resources |

## Independence and package shape

- One npm package, one extension manifest, no workspaces or monorepo tooling.
- One runtime dependency (`minimatch`), pinned.
- No submodules and no Git remote requirement to build.
- No backend or database; the only network peer is the configured provider.
- No QuantsMind-Agent calls, imports, or shared source.
