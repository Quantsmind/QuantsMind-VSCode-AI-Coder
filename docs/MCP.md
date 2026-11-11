# MCP (Model Context Protocol) — v2.5.3

This page documents the actual shipped behaviour of the MCP integration. It
covers transports, configuration, authentication, launch approval, workspace
trust, the permission model, tool invocation, security boundaries, diagnostics,
known limitations, migration and troubleshooting.

## What MCP support exists

- A minimal, real Model Context Protocol client (`src/mcp/client.ts`) with two
  transports behind one interface (`src/mcp/transport.ts`):
  - **stdio** (default; unchanged from v2.5.1/v2.5.2): newline-delimited
    JSON-RPC 2.0 over the child's pipes — `initialize`,
    `notifications/initialized`, `tools/list` and `tools/call`. Everything
    else fails closed.
  - **streamable-http** (new in v2.5.3): MCP Streamable HTTP
    (2025-06-18) against a single HTTPS endpoint. JSON-RPC 2.0 over HTTP POST
    with `Accept: application/json, text/event-stream`; responses arrive as a
    single JSON body or as a `text/event-stream`. `Mcp-Session-Id` is captured
    from the initialize response and echoed on subsequent requests together
    with `MCP-Protocol-Version`. A `404` for a request made with a session id
    terminates the session; the next operation initializes a fresh one.
- Protocol-version negotiation: the client proposes `2025-06-18` and accepts
  servers negotiating `2025-06-18` or `2024-11-05`. Anything else fails the
  handshake with a protocol error. The negotiated version is sent as the
  `MCP-Protocol-Version` header on subsequent requests.
- A `McpServerManager` (`src/mcp/serverManager.ts`) that launches one process
  / opens one connection per server, caches healthy connections across tool
  calls, detects crash/exit/connection-drop, reconnects on the next operation,
  and disposes every connection on extension deactivation (stdio processes are
  terminated; HTTP sessions are terminated with a best-effort `DELETE`).
- Agent tools: `mcp_list_tools` (read-only listing, may connect with
  approval) and `mcp_call` (consequential invocation, approval-gated per
  call).
- A management command, `QuantsMind: Manage MCP Servers`, exposed in the
  command palette and in the status-bar menu.

Transports **not** implemented: legacy HTTP+SSE (the pre-2025-03-26 MCP
transport). Streamable HTTP supersedes it; it is deliberately not shipped.
Remote interoperability is qualified against the in-repo deterministic HTTP
fixture only — see *Third-party interoperability evidence* below.

## Configuration

Servers are configured in the `quantsmind.mcp.servers` **application** setting.

### Local stdio server (unchanged from v2.5.1/v2.5.2)

```json
"quantsmind.mcp.servers": [
  {
    "name": "filesystem",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
    "enabled": true,
    "timeoutMs": 15000,
    "maxToolOutputChars": 30000
  }
]
```

### Remote Streamable HTTP server

```json
"quantsmind.mcp.servers": [
  {
    "name": "company-search",
    "transport": "streamable-http",
    "url": "https://mcp.internal.example.com/mcp",
    "auth": "bearer",
    "enabled": true,
    "timeoutMs": 20000,
    "maxToolOutputChars": 30000
  }
]
```

Properties (all servers):

- `name`: stable identifier (`[A-Za-z0-9._-]`, ≤ 64) used in tool arguments
  and derived SecretStorage keys.
- `transport` (optional): `stdio` (default, including legacy entries without
  the property) or `streamable-http`. Unknown values reject the entry.
- `enabled`: `false` keeps the configuration but forbids launching.
- `timeoutMs` (optional): per-request timeout in milliseconds covering both
  `initialize` and tool-call requests. Default `10000`; clamped to
  `250`–`300,000`. Non-finite or out-of-range values fall back to the
  default. The runtime applies the same clamp again at call time.
- `maxToolOutputChars` (optional): maximum characters of MCP tool output
  returned to the agent; output stays wrapped in the untrusted-data delimiters
  regardless. Default `20000`; clamped to `1,000`–`200,000`. Non-finite or
  out-of-range values fall back to the default.

Stdio only:

