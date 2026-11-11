# Agentic engineering — v2.5.6

This page documents the **bounded agentic execution engine** (`src/agent/engine.ts`):

a real plan/execute/observe/evaluate loop an extension can run step by step,
with hard limits enforced independently of the model, explicit state tracking,
and evidence-based evaluation. It is not unrestricted autonomy, and it does not
change what the model is or what the tools are allowed to do.

## Boundaries first (v2.5.6 does NOT)

- Unrestricted autonomous operation, plan/execute/replan loops without bound,
  automatic retries until "success".
- Unattended destructive shell operations, automatic dependency installation,
  automatic git commits/pushes/merges, deployment or publication.
- Any model authority over approvals, limits, workspace trust or MCP settings.
- Background execution that continues after user cancellation.
- New model training or fine-tuning.

## Architecture and integration points

```
You (agent mode) ──▶ runtime.codingAgent.run ──▶ runAgentEngine
                                                 │
                          ┌──────────────────────┼───────────────────────────┐
                          │ AgentToolRegistry ──▶ workspace tools + change    │
                          │                       sets + MCP + command runner │
                          │                       (existing approval/work     │
                          │                        trust boundaries unchanged)│
Container ───────────────▶│                                                    │
                          │ AgentModelClient ──▶ configured provider          │
                          └────────────────────────────────────────────────────┘
```

- The engine reuses the existing tool registry, model-response normalization
  and the system prompt; it does not re-implement them and it never widens
  tool authority. Workspace trust, change-set/diff review, per-command
  allowlisting, MCP launch and per-call approval, SecretStorage credentials
  and untrusted-output delimiting are all untouched.
- Approvals stay **inside the tools** (as before). An optional engine-level
  `authorize` gate exists for callers that need an additional policy check;
  the engine treats a denial as non-dispatch, never as "discard the result
  afterwards".
- The orchestrator (`controller.start`, used by `QuantsMind: Start agent
  task`) is a separate, approval-oriented path and is unchanged except for its
  v2.5.5 checkpoints; this page covers the engine path (chat agent mode).

## State machine

`AGENT_ENGINE_STATES` — explicit, validated transitions
(`AGENT_ENGINE_TRANSITIONS`): a line that walks an illegal edge collapses to
`failed` rather than silently inventing a state. States:

`created → planning → executing ⇄ observing ↔ evaluating → (executing | revising-plan | validating | completed | blocked) → …`
plus `paused`, `recovery-required`, `cancelled`, `failed`, `completed`.

The machine distinguishes: model output from completed work; proposed tool
calls from executed calls; proposed edits from applied edits; a request to
validate from a finished validation; and a finished task from a model saying
"done". **A task is never marked complete from a model response alone.**

## Execution loop and hard limits

Each iteration: cancellation/pause probe → deadline check → provider-request
check → model request → normalize → (final | dispatch) → per-call budgets →
tool execution with per-result clamp → progress accounting → next turn.

Limits (`src/agent/limits.ts`, validated at start, **model-independent**):

| Limit | Default | Bounds |
|---|---|---|
| maxIterations (model turns) | 10 | 1–32 |
| maxToolCalls (incl. refused) | 40 | 1–200 |
| maxPlanRevisions | 2 | 0–5 |
| maxProviderRequests | 12 | 1–40 |
| maxDurationMs | 600,000 | 60,000–1,800,000 |
| maxToolOutputChars (per result) | 100,000 | 1,000–200,000 |
| maxPatchSizeChars (cumulative) | 250,000 | 1,000–2,000,000 |
| maxChangedFiles | 25 | 1–100 |
| maxConsecutiveFailures | 3 | 1–10 |

Non-finite, negative or wrong-typed values fall back to defaults; huge values
clamp to the bounds. No setting disables the protections. The engine emits a
`limit` outcome naming the breached limit and remaining work rather than
pretending the task completed; iteration/duration/tool-call/provider limits
terminate the run, failed limits are reported in `engineOutcome.limitReached`
and in the final event.

