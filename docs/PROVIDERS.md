# Providers

QuantsMind AI Coder uses a provider-neutral core and ships one adapter: an
OpenAI-compatible `/chat/completions` client. The same adapter works with
OpenAI, OpenRouter, and compatible self-hosted or local servers.

## Contract

`src/providers/types.ts` defines:

- `ChatMessage` with `role` and `content`.
- `CompletionRequest` with model, messages, stream flag, and limits.
- `CompletionOptions` with a cancellation token, total timeout, and optional
  streaming callback.
- `CompletionResult` with text, model, finish reason, and usage.
- `AiProvider` with `id`, `displayName`, and `complete`.

`src/providers/registry.ts` maps `quantsmind.provider.type` to a factory.
v0.2.0 registers `openai-compatible`. The chat layer and the agent task runner
only depend on the contract, so a new provider does not require changes there.

## Configuration

| Setting | Scope | Default |
| --- | --- | --- |
| `quantsmind.provider.type` | application | `openai-compatible` |
| `quantsmind.provider.baseUrl` | application | `https://api.openai.com/v1` |
| `quantsmind.provider.model` | application | `gpt-4o-mini` |
| `quantsmind.provider.requestTimeoutMs` | application | `120000` |
| `quantsmind.provider.maxOutputTokens` | application | `2048` |
| `quantsmind.provider.temperature` | application | `0.2` |
| `quantsmind.provider.stream` | application | `true` |
| `quantsmind.provider.allowInsecureLocalhost` | application | `true` |

Provider settings are application-scoped so a workspace cannot redirect a stored
credential to a different host.

The API key is stored with **QuantsMind: Set API Key** in VS Code SecretStorage.
There is no key setting.

## Endpoint rules

- The base URL must not contain embedded credentials, a query string, or a
  fragment.
- Remote endpoints must use HTTPS.
- Plain HTTP is accepted only for `localhost`, `127.0.0.1`, and `::1`, and only
  when loopback HTTP is enabled.
- The extension appends `/chat/completions` and rejects redirects, so an
  endpoint cannot forward a request to another host.

## Request shape

```http
POST <baseUrl>/chat/completions
Content-Type: application/json
Accept: text/event-stream        (streaming) or application/json
Authorization: Bearer <credential>   (remote providers)
User-Agent: QuantsMind-VSCode-AI-Coder/0.2.0

{
  "model": "gpt-4o-mini",
  "messages": [{ "role": "system", "content": "..." }, { "role": "user", "content": "..." }],
  "stream": true,
  "temperature": 0.2,
  "max_tokens": 2048
}
```

Loopback endpoints may omit the credential. A remote endpoint without a
credential fails with an `authentication` error before any request is sent.

## Streaming

When streaming is enabled, the adapter parses server-sent events incrementally
and forwards text deltas. The webview batches rendering with
`requestAnimationFrame`. If the provider returns JSON instead, the adapter
accepts it and renders the whole message. A malformed stream produces an
`invalid_response` error rather than a partial success claim.

## Errors

| Code | Typical cause | Hint |
| --- | --- | --- |
| `configuration` | Invalid endpoint, model, or request | Check provider settings |
| `authentication` | 401/403 or missing credential | Set or replace the API key; a masked key is not a valid credential |
| `rate_limit` | 429 | Wait and retry |
| `timeout` | 408 or local timeout | Increase the timeout or retry |
| `cancelled` | User stop | None; the request was cancelled |
| `network` | DNS, TLS, connection, redirect | Check the endpoint and network |
| `server` | 5xx | Retry later or check provider status |
| `http` | Other status | Inspect the safe, truncated message |
| `invalid_response` | Malformed JSON/SSE or missing text | Retry or change model |

Messages are stripped of control characters, collapsed, truncated, and
redacted. Authorization headers, URL userinfo, exact credentials, and masked key
fragments are removed before display or logging.

## OpenRouter example

```json
{
  "quantsmind.provider.baseUrl": "https://openrouter.ai/api/v1",
  "quantsmind.provider.model": "your-openrouter-model"
}
```

Set the OpenRouter key through **QuantsMind: Set API Key**. OpenRouter-specific
headers are not sent, because the adapter targets the common
`/chat/completions` shape.

## Adding a provider

1. Implement `AiProvider` in `src/providers/`.
2. Register a factory in `src/providers/registry.ts`.
3. Add the provider type to the `quantsmind.provider.type` enum in
   `package.json`.
4. Reuse `endpoint.ts`, `cancellation.ts`, and `errors.ts` so transport and
   sanitization behavior stays consistent.
5. Add unit tests with a loopback server and never a live credential.