- `command` (required): executable token. No shell metacharacters are
  permitted (`"';&|<>$`(){}[]*?!^~%\r\nNUL` are rejected); spaces are allowed
  so normal Windows install paths work. Validated before launch.
- `args` (optional): argument array. Non-string or oversized entries reject
  the server entry, never selectively drop arguments.

Streamable HTTP only:

- `url` (required): the MCP endpoint. `https:` is required for production
  remote connections. `http:` is permitted **only** for loopback
  development/test endpoints (`localhost`, `127.0.0.1`, `::1` / `[::1]`).
  Userinfo (`https://user:pass@host`), query strings and fragments are
  rejected — credentials never belong in the URL; store them with
  `QuantsMind: Manage MCP Servers` (SecretStorage) instead. Any other scheme
  (`file:`, `ftp:`, `ws:`…) is rejected. Malformed endpoints reject the
  entry. Length ≤ 2,048.
- `auth` (optional, default `none`): `none` or `bearer`. `bearer` requires the
  token to be stored in VS Code SecretStorage with
  `QuantsMind: Manage MCP Servers` → the server → `Set or replace bearer
  credential`. It is never written to settings, files, logs or tool output.
  `bearer` is not valid on stdio servers. OAuth is **not** implemented in
  this version (see *Known limitations*).

An HTTP entry that also carries `command` or `args` is rejected as ambiguous
rather than silently half-honoured. A stray `url` on a stdio entry is ignored
and the entry resolves as stdio (documented fallback; transport selection is
always explicit).

- Application scope means a workspace cannot inject a malicious server into
  your configuration. At most 10 servers are tracked.
- Existing configurations without `timeoutMs`/`maxToolOutputChars`/`transport`/
  `auth` keep the defaults (stdio, 10,000 ms, 20,000 chars) and require no
  migration. Changing any launch-relevant setting (including transport, url,
  auth, timeout or output cap) invalidates the cached connection: the manager
  closes the old connection and revokes the cached launch approval for that
  server, so the next operation connects with the new settings and a fresh
  approval.

No server is configured by default; with an empty list, `mcp_list_tools`
fails with an actionable message.

## Authentication (Streamable HTTP)

- Supported: **Bearer-token** authentication, or no authentication. Nothing
  else is offered in this version.
- Tokens are stored in **VS Code SecretStorage** under the per-server key
  `quantsmind.mcp.credential.<name>` and are only ever held in memory while
  connecting. They are never written to settings, files, logs, diagnostics,
  fingerprints, snapshots or tool output.
- At connection time the manager reads the token and passes it to the client,
  which sends it as `Authorization: Bearer …`. On `401`/`403` the connection
  fails with an `auth` error that never contains the token. Error bodies are
  additionally scrubbed of any occurrence of the exact token before being
  surfaced. `Bearer …`-shaped strings are redacted by the shared secret
  redactor as `[REDACTED]` everywhere else.
- Credential management (`QuantsMind: Manage MCP Servers`, per server):
  - `Set or replace bearer credential` — prompts for the token (password
    input), validates it, stores it, then disconnects the server and revokes
    its launch approval.
  - `Remove stored credential` — deletes the key, disconnects the server and
    revokes the launch approval.
  - Removing a server also removes its stored credential.
- Workspace trust and launch approval are independent of authentication: even
  with a stored credential, first-time connection requires explicit approval
  and every tool call requires per-call approval.
- If the credential is missing at connect time the operation fails closed
  with an actionable error; the server is not contacted without it.
- OAuth (including dynamic client registration and PKCE flows) is not
  implemented in this version. It is documented here as future work rather
  than shipped as an incomplete security mechanism.

## TLS requirements

- Remote endpoints must use `https:`. Certificate verification uses the
  platform trust store and is never disabled; there is no setting to disable
  it.
- Plain `http:` is accepted only for loopback endpoints used for local
  development and testing (`localhost`, `127.0.0.1`, `::1` / `[::1]`).
- Redirects are **refused** outright (`redirect: 'error'`): a `30x` response
  is a security error, not a bounce to an unreviewed host. Update the
  endpoint to the final URL instead.
- The endpoint must not embed credentials, a query string or a fragment; the
  resolver and the client both reject such URLs.

## Launch approval

Launching or connecting to any configured server requires **explicit
per-window approval per server**. No trust other than your explicit
confirmation can open a connection.

- The approval prompt names the server and, for stdio servers, its command
  and full arguments, or for HTTP servers its endpoint, transport and
  (optional) authentication scheme, plus the origin (the application
  setting).
- Approval covers the current window session only; it is never persisted and
  is invalidated when you reconfigure or remove the server (any change to
  transport, command/args, endpoint, auth scheme, timeout or output cap).
- Storing or removing a credential revokes the approval as well.
- Revoking a cached approval re-arms the prompt.
- Denied approval never starts the process or opens the connection; the
  agent tool returns a clear refusal naming the server.
- There is no "approve all" option.

## Workspace trust

Workspace trust is required for every MCP operation (listing and calling).
Without a trusted workspace, no server is launched/connected and no MCP tool
runs.

## Permission model

1. **Launch approval** (per server, per window) — starts the process /
   opens the connection.
2. **Workspace trust** — required for any MCP operation.
3. **Per-call approval** — every consequential tool invocation shows the
   server name, tool name, tool description and full arguments before the
   call can proceed. Denied calls are never dispatched to the server.
4. **No implicit grants** — discovery, previous approval or configuration of
   a server never grants an invocation. Each call is individually approved.
5. Tool output is always delimited (`<untrusted-mcp-output>…`), marked
   untrusted and capped in size. It is data for you or the agent to read; it
   is never interpreted as instructions.

## Security boundaries

- **Process model** (stdio): a configured server is an arbitrary local
  process chosen by *you*. It is not sandboxed, jailed or containerized by
  this extension. The operating system is the security boundary.
- **Environment** (stdio): the child environment inherits only an allowlist
  (`PATH`, `SystemRoot`/`WINDIR`, `ComSpec`, `TEMP`, `TMP`, `HOME`/
  `USERPROFILE`, locale). No API keys or tokens are forwarded implicitly.
- **Remote model** (streamable-http): the endpoint is a remote service you
  choose. The extension enforces HTTPS (loopback exception), refuses
  redirects, sends no credentials to non-loopback plain-HTTP endpoints
  (impossible — they are rejected), keeps the bearer token in SecretStorage,
  and never reuses a connection whose configuration changed.
- **Output**: response bodies are read with a hard byte cap (4,000,000 bytes); an
  oversized response drops the connection with a protocol error rather than
  buffering without bound. Server stderr (stdio) is bounded; stdout/SSE
  messages are bounded; everything server-originated is redacted for
  credentials.
- **Sessions**: an HTTP 404 with a session id expires the session; in-flight
  requests fail with a `closed` error and are never replayed. The next
  operation re-initializes a fresh session. A network-level failure or HTTP
  5xx likewise drops the connection. At most one connection per
  configuration exists; retries apply only to the idempotent initialize
  handshake (single retry after 750 ms on network failure) and never to
  tool calls.
- **Server-initiated requests** (e.g. `sampling/createMessage`) are answered
  with JSON-RPC `-32601` (method not found) and never executed, approved or
  forwarded to a provider. Server notifications are counted and ignored.
- **Oversized frames** (stdio): a message larger than 1 MB drops the
  connection and fails pending requests with a protocol error; the server is
  killed.
- **Lifecycle**: connections are cached and reused; repeated
  connect/disconnect cycles do not spawn extra processes or sessions;
  `disconnectAll()` terminates everything on extension deactivation
  (HTTP sessions receive a best-effort bounded `DELETE`); crashed servers
  are detected and disposed.
- **Identity of configuration**: tool calls are bound to a fingerprint of the
  launch-relevant settings (transport, command/args, endpoint, auth scheme,
  limits). Any change evicts the stale connection and revokes its approval.

## Tool invocation

- `mcp_call` verifies that the requested tool exists (`tools/list`) before
  presenting the invocation for approval. Unknown tools fail without ever
  reaching the server.
- Arguments must be a JSON object; non-object arguments are rejected locally.
- Approval prompt shows: server, tool, tool description (if any) and
  arguments (bounded).

## Management UI

`QuantsMind: Manage MCP Servers` (command palette and status-bar menu) lets you:

- View configured servers with connection state (`connected` / `connecting` /
  `disconnected` / `error` / `disabled`), transport (`stdio` /
  `streamable-http`), server info, protocol version and cached tool count.
- Add a server — you choose the transport first:
  - `stdio` — name, executable and arguments.
  - `streamable-http` — name, HTTPS endpoint (validated), and authentication
    (`none` or `bearer`; a bearer token is prompted for and stored in
    SecretStorage, never in settings).
- Edit a server — command/arguments for stdio; endpoint for HTTP (validated;
  the change revokes the cached launch approval and disconnects the stale
  connection).
- Set or replace / remove a stored bearer credential (HTTP, `bearer` auth
  only) — never displays the token.
- Enable, disable or remove a server (removal also deletes any stored
  credential and stops the process / closes the connection).
- Connect / disconnect / restart a server (connect asks for launch approval).
- Discover tools (listing is read-only and never invokes a tool).
- Inspect diagnostics: state, transport, endpoint (HTTP, never credentials),
  auth scheme, launch limits (`timeoutMs` / `maxToolOutputChars`), server
  info, protocol version, cached tool count, last error (redacted) written
  to the `QuantsMind MCP` output channel.

No secrets are ever displayed in the management UI.

## Diagnostics

The `QuantsMind MCP` output channel records launch decisions and results,
connection events, tool selection and errors with timestamps. Deliberate
diagnostics output includes the failing stage (launch, initialize, tools/list,
tools/call) and only sanitized error text. Launch diagnostics include the
transport, (for HTTP) the endpoint and authentication scheme, and the
configured `timeoutMs` / `maxToolOutputChars`, so you can confirm which
settings are in effect. Error bodies from servers are scrubbed of exact
token occurrences and redacted before logging.

## Known limitations

- Streamable HTTP and stdio are the only transports; legacy HTTP+SSE is not
  implemented.
- OAuth is not implemented (see *Authentication*).
- The client does not open the optional standalone `GET` SSE channel; server
  push is handled only within the response stream of a request (notifications
  are counted and server-initiated requests are failed closed with `-32601`).
- A call is pinned to a single connection per window per server; there is no
  built-in failover to another server instance.
- The stdio server process is not sandboxed. Only configure and launch
  servers you trust.
- Output is bounded; huge results are truncated and flagged as truncated.
- Tool definitions are forwarded to the model (bounded to 32 KB serialized)
  but never auto-executed.
- Launch approval is per window and does not persist — restart the window and
  you re-approve each server once. This is deliberate.
- Session termination (`DELETE`) on disconnect is best-effort and bounded by
  a 2 s timeout; if it fails, the session simply expires server-side.
- Remote interoperability in this build is qualified against the in-repo
  deterministic fixture; see *Third-party interoperability evidence*.

## Troubleshooting

- **"No bearer credential is stored for MCP server …"** — open
  `QuantsMind: Manage MCP Servers` → the server → `Set or replace bearer
  credential`. The token is stored in SecretStorage.
- **401/403 after connecting previously** — the token may have been rotated
  or revoked. Replace it with `Set or replace bearer credential`; the old
  connection and approval are revoked automatically.
- **"The MCP session expired (HTTP 404)"** — the server dropped the session.
  The next operation re-initializes a fresh session automatically; tool
  calls are never replayed.
- **"The MCP endpoint attempted a redirect"** — configure the final URL in
  settings; redirects are refused for security.
- **"Plain HTTP is only permitted for loopback endpoints"** — use `https:`
  for remote servers; `http:` is accepted only on `localhost`/`127.0.0.1`/
  `::1` for local development.
- **"The endpoint must not contain a query string"** — credentials and
  parameters in URLs are rejected by design; use `auth: "bearer"` and SecretStorage.
- **Server shows `error` state** — see the `QuantsMind MCP` output channel;
  the failing stage and a sanitized message are logged.
- **Configuration ignored** — an entry that fails validation (bad name,
  unknown transport/auth, missing `url`/`command`, ambiguous fields,
  disallowed scheme) is rejected wholesale; check the setting for the exact
  entry.

## Migration and compatibility

- v2.5.3 is backwards compatible with v2.5.1 and v2.5.2 configurations.
  Entries without `transport` resolve as stdio exactly as before.
- To adopt a remote server, add `transport: "streamable-http"` and `url`;
  stdio entries keep their command/args untouched.
- No schema migration is required; no settings keys are renamed.
- v2.5.2 per-server `timeoutMs` / `maxToolOutputChars` semantics are
  unchanged and apply identically to both transports.
- v2.5.1 approval, invalidation, truncation and untrusted-delimiting
  guarantees are unchanged.

## Third-party interoperability evidence

**Verified against a live third-party server in this lineage (stdio only).**
v2.5.1-A qualified `@modelcontextprotocol/server-filesystem@2.2.0` (pinned,
integrity `sha512-mNLj/qhV+P4kj1qP8VzgQ2fjSmWcKDQ3Q+KpZEA+WahCDWHw5zJBRQUNSPZ6Ai2/ZGGUjzNzsFpz958a1+4T9A==`)
through the production stdio client over an isolated temp root, covering
initialize/protocol-version negotiation, server identity, `tools/list` (16
tools), read-only tool calls, approval/denial dispatch behaviour,
reconnection and timeout behaviour. Fresh execution still requires explicit
authorization in environments where network or package execution is
restricted.

**Remote (Streamable HTTP) interoperability is NOT verified against a live
third-party server in this build.** It is qualified against the in-repo
deterministic fixture (`test/fixtures/mcp-http-server.cjs`) covering
initialize/session lifecycle, protocol negotiation, SSE and JSON response
framing, authentication (success/failure/missing), redirect refusal,
timeouts, cancellation, session expiry, bounded responses, redaction, and
shutdown (`DELETE`). Do not treat this as certification of interoperability
with a particular vendor server; verify against your own authorized server
with `QuantsMind: Manage MCP Servers` before depending on it.
