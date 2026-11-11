# Advanced AI intelligence (v2.5.0)

This page describes the v2.5.0 additions: what they do, what they deliberately
do not do, and the current evidence level. Everything lives in normal tool
paths; nothing bypasses the existing approval or trust boundaries.

## Provider expansion (WP1)

- **Usage reporting.** A bounded in-memory `UsageLedger` records the token
  counts providers actually report (prompt/completion/total), per provider and
  per model, for the current session. `get_usage` reports the summary to the
  agent. Providers that report nothing produce no record — nothing is
  estimated.
- **Cost estimates, honestly.** `estimateCost` computes a cost only from an
  explicit rate card supplied by the host. No rate is shipped in this
  extension; pricing information is never invented.
- **Paid-provider consent gate.** Autonomous agent calls to a `paid`-classified
  provider require an explicit, per-window consent granted once per provider
  (a modal listing the access class and the provider's pricing reference).
  Consent is never persisted and can be revoked. `PaidConsentError` blocks the
  call when consent is not granted. Free/local/unknown providers are never
  gated or assumed paid.
- **Free vs paid visibility.** Provider profiles already classify access
  (`free-no-key` / `free-tier-key` / `paid` / `local` / `custom-unknown`) and
  carry the verification source for each classification.

## Orchestration (WP2)

- A bounded, per-task **shared context** store (`TaskContextStore`) lets
  subtasks exchange decisions and findings (`context_set` / `context_get` /
  `context_list`). Entries are in-memory, capped, and discarded on restart.
- Multi-step sessions already run through the agent orchestrator: dependency
  scheduling, per-task change review, approval boundaries, cancellation,
  timeouts, checkpoint-backed restore, and duplicate-invocation protection.
  All of that existing behaviour is preserved unchanged.

## Project intelligence (WP3)

- Retrieval results now carry a `budget` report: estimated token usage per
  selected file, total budget (chars/4), and every skipped file with its
  reason. Selection visibility is reported, not second-guessed.
- `estimateTokens` (chars/4) is a deterministic estimate; provider-reported
  usage remains authoritative.

## Coding workflows (v2.5.5) — structured plans and validation

See [Coding workflows](CODING_WORKFLOWS.md) for the full contract:
structured plans for substantial tasks (routing, categories, evidence
vs assumptions), multi-file change tracking against the plan, patch safety
and cancellation, checkpoint phases and crash restoration, and the
detect-then-propose validation workflow. v2.5.5 composes existing systems
(development planner, repository/language intelligence, change-set/apply
pipeline, continuation planner) without enabling any autonomous execution or
changing any approval boundary.

## Language intelligence (WP1–WP6) — added in v2.5.4

See [Language intelligence](LANGUAGE_INTELLIGENCE.md) for the full contract:
supported language families and qualification levels, workspace detection,
context selection with cross-language relations, language-adaptive prompts,
configuration and performance limits. v2.5.4 adds a central language
capability registry, a bounded workspace language inventory (primary and
supporting languages, detection confidence), language-adaptive prompts for
the coding agent and chat, cross-language relationships in context selection
(shared API contracts, SQL schema ↔ models, client/server pairs, build
files ↔ compiled sources) and a `quantsmind.languageIntelligence.enabled`
switch (default true). Unknown languages degrade gracefully; providers are
not retrained.

## MCP integration (WP4) — hardened in v2.5.1, configurable in v2.5.2, remote in v2.5.3

See [MCP (Model Context Protocol) — v2.5.3](MCP.md) for the full contract:
transports, configuration, authentication, launch approval, workspace trust,
the permission model, tool invocation, security boundaries, diagnostics,
known limitations, migration and troubleshooting. v2.5.3 adds the MCP
Streamable HTTP transport alongside stdio: remote servers are configured with
`transport: "streamable-http"` and an HTTPS `url` (plain HTTP only for
loopback development/test), authenticate with an optional bearer token stored
in VS Code SecretStorage (`QuantsMind: Manage MCP Servers`), and go through
the same trust gate, per-window launch approval, per-call approval, output
delimiting, timeout and output caps, configuration-fingerprint invalidation
and lifecycle management as stdio servers. Redirects are refused, response
bodies are read with a hard byte cap, session expiry and network drops drop
the connection (requests are never replayed), and server-initiated requests
fail closed with JSON-RPC `-32601`.

v2.5.2 made the per-server limits user-configurable: each server's `timeoutMs`
(10,000 ms default, 250–300,000 ms) and `maxToolOutputChars` (20,000 default,
1,000–200,000) pass through from VS Code settings through
`resolveMcpSettings` → `McpServerManager` (with a configuration fingerprint that
invalidates stale connections and cached launch approvals on change) →
`McpClient` → the actual request timer and output clamp. Legacy configurations
without these properties keep the defaults and require no migration.

At a glance:

- Real MCP client with two transports behind one interface: stdio
  (newline-delimited JSON-RPC 2.0) and Streamable HTTP (HTTPS, SSE/JSON
  framing, sessions with 404-expiry handling, redirect refusal, hard response
  caps). Both share protocol-version negotiation, timeouts, redacted errors
  and an `McpServerManager` that caches connections, reconnects across
  crashes/drops/session-expiry, never replays tool calls, and terminates
  everything on deactivation.
- `quantsmind.manageMcpServers` (command palette / status-bar menu): view,
  add, edit, enable/disable, connect/disconnect/restart, discover tools,
  manage bearer credentials and view diagnostics for configured servers.
  No secrets are ever displayed.
- Launch of a configured server requires explicit per-window approval naming
  the executable and arguments (stdio) or the endpoint, transport and auth
  scheme (HTTP) and origin; approval is never persisted and is revoked on
  reconfiguration or credential changes.
- Tool discovery never invokes a tool; every invocation is individually
  approval-gated; tool output is delimited and marked untrusted.
- The control model, the process boundary and the transport limits are all
  documented in the MCP page — the server is not sandboxed by this
  extension.

## Task continuity (WP5)

- `computeContinuationPlan` turns persisted task states into an honest
  resumption plan (resumable / blocked / failed / interrupted, with reasons).
  The session restore path now records this plan as a session note so an
  interrupted session says exactly what remains.
- Persisted sessions are unaffected by in-memory context stores; secrets and
  provider credentials are never written to task history.

## Language intelligence (WP6)

- The coding agent now receives a bounded, evidence-based stack section
  (detected languages, package manager, Karkain posture) appended to its
  system prompt when the workspace provides evidence. Nothing is claimed for
  undetected stacks.

## Reliability and UX (WP7)

- MCP failures carry actionable messages (timeout / closed / server /
  protocol / disabled) with the failing stage named.
- The paid-consent denial reason is surfaced to the session rather than
  silently calling paid APIs.
- All existing safety boundaries (trust, approvals, no-shell commands,
  redaction, CSP, SecretStorage) are preserved.

## Intentional non-goals and evidence gaps

- No GitHub/marketplace publication from this branch; no release.
- Cost figures are unavailable until a host supplies an explicit rate card.
- MCP is stdio JSON-RPC only; servers are user-configured; the server process
  is not sandboxed by this extension (see the MCP page for the exact boundary).
- Third-party MCP servers have **not** been verified in this build; the MCP
  page lists the exact steps to authorize and run that verification.
- Karkain tooling remains syntax-aware; the real compiler cannot run on every
  machine and fixture evidence is not compiler evidence.
