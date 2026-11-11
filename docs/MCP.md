# MCP (Model Context Protocol) — v2.5.2

This page documents the actual shipped behaviour of the MCP integration. It
covers configuration, launch approval, workspace trust, the permission model,
tool invocation, security boundaries, diagnostics, known limitations and the
third-party interoperability evidence.

## What MCP support exists

- A minimal, real Model Context Protocol client (`src/mcp/client.ts`):
  newline-delimited JSON-RPC 2.0 over **stdio**, implementing exactly
  `initialize`, `notifications/initialized`, `tools/list` and `tools/call`.
  Everything else fails closed.
- Protocol-version negotiation: the client proposes `2025-06-18` and accepts
  servers negotiating `2025-06-18` or `2024-11-05`. Anything else fails the
  handshake with a protocol error.
- A `McpServerManager` (`src/mcp/serverManager.ts`) that launches one process
  per server, caches healthy connections across tool calls, performs
  crash/exit detection with automatic reconnect on the next operation, and
  disposes every child process on extension deactivation.
- Agent tools: `mcp_list_tools` (read-only listing, may launch with approval)
  and `mcp_call` (consequential invocation, approval-gated per call).
- A management command, `QuantsMind: Manage MCP Servers`, exposed in the
  command palette and in the status-bar menu.

Transports **not** implemented: streamable HTTP and SSE. Stdio is the only
supported transport in this release.

## Configuration

Servers are configured in the `quantsmind.mcp.servers` **application** setting:

```json
"quantsmind.mcp.servers": [
  {
    "name": "filesystem",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
    "enabled": true,
    "timeoutMs": 15000,
    "maxToolOutputChars": 30000
  },
  {
    "name": "with-defaults",
    "command": "node",
    "args": ["./server.cjs"]
  }
]
```

