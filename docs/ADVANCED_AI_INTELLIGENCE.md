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

## MCP integration (WP4)

- A real, minimal **Model Context Protocol** client (`src/mcp/client.ts`):
  newline-delimited JSON-RPC 2.0 over stdio, `initialize` /
  `notifications/initialized` / `tools/list` / `tools/call`, with bounded
  output, per-call timeouts, sanitized environment (no ambient secrets) and
  redacted error surfaces.
- Agent tools: `mcp_list_tools` (spawns the configured server to list tools)
  and `mcp_call` (approval required per call; output wrapped in
  `<untrusted-mcp-output>` and marked untrusted; never interpreted as
  instructions).
- Servers are configured via the `quantsmind.mcp.servers` application setting
  (name, command, args, enabled). No server is configured by default; with an
  empty list the tools fail with an actionable message.
- Tool *discovery* never auto-grants a tool; every invocation requires the
  same explicit approval as any other consequential operation.
- Verified against a controlled in-repo fixture MCP server (handshake,
  success, tool error, large output, silent timeout, crash, environment
  sanitization, command metacharacter rejection). It has **not** been
  verified against third-party MCP servers in this environment.

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
- MCP support is stdio JSON-RPC for servers you configure yourself; streamable
  HTTP/SSE transports are not implemented yet.
- Karkain tooling remains syntax-aware; the real compiler cannot run on every
  machine and fixture evidence is not compiler evidence.
- Third-party MCP servers and third-party paid providers have not been
  exercised against this build; do not treat the fixture suite as live
  certification.
