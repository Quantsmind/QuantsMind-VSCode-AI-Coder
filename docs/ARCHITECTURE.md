# Architecture

QuantsMind AI Coder is a single VS Code extension written in TypeScript. It has
no backend, database, telemetry service, Python runtime, or QuantsMind project
dependency.

## Layers

```text
VS Code host
  extension.ts
    commands, status bar, SecretStorage, OutputChannel
        |
        +-- ChatViewProvider (webview lifecycle and chat orchestration)
        |     +-- protocol.ts, session.ts, prompts.ts, webviewHtml.ts
        |
        +-- CompletionService (provider-neutral request orchestration)
        |     +-- registry.ts -> openaiCompatible.ts
        |           +-- endpoint.ts, cancellation.ts, errors.ts, sse.ts
        |
        +-- ContextService (explicit VS Code file/editor access)
        |     +-- filters.ts (exclusions, limits, redaction)
        |
        +-- SettingsService / resolve.ts / defaults.ts
        |
        +-- security: credential.ts, secretStore.ts, redact.ts, logger.ts
```

Pure modules do not import `vscode`, which keeps them unit-testable in plain
Node. VS Code adapters are limited to `extension.ts`, `config/settings.ts`,
`context/contextService.ts`, and `chat/chatViewProvider.ts`.

## Activation and deactivation

`src/extension.ts` activates on `onStartupFinished`. It:

1. Creates a redacting logger over an OutputChannel.
2. Constructs SecretStorage, settings, completion, context, and chat services.
3. Registers the `quantsmind.chatView` webview view provider.
4. Creates a status bar item that reports provider readiness.
5. Registers all contributed commands with a guard that logs sanitized errors
   and shows a normalized message.
6. Subscribes to configuration and SecretStorage changes to refresh status.
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

`src/providers/registry.ts` maps a provider type to a factory. v0.1.0 registers
only `openai-compatible`. Adding a provider means implementing `AiProvider` and
registering it; the chat layer does not change.

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
- Bounds error bodies to 64 KB, JSON bodies to 20 MB, a single SSE event to
  1,000,000 characters, and request content to 2,000,000 characters.

## Request lifecycle

```text
User presses Send
  -> ChatViewProvider checks provider status
  -> builds redacted context from current attachments
  -> builds system prompt + history + user content
  -> CompletionService resolves settings and credential
  -> registry creates the adapter
  -> withAbort composes cancellation token and total timeout
  -> HTTPS request
  -> JSON or SSE parsing
  -> assistant deltas posted to the webview
  -> assistant text added to the in-memory session
```

Nothing in this path writes a workspace file or executes a command.

## Cancellation and timeout

`src/providers/cancellation.ts` uses an `AbortController`. A cancellation token
listener aborts the request, and a timer aborts it after the total timeout. If
both fire, cancellation wins so the UI can distinguish a user stop from a
timeout. The timer is unref'd and cleared, and the token listener is disposed in
`finally`.

The chat Stop control cancels the active `CancellationTokenSource`. Request
sequence numbers prevent late deltas or errors from a previous request from
being posted after a new chat or a newer request.

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
redacted. Raw response bodies are never logged or posted wholesale.

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
6. Secret redaction, including the exact stored credential, before content can
   be sent.

`SettingsService.getContextSettings()` always merges the mandatory exclusion
list with user patterns. User settings cannot remove the built-in list.

## Chat prompts and session

`src/chat/prompts.ts` defines a system prompt that:

- States the model sees only explicitly attached code.
- Forbids claiming workspace, terminal, or file access.
- Requires proposals as reviewable code blocks, never applied changes.
- Treats attached content as untrusted data, not instructions.
- Forbids revealing, repeating, or requesting credentials.

Attached content is wrapped in an `<attached_context>` block with a fenced code
block per item. A fence is lengthened if the content contains backticks, so
content cannot escape its code block.

`src/chat/session.ts` keeps bounded in-memory history. It is not persisted.

## Webview security

`src/chat/webviewHtml.ts` emits:

- `default-src 'none'`
- `style-src <cspSource>`
- `script-src 'nonce-<random>`
- `img-src <cspSource> data:`

Scripts and styles are local extension resources with a random nonce. There are
no remote assets and no inline executable script. Attribute values are escaped.

`media/chat.js` treats attachment metadata and model output as untrusted. Metadata
uses DOM text APIs. Model output goes through an escape-first markdown-lite
renderer that supports fenced code, inline code, bold text, and headings without
injecting HTML. Streaming updates are batched with `requestAnimationFrame`.

`src/chat/protocol.ts` strictly parses webview messages. Unknown or malformed
messages are ignored. There is no webview command that writes files or executes
processes.

## Settings model

`src/config/defaults.ts` defines defaults, mandatory exclusions, and limits.
`src/config/resolve.ts` defensively clamps and normalizes raw VS Code values.
`src/config/settings.ts` reads configuration on demand and exposes a change
listener.

Provider settings are `application` scoped; context settings are `resource`
scoped. The API key is not a setting.

## Security boundaries

| Boundary | Control |
| --- | --- |
| Webview to host | Strict message parser; no command or file-write message |
| Host to provider | Explicit Send; HTTPS-only remote; redirects rejected |
| Workspace to prompt | Explicit attachment; mandatory exclusions; size limits |
| Content to prompt/log | Secret redaction and exact credential replacement |
| Credential storage | VS Code SecretStorage; no settings, no logs |
| Webview rendering | CSP, nonce, escaped output, no remote resources |

## Independence and package shape

- One npm package, one extension manifest, no workspaces or monorepo tooling.
- One runtime dependency (`minimatch`), pinned.
- No submodules and no Git remote requirement to build.
- No backend or database; the only network peer is the configured provider.
- No QuantsMind-Agent calls, imports, or shared source.
