# Sessions and resume

Agent sessions are persisted in extension storage so a long-running workflow can
survive a window reload. Resuming is treated as a security-sensitive operation:
the stored snapshot is validated, the workspace is checked, and applied files
are hashed again before work continues.

Implementation: [src/sessions/repository.ts](../src/sessions/repository.ts) and
`restore` in [src/agent/orchestrator.ts](../src/agent/orchestrator.ts).

## Storage

- Key: `quantsmind.agent.sessions.v1`
- Schema version: `1` (`SESSION_SCHEMA_VERSION`)
- Sessions retained: **50** (`MAX_SESSIONS`), newest first
- Serialized size per session: **200,000** characters
- Retained events: **500** (the most recent)
- Retained diagnostics: **50**
- Serialized validation output: **20,000** characters per run

When a snapshot exceeds the size limit, a compacted form is stored: the last
100 events, validation output truncated to 4,000 characters, the last 10 change
sets, and the last 5 repair proposals. If the compacted form still does not fit,
the session is not persisted.

Storage is written through the extension's key/value store. There is no
guaranteed flush on shutdown; persistence happens as state changes are recorded.
Sessions that were mid-flight when VS Code closed are restored as described
below.

## Integrity validation

`sanitizeSession` accepts only whitelisted fields with the expected types and
schema version. It:

- requires an id, a valid state, valid timestamps, and a requirement;
- re-validates the task graph (safe ids, known dependencies, no cycles) and
  checks that the stored task count matches the plan;
- validates change-set paths with `normalizeChangePath`, hashes with a 64-hex
  pattern, and task references;
- drops unknown or malformed entries rather than partially trusting them;
- marks a non-terminal session with a corrupt task graph as `paused` with
  `needsReview: true`.

A session from an older schema is migrated by `migrateStoredSession`. Legacy
records may supply `prompt` instead of `requirement`; migrated sessions have no
tasks, are paused unless terminal, and always require review. A stored schema
newer than this build is ignored with a log warning.

## Restore rules

`restore` refuses to run while the session is busy. It also refuses a session
whose `workspaceRoot` differs from the current workspace; the session is left
in storage and a warning is logged.

For a non-terminal session:

| Last recorded state | Restored as |
| --- | --- |
| `analyzing`, `inspecting`, `planning`, `executing` | `paused` (`pausedFrom: ready`), interrupted tasks reset to `pending` |
| `applying`, `repairing` | `failed` — writes may have been interrupted; review the workspace |
| `validating` | `validating` — the command must be run again |
| `diagnosing` | `diagnosing` |
| `awaiting-plan-approval`, `awaiting-change-approval`, `awaiting-repair-approval` | unchanged, awaiting your decision |
| `cancelling` | `cancelled` |

Terminal sessions are restored as-is for review.

### Hash revalidation

Before a non-terminal session is restored, every file recorded in
`TaskExecution.appliedFiles` is hashed again:

- a delete is a problem if the file now exists;
- a create or modify is a problem if the file is missing;
- any file whose hash differs from the recorded hash is a problem.

If any problem is found, the session becomes `failed`, the problems are recorded
as diagnostics, `needsReview` is set, and the completion report is generated.
If no hash provider is available, the session is restored with
`needsReview: true` because file integrity could not be checked.

## Resume, pause, and cancel

- Pausing is allowed only from `ready`, an awaiting-approval state, or
  `diagnosing`.
- Resuming returns to the state recorded in `pausedFrom`, or to `ready`.
- Resume never replays an approval. A pending approval is decided through the
  normal approval methods or is discarded when the session becomes terminal.
- Cancellation is cooperative: running provider or command work is aborted,
  pending tasks are marked `skipped`, and the session ends `cancelled`.
- Removing a session deletes it from memory and storage. It is refused while the
  session is busy.

## Events and report

Every state transition, task change, approval, apply, command, diagnostic,
repair, and report is appended as a bounded `SessionEvent`. Events are capped at
1,000 characters each and 500 entries. They are the audit trail shown in the
control center; they are not a substitute for the completion report.

The completion report is generated when the session reaches a terminal state
and is persisted with the session. It records the requirement, plan summary,
task outcomes, validation runs, diagnostics, repair count, unresolved items, and
the evidence list. See [Agent workflow](AGENT_WORKFLOW.md).

## Related pages

- [Agent workflow](AGENT_WORKFLOW.md)
- [Approval and security](APPROVAL_AND_SECURITY.md)
- [V030_DATA_MODEL.md](architecture/V030_DATA_MODEL.md)
- [V030_EXECUTION_STATE_MACHINE.md](architecture/V030_EXECUTION_STATE_MACHINE.md)
