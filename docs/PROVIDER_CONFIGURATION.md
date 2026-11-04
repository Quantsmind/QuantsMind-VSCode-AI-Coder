# Provider configuration

QuantsMind is provider-neutral. This build supports the OpenAI-compatible chat
completions shape, including OpenAI, OpenRouter-compatible endpoints, and local
servers that expose the same API.

Implementation: [src/providers](../src/providers),
[src/config](../src/config).

## Configure a provider

1. Run **QuantsMind: Set API Key**. The input is masked and stored in VS Code
   SecretStorage. There is no API-key setting.
2. Run **QuantsMind: Configure Provider** to set the base URL, model, timeout,
   and other options. Provider settings are application-scoped.
3. Optionally run **QuantsMind: Select Model** to change the model quickly.

Example `settings.json`:

```json
{
  "quantsmind.provider.type": "openai-compatible",
  "quantsmind.provider.baseUrl": "https://api.openai.com/v1",
  "quantsmind.provider.model": "gpt-4o-mini",
  "quantsmind.provider.stream": true
}
```

For a local server on port `11434`:

```json
{
  "quantsmind.provider.baseUrl": "http://127.0.0.1:11434/v1",
  "quantsmind.provider.model": "your-local-model"
}
```

Plain HTTP is accepted only for `localhost`, `127.0.0.1`, and `::1`, and only
while `quantsmind.provider.allowInsecureLocalhost` is enabled. Remote endpoints
must use HTTPS.

## Settings

| Setting | Default | Scope | Purpose |
| --- | --- | --- | --- |
| `quantsmind.provider.type` | `openai-compatible` | application | Provider adapter |
| `quantsmind.provider.baseUrl` | `https://api.openai.com/v1` | application | API root URL |
| `quantsmind.provider.model` | `gpt-4o-mini` | application | Model identifier |
| `quantsmind.provider.requestTimeoutMs` | `120000` | application | Total request timeout |
| `quantsmind.provider.maxOutputTokens` | `2048` | application | `max_tokens` value |
| `quantsmind.provider.temperature` | `0.2` | application | Sampling temperature |
| `quantsmind.provider.stream` | `true` | application | Prefer SSE streaming |
| `quantsmind.provider.allowInsecureLocalhost` | `true` | application | Permit loopback HTTP |

Provider settings are application-scoped so a workspace cannot redirect a
stored credential to a different host. Changing the base URL changes where the
credential is sent; review it before using an unfamiliar workspace.

## Endpoint validation

`normalizeBaseUrl` enforces:

- the URL must parse and use `https:` or loopback `http:`;
- embedded username or password is rejected;
- query strings and fragments are rejected;
- loopback HTTP requires `allowInsecureLocalhost`;
- trailing slashes are removed.

The extension appends `/chat/completions` unless the base URL already ends with
it.

## Plain HTTP to a local provider

`quantsmind.provider.allowInsecureLocalhost` ships enabled, so a local runtime
such as Ollama or LM Studio works without any configuration. Enabling HTTPS-only
is one setting change:

```json
{
  "quantsmind.provider.allowInsecureLocalhost": false
}
```

What the setting does and does not gate:

| Endpoint | Setting `true` (default) | Setting `false` |
| --- | --- | --- |
| `https://` remote | allowed | allowed |
| `http://localhost`, `http://127.0.0.1`, `http://[::1]` | allowed | rejected |
| `http://` any other host | rejected | rejected |

Remote plain HTTP is never available; the setting cannot widen it.

### Threat model

An `http://` endpoint carries the prompt — which can contain workspace file
contents — and, when a credential is stored for that provider type, the
`Authorization` header in clear text. On a loopback address there is no network
path to sniff, so the realistic exposure is different from remote HTTP:

- **any process on this machine can answer that port.** Loopback is not an
  access control; a local application that binds `127.0.0.1:11434` before your
  runtime does receives the prompt and the key. Treat the setting as safe only
  for a runtime you started yourself.
- **a bound port is also unauthenticated.** A loopback host is trusted by the
  status check, so a request goes ahead with no credential if none is stored.
- **turning on a proxy or forwarding the port** (SSH tunnel, `socat`, container
  port mapping) puts that clear-text traffic on a real network, where the
  original loopback reasoning no longer applies.
- **workspace trust does not help here.** The transport is chosen from
  application-scoped settings, so a restricted workspace still sends requests
  over the configured transport.

Set the value to `false` if other users or untrusted software share the machine,
or run the local runtime behind a TLS-terminating proxy.

### Every insecure request is logged

The trade-off is visible at the time it is taken: each completion that resolves
to an `http:` endpoint writes a warn-level line to the `QuantsMind AI Coder`
Output channel before the request is sent. Every line is timestamp-prefixed, so
what you see is:

```
2026-11-04T12:00:00.000Z [warn] insecure transport provider=openai-compatible host=127.0.0.1:11434 scheme=http allowInsecureLocalhost=true — this request and any stored secret reach the loopback host unencrypted
```

One line per request, so a busy session produces many. HTTPS endpoints and
rejected remote-HTTP endpoints produce nothing. The line carries the host and
the setting state only — never the key, the prompt, or any header value.

## Capabilities

Every provider reports a `ProviderCapabilities` descriptor:

```ts
interface ProviderCapabilities {
  readonly nativeToolCalling: boolean;
  readonly structuredOutput: boolean;
  readonly streaming: boolean;
  readonly maxContextChars: number;
}
```

In this build `nativeToolCalling` is always `false`: executable tool definitions
are never sent to a provider. `structuredOutput` is `true` because the prompt
requests JSON and the local parser validates it, not because the provider has a
native structured-output mode. `streaming` follows the configured setting.
`maxContextChars` is advisory guidance derived from the retrieval budget
(`retrievalMaxChars`, clamped by `maxTotalChars`); it is not a provider-enforced
limit.

## Streaming and non-streaming

- With `stream: true`, the client requests SSE and renders content
  incrementally. A Stop control aborts the request.
- With `stream: false`, the client reads a single JSON completion.
- Both modes enforce `requestTimeoutMs` and cancellation.

Streaming is used for chat. Planning and repair requests use the same provider
client and limits.

## Normalized errors

Provider failures are normalized to stable codes with actionable hints:

| Code | Typical cause |
| --- | --- |
| `configuration` | Missing or invalid URL, model, or settings |
| `authentication` | Missing, invalid, or rejected key |
| `rate_limit` | Provider throttling |
| `timeout` | Request exceeded `requestTimeoutMs` |
| `cancelled` | The user stopped the request |
| `network` | DNS, connection, or TLS failure |
| `server` | Provider 5xx response |
| `http` | Other non-success HTTP response |
| `invalid_response` | Response was not usable JSON or SSE |

Error messages are sanitized and redacted. A masked key (`sk-…abcd`) is never
echoed; the error panel explains that the key is masked and offers actions to
set a key, open settings, or show the log.

## Extending providers

The registry in [src/providers/registry.ts](../src/providers/registry.ts) is the
only extension point. Registering a new provider means adding a factory there;
the chat and agent layers depend on `AiProvider` and do not change.

## Related pages

- [Providers](PROVIDERS.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [V030_PROVIDER_AND_TOOL_CONTRACTS.md](architecture/V030_PROVIDER_AND_TOOL_CONTRACTS.md)
