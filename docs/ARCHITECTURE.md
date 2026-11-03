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
        |     +-- registry.ts -> openaiCompatible.ts
        |           +-- endpoint.ts, cancellation.ts, errors.ts, sse.ts
        |
        +-- ContextService (explicit VS Code file/editor access)
        |     +-- filters.ts (exclusions, limits, redaction)
        |
        +-- WorkspaceIndexService (local index and relevance retrieval)
        |     +-- analyze.ts, ignore.ts
        |
        +-- AgentTaskRunner (staged plan/review/apply/validate/repair)
        |     +-- changes/plan.ts
        |
        +-- ChangeService (prepare, apply, undo, history)
        |     +-- model.ts, diff.ts, review.ts, apply.ts, fs.ts, history.ts
        |
        +-- CommandRunner (approved, allowlisted validation commands)
        |
        +-- SettingsService / resolve.ts / defaults.ts
        |
        +-- security: credential.ts, secretStore.ts, redact.ts, logger.ts
```

Pure modules do not import `vscode`, which keeps them unit-testable in plain
Node. VS Code adapters are limited to `extension.ts`, `config/settings.ts`,
`context/contextService.ts`, `workspace/indexService.ts`,
`changes/changeService.ts`, `changes/fs.ts`, and `chat/chatViewProvider.ts`.

## Activation and deactivation

`src/extension.ts` activates on `onStartupFinished`. It:

1. Creates a redacting logger over an OutputChannel.
2. Constructs SecretStorage, settings, completion, context, workspace index,
   change history, change service, command runner, agent runner, and chat
   services.
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

`src/providers/registry.ts` maps a provider type to a factory. v0.2.0 registers
only `openai-compatible`. Adding a provider means implementing `AiProvider` and
registering it; the chat and agent layers do not change. See
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
- Rejects tool-call responses, because v0.2.0 does not implement tool calling.
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

## Agent task workflow

`src/agent/taskRunner.ts` orchestrates a bounded task:

```text
retrieve -> plan -> review -> approval -> apply -> validate -> repair
```

- **retrieve** selects relevant workspace content.
- **plan** asks the provider for JSON, parsed by `changes/plan.ts` into a
  `ChangePlan`.
- **review** builds diffs and warnings without touching files.
- **approval** is a terminal pause. The task status becomes
  `awaiting-approval`; no file has been written.
- **apply** runs only for explicitly approved change IDs.
- **validate** runs one user-selected, allowlisted command.
- **repair** asks for one bounded replacement plan after a failure; the repair
  is reviewed and approved again.

Provider calls are limited by `quantsmind.agent.maxSteps`, repair passes by
`quantsmind.agent.maxRepairIterations`, and each step by
`quantsmind.agent.timeoutMs`. Cancellation moves pending stages to `skipped` and
never reports success. A final status of `applied` is only set after the
approved writes complete.

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

`src/commands/runner.ts`:

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

See [TERMINAL_SECURITY.md](TERMINAL_SECURITY.md).

## Persistence

- Conversations and change history use `context.workspaceState` /
  `context.globalState` `Memento` stores.
- `chat/persistence.ts` caps 30 conversations, 200 messages, and 120,000
  characters per conversation, dropping the oldest entries.
- `changes/history.ts` caps 50 change sets.
- Credentials remain in SecretStorage and are never part of either store.

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

The planning prompt requires a JSON object with `summary`, optional `notes`, and
a `changes` array. An explicitly empty array is the documented response for an
ambiguous request; the user still reviews and rejects it.

Attached content is wrapped in an `<attached_context>` block with a fenced code
block per item. A fence is lengthened if the content contains backticks, so
content cannot escape its code block.

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

Provider settings are `application` scoped; context, workspace, agent, and
command settings are `resource` scoped. The API key is not a setting.

## Security boundaries

| Boundary | Control |
| --- | --- |
| Webview to host | Strict message parser; writes require task and change IDs |
| Host to provider | Explicit Send or task start; HTTPS-only remote; redirects rejected |
| Workspace to prompt | Explicit attachment or local retrieval, then review; exclusions and limits |
| Provider plan to disk | Review, per-file approval, hash check, workspace containment |
| Content to prompt/log | Exact-credential, masked-key, token, and userinfo redaction |
| Command execution | Exact allowlist, no shell, bare executable, workspace cwd, caps |
| Credential storage | VS Code SecretStorage; no settings, no logs, no Memento |
| Webview rendering | CSP, nonce, escaped output, no remote resources |

## Independence and package shape

- One npm package, one extension manifest, no workspaces or monorepo tooling.
- One runtime dependency (`minimatch`), pinned.
- No submodules and no Git remote requirement to build.
- No backend or database; the only network peer is the configured provider.
- No QuantsMind-Agent calls, imports, or shared source.