- `name`: stable identifier used in tool arguments (`[A-Za-z0-9._-]`, ≤ 64).
- `command`: executable token. No shell metacharacters are permitted
  (`"';&|<>$`(){}[]*?!^~%\r\nNUL` are rejected); spaces are allowed so normal
  Windows install paths work. Validated before launch.
- `args`: argument array. Non-string or oversized entries reject the server
  entry, never selectively drop arguments.
- `enabled`: `false` keeps the configuration but forbids launching.
- `timeoutMs` (optional): per-request timeout in milliseconds, covering both
  `initialize` and tool-call requests. Default `10000`; clamped to `250`–`300,000`.
  Non-finite or out-of-range values fall back to the default. The runtime
  applies the same clamp again at call time.
- `maxToolOutputChars` (optional): maximum characters of MCP tool output
  returned to the agent; output stays wrapped in the untrusted-data delimiters
  regardless. Default `20000`; clamped to `1,000`–`200,000`. Non-finite or
  out-of-range values fall back to the default.
- Application scope means a workspace cannot inject a malicious server into
  your configuration. At most 10 servers are tracked.

Existing configurations without `timeoutMs`/`maxToolOutputChars` keep the
defaults and require no migration. Changing any setting for a cached server
(including `timeoutMs`/`maxToolOutputChars`, command, args or `enabled`)
invalidates the cached connection: the manager closes the old process and
revokes the cached launch approval for that server, so the next operation
launches with the new settings and a fresh approval.

No server is configured by default; with an empty list, `mcp_list_tools` fails
with an actionable message.

## Launch approval

Launching any configured server requires **explicit per-window approval per
server**. No trust other than your explicit confirmation can start a server.

- The approval prompt names the server, its command, its full arguments and
  the launch origin (the application setting).
- Approval covers the current window session only; it is never persisted and
  is invalidated when you reconfigure or remove the server.
- Revoking a cached approval re-arms the prompt.
- Denied launch approval never starts the process; the agent tool returns a
  clear refusal naming the server.
- Approval for *tone of voice*: there is no "approve all" option.

## Workspace trust

Workspace trust is required for every MCP operation (listing and calling).
Without a trusted workspace, no server is launched and no MCP tool runs.

## Permission model

1. **Launch approval** (per server, per window) — starts the process.
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

- **Process model**: a configured server is an arbitrary local process chosen
  by *you*. It is not sandboxed, jailed or containerized by this extension.
  The operating system is the security boundary; the extension provides no
  additional isolation between the server and your user account.
- **Environment**: the child environment inherits only an allowlist
  (`PATH`, `SystemRoot`/`WINDIR`, `ComSpec`, `TEMP`, `TMP`, `HOME`/
  `USERPROFILE`, locale). No API keys, no access tokens, no ambient secrets
  are forwarded. Additional variables must be passed explicitly via the
  server's `env` configuration.
- **Output**: server stdout and stderr are bounded (stream message cap,
  stderr tail cap), redacted for credentials and never logged verbatim to a
  persistent channel.
- **Oversized frames**: a message larger than 1 MB drops the connection and
  fails pending requests with a protocol error; the server is killed.
- **Lifecycle**: connections are cached and reused; repeated connect/disconnect
  cycles do not spawn extra processes; `disconnectAll()` terminates every
  child on extension deactivation; crashed servers are detected and disposed.
- **Transport safety**: newline-delimited JSON-RPC only, malformed frames are
  skipped, concurrent requests are handled by id, cancellation issues
  `notifications/cancelled` to the server.

## Tool invocation

- `mcp_call` verifies that the requested tool exists (`tools/list`) before
  presenting the invocation for approval. Unknown tools fail without ever
  reaching the server.
- Arguments must be a JSON object; non-object arguments are rejected locally.
- Approval prompt shows: server, tool, tool description (if any) and arguments
  (bounded).

## Management UI

`QuantsMind: Manage MCP Servers` (command palette and status-bar menu) lets you:

- View configured servers with connection state (`connected` / `connecting` /
  `disconnected` / `error` / `disabled`), server info, protocol version and
  cached tool count.
- Add, edit, enable, disable or remove a server (configuration is validated;
  editing revokes the cached launch approval).
- Connect / disconnect / restart a server (connect asks for launch approval).
- Discover tools (listing is read-only and never invokes a tool).
- Inspect diagnostics: state, launch limits (`timeoutMs` / `maxToolOutputChars`),
  server info, protocol version, cached tool count, last error and stderr tail
  (redacted) written to the `QuantsMind MCP` output channel.

No secrets are ever displayed in the management UI.

## Diagnostics

The `QuantsMind MCP` output channel records launch decisions and results,
connection events, tool selection and errors with timestamps. Deliberate
diagnostics output includes the failing stage (launch, initialize, tools/list,
tools/call) and only sanitized error text. Launch diagnostics include the
configured `timeoutMs` / `maxToolOutputChars` so you can confirm which limits
are in effect.

## Known limitations

- Stdio transport only; no HTTP/SSE transport yet.
- A call is pinned to a single connection per window per server; there is no
  built-in failover to another server instance.
- The server process is not sandboxed. Only configure and launch servers you
  trust.
- Output is bounded; huge results are truncated and flagged as truncated.
- Tool definitions are forwarded to the model (bounded to 32 KB serialized)
  but never auto-executed.
- Launch approval is per window and does not persist — restart the window and
  you re-approve each server once. This is deliberate.

## Third-party interoperability evidence

**Verified against a live third-party server in this lineage.** v2.5.1-A
qualified `@modelcontextprotocol/server-filesystem@2.2.0` (pinned, integrity
`sha512-mNLj/qhV+P4kj1qP8VzgQ2fjSmWcKDQ3Q+KpZEA+WahCDWHw5zJBRQUNSPZ6Ai2/ZGGUjzNzsFpz958a1+4T9A==`)
through the production stdio client over an isolated temp root, covering
initialize/protocol-version negotiation, server identity, `tools/list` (16 tools),
read-only tool calls (`list_allowed_directories`, `list_directory`,
`read_text_file`), approval/denial dispatch behavior, reconnection and timeout
behavior. See the v2.5.1-A qualification report and `test/unit/mcpSecurity.test.ts`
for the committed boundary coverage. Fresh execution still requires explicit
authorization in environments where network or package execution is restricted.

To verify against a real server after authorizing it, use:

```json
"quantsmind.mcp.servers": [
  { "name": "filesystem", "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem@2.2.0", "."] }
]
```

then `QuantsMind: Manage MCP Servers` → `filesystem` → `Connect` →
`Discover tools`, and try one read-only tool. Pin exact versions.
