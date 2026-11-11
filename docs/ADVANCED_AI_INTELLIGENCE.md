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

## MCP integration (WP4) — hardened in v2.5.1, configurable in v2.5.2

See [MCP (Model Context Protocol) — v2.5.1](MCP.md) for the full contract:
configuration, launch approval, workspace trust, permission model, tool
invocation, security boundaries, diagnostics and known limitations. v2.5.2
makes the per-server limits user-configurable: each server's `timeoutMs`
(10,000 ms default, 250–300,000 ms) and `maxToolOutputChars` (20,000 default,
1,000–200,000) pass through from VS Code settings through
`resolveMcpSettings` → `McpServerManager` (with a configuration fingerprint that
invalidates stale connections and cached launch approvals on change) →
`McpClient` → the actual request timer and output clamp. Legacy configurations
without these properties keep the defaults and require no migration.

At a glance:

- Real stdio/newline-delimited JSON-RPC 2.0 client with protocol-version
  negotiation, bounded frames, timeouts, sanitized environment, redacted
  errors and an `McpServerManager` that caches connections, reconnects across
  crashes and terminates every child on deactivation.
- `quantsmind.manageMcpServers` (command palette / status-bar menu): view,
  add, edit, enable/disable, connect/disconnect/restart, discover tools and
  view diagnostics for configured servers. No secrets are ever displayed.
- Launch of a configured server requires explicit per-window approval naming
  the executable, arguments and origin; approval is never persisted and is
  revoked on reconfiguration.
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