## Observation and evaluation

After every tool call the engine observes the *actual* result: ok/error,
output size (clamped), mutating targets (changed-file set), patch bytes
(cumulative), consecutive failure signature (repeat-detection). At final
time it evaluates:

- model final + zero failures → `complete`
- model final + outstanding failures → `partial` (or `failed` with no successes)
- limit reached → `partial` or `failed`
- blocked (consecutive failures / exhausted revision budget / budget refusal) → `failed`
- cancelled/error/recovery-required → `inconclusive`

Model assertions never override evidence: "tests passed" from the model with a
failed test call reads `partial`/`failed`, not `complete`.

## Plan revision and scope control

When the same `(tool, args)` signature fails twice, the engine injects a
revision note (the model may adjust the approach, explicitly) and increments
`revisions`. Beyond the budget the run stops as `blocked` — no infinite fix
cycles. Changed-file, patch-size and tool-call budgets refuse out-of-scope or
oversized mutations before dispatch; approvals downstream can never widen
past those caps. Scope-guard behavior for user-declared expected files lives
in v2.5.5's `checkChangeScope` (applied post-hoc in completion reporting).

## Tool authorization

Risk tiers (all still behind existing approvals):

1. **Read-only inspection** — workspace reads, inventory, queries.
2. **Reversible edits** — change sets with atomic backup/undo.
3. **Command execution** — user allowlist + per-command approval.
4. **External MCP operations** — launch + per-call exact-argument approval.
5. **Destructive/irreversible ops** — explicit approval before dispatch.

Denial stops dispatch (the engine records a non-dispatched result);
cancellation stops the remaining dispatches; tool arguments remain visible to
the approving user; a previously approved operation never authorizes an
unrelated one.

## Multi-file editing

All edits flow through the v2.5.5 change-set pipeline: path normalization,
baseline hashing, conflict detection, backup-before-mutation, partial-failure
isolation and `undoAppliedChanges`. The engine adds its own caps on top
(files, patch bytes), and after each edit the changed-file set is updated.
Crash ambiguity on a **mutating** tool that timed out/was cancelled yields
`recovery-required`: the run stops for inspection; the operation is **never
blindly retried**.

## Pause and recovery

`shouldPause()` (a caller-injected probe) stops the run at the next step
boundary with status `paused` and the messages/tool transcript preserved for
a caller that persists them. `signal` cancellation behaves as always.
Interruption ambiguity on mutating tools always yields `recovery-required`;
restoration of interrupted tasks remains the v2.5.5 session-restore path
(computeContinuationPlan + `workflow:<phase>` inspection requirement).

## Provider behavior

The configured provider is used through the existing abstraction with the
same limits regardless of vendor. Malformed responses degrade to no tool
calls (run ends with the raw text) or explicit errors; provider failures are
`error` outcomes, never passed off as success. Native tool calling is used
when supported, with the text-envelope fallback unchanged.

## Configuration

`quantsmind.agenticEngine.*` (application scope, defaults in parentheses):

- `maxIterations` (10), `maxToolCalls` (40), `maxPlanRevisions` (2),
  `maxDurationSeconds` (600), `maxChangedFiles` (25).

Invalid values fall back to defaults (duration clamps to 60–1,800 s). No
setting exists that disables workspace trust, approvals or limits.

## Known limitations

- Execution is bounded **per task**; the engine does not chain approvals or
  pre-create approvals for future steps.
- The engine does not itself resume across restarts; recovery uses the
  existing session restoration (v2.5.5 checkpoints), which now also forces
  inspection for interrupted engine runs.
- Patch-size accounting is approximate (measures content fields), not a full
  AST diff.
- Evaluation is deterministic but coarse; it cannot prove correctness, only
  report evidence-shaped honesty.
- No new model capabilities are claimed.
