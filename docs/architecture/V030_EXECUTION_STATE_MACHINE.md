# v0.3.0 Execution State Machine

This document is the normative description of the agent lifecycle implemented in
`src/agent/stateMachine.ts` and driven by `src/agent/orchestrator.ts`. The state
machine is explicit: every state change passes through `assertTransition`, and
every transition is recorded as a `SessionEvent`.

## 1. Design rules

1. A session has exactly one state. States are not derived from task counts.
2. Every side effect belongs to a state, not to a hidden timer.
3. A terminal state never transitions again.
4. Only user actions start work or authorize side effects. A provider response
   can propose, it cannot approve.
5. Every transition is persisted before the next provider or process call.
6. Failure and cancellation are first-class states, never an empty success.
7. There is no transition from a terminal state to `completed`.

## 2. Session states

| State | Meaning | Allowed side effects |
| --- | --- | --- |
| `idle` | Session object created, nothing requested | None |
| `analyzing` | Requirement is normalized and validated | None |
| `inspecting` | Local project facts are collected | Read workspace metadata |
| `planning` | Provider is asked for a development plan | One provider request |
| `awaiting-plan-approval` | A valid plan exists and is waiting for a human decision | None; no files are touched |
| `ready` | Plan approved; scheduler may select the next task | None until selection |
| `executing` | Provider is asked for a change set for the selected task | Retrieval + one provider request |
| `awaiting-change-approval` | Diffs are prepared and waiting for a human decision | None; no files are touched |
| `applying` | Approved change ids are being written | Backup + writes for approved ids only |
| `validating` | An approved command is being executed | One exact allowlisted command |
| `diagnosing` | Command evidence is classified | Local analysis only |
| `awaiting-repair-approval` | A bounded repair change set is waiting for a decision | None; no files are touched |
| `repairing` | Approved repair ids are being written | Backup + writes for approved ids only |
| `paused` | User paused at a safe point; `pausedFrom` records where to return | None |
| `cancelling` | Cancellation is being made consistent | Mark running tasks cancelled |
| `completed` | Every task completed and the report was built | None |
| `rejected` | The human rejected the plan or change set | None |
| `failed` | The session stopped with a recorded reason | None |
| `cancelled` | The user cancelled the session | None |

## 3. Session transition table

`assertTransition(from, to)` rejects every pair that is not listed or covered by
the generated cancellation/pause rules below.

| From | To | Trigger | Guard |
| --- | --- | --- | --- |
| `idle` | `analyzing` | `start` | Non-empty requirement within the length limit |
| `analyzing` | `inspecting` | `start` | — |
| `inspecting` | `planning` | `start` | Inspection returned a `ProjectContext` |
| `planning` | `awaiting-plan-approval` | `plan` | Plan parsed and task graph is valid |
| `planning` | `failed` | `plan` | Malformed plan, provider error, or step limit |
| `awaiting-plan-approval` | `ready` | `approvePlan` | Approval decision recorded |
| `awaiting-plan-approval` | `rejected` | `rejectPlan` | Rejection decision recorded |
| `ready` | `executing` | `schedule` | A runnable task exists |
| `ready` | `completed` | `schedule` | No tasks remain (empty plan) |
| `executing` | `awaiting-change-approval` | `implement` | Prepared change set with a valid plan |
| `executing` | `completed` | `implement` | Task required no file changes and no other task remains |
| `executing` | `ready` | `implement` | Task required no file changes; scheduler continues |
| `executing` | `failed` | `implement` | Provider/parse/prepare error, step limit, or blocked graph |
| `awaiting-change-approval` | `applying` | `approveChanges` | At least one selected id belongs to the change set |
| `awaiting-change-approval` | `rejected` | `rejectChanges` | Rejection decision recorded |
| `applying` | `validating` | `apply` | At least one file applied and the task declares a validation command |
| `applying` | `executing` | `apply` | Applied and the scheduler selected another task |
| `applying` | `completed` | `apply` | Applied and no tasks remain |
| `applying` | `failed` | `apply` | No file applied or every applied file conflicted |
| `validating` | `executing` | `validate` | Command passed and another task is runnable |
| `validating` | `completed` | `validate` | Command passed and no tasks remain |
| `validating` | `diagnosing` | `validate` | Command failed, timed out, or could not start |
| `validating` | `cancelled` | `cancel` | The command was cancelled by the user |
| `diagnosing` | `awaiting-repair-approval` | `repair` | Repair proposal parsed and prepared; attempts remain |
| `diagnosing` | `failed` | `repair` | Repair limit reached, empty proposal, or provider error |
| `awaiting-repair-approval` | `repairing` | `approveRepair` | At least one repair id selected |
| `awaiting-repair-approval` | `failed` | `rejectRepair` | No repair id selected |
| `repairing` | `validating` | `applyRepair` | At least one file applied |
| `repairing` | `failed` | `applyRepair` | No file applied |
| `paused` | `pausedFrom` | `resume` | The recorded return state is not terminal |

Generated rules:

- Any non-terminal state may transition to `cancelling` when the user cancels.
- `cancelling` may transition only to `cancelled` or `failed`.
- `paused` may transition only to its recorded `pausedFrom` state.
- `completed`, `failed`, `cancelled` and `rejected` are terminal and have no
  outgoing transitions.

Pausing is only offered at safe points: `ready`,
`awaiting-plan-approval`, `awaiting-change-approval`,
`awaiting-repair-approval` and `diagnosing` (diagnosing performs no I/O). A
session cannot pause while a provider request or child process is in flight;
the user can cancel instead. This prevents a paused session from hiding work
that is still running.

## 4. Task states

Task state is independent of session state and describes one unit of the
approved plan.

| Task state | Meaning | Terminal |
| --- | --- | --- |
| `pending` | Not started; dependencies may not be satisfied | no |
| `blocked` | A dependency failed, was skipped, or was cancelled | no (can recover only by re-planning) |
| `running` | Provider is producing this task's change set | no |
| `awaiting-approval` | Change set prepared, waiting for a human | no |
| `applied` | Approved files were written; validation may run | no |
| `validation-failed` | The approved command did not pass | no |
| `repairing` | Approved repair files were written | no |
| `completed` | Task accepted after real evidence | yes |
| `failed` | Task cannot continue | yes |
| `skipped` | User rejected the change set | yes |
| `cancelled` | Session was cancelled | yes |

Allowed task transitions:

```text
pending -> blocked | running | cancelled
blocked -> pending            (only when the graph is re-evaluated)
running -> awaiting-approval | failed | cancelled
awaiting-approval -> applied | skipped | cancelled
applied -> validation-failed | completed | cancelled
validation-failed -> repairing | failed | cancelled
repairing -> applied | failed | cancelled
completed | failed | skipped | cancelled -> (terminal)
```

A task reaches `completed` only after either (a) its change set applied and the
recorded validation run passed, or (b) it intentionally produced no file
changes and was marked complete by the orchestrator. A model statement alone
never completes a task.

## 5. Scheduler semantics

`src/agent/scheduler.ts` is pure and deterministic.

Inputs: an ordered list of `AgentTask` records with `id`, `dependsOn`,
`status`, and `attempts`.

Rules:

1. Task ids must be unique, non-empty and at most 64 characters.
2. A dependency must reference a task in the same plan. Self-dependencies are
   rejected. The graph must be acyclic.
3. `nextRunnableTask` returns the first task in plan order whose status is
   `pending` and whose dependencies are all `completed`.
4. A `pending` task with any dependency in `failed`, `skipped` or `cancelled`
   becomes `blocked` on the next evaluation and is never executed.
5. A task in `running`, `awaiting-approval`, `applied`, `validation-failed` or
   `repairing` prevents the scheduler from selecting a second task. This is the
   duplicate-execution guard.
6. `completed` tasks are never returned. Re-running a completed task requires a
   new session.
7. If pending work remains but no task is runnable and none are blocked, the
   graph is broken and the session fails with a dependency error.
8. A task's `attempts` is incremented once per implementation request. Repair
   attempts are counted separately against `maxRepairIterations` per session
   task.
9. A provider step budget (`quantsmind.agent.maxSteps`) is checked before every
   provider request. Exceeding it fails the session; it never silently
   truncates the plan.

## 6. Approvals

Every approval has a request, a decision and a scope. A decision is stored
verbatim, including the selected ids, so the audit trail shows exactly what the
user allowed.

| Approval kind | Request ids | Grants | Does not grant |
| --- | --- | --- | --- |
| `plan` | `approve` / `reject` | Attempting the listed tasks | File writes or command execution |
| `change-set` | File change ids | Applying exactly those ids | Command execution or other files |
| `repair` | Repair change ids | Applying exactly those repair ids | A weaker validation policy |
| `validation-command` | The exact command | One execution of that command | Any other command |

Rules:

- Approving a plan with zero tasks is allowed and moves directly to
  `completed` with a report that records zero tasks.
- Approving a plan does not apply any file.
- Selecting an id that does not belong to the pending change set fails closed
  and writes nothing.
- Selecting no ids is a rejection, not an empty approval.
- An approval request is single-use. It is consumed before the side effect and
  cannot be replayed after a restart; a restored session with an interrupted
  approval is marked for review.
- Approval messages from the webview contain ids only. They cannot contain file
  content, commands or paths.

## 7. Command validation loop

```text
applied
  -> validating (user chose an exact allowlisted command)
      -> passed  -> task completed -> scheduler -> executing | completed
      -> failed  -> diagnosing
          -> repair proposal prepared -> awaiting-repair-approval
              -> approved -> repairing -> validating (same loop)
              -> rejected/exhausted/empty -> failed
```

- The validation command is validated by `commands/policy.ts` and the v0.2.0
  runner before every execution. Changing settings between approval and
  execution cannot turn a rejected command into an allowed one.
- `maxRepairIterations` is evaluated per task and is a hard cap. Reaching the
  cap fails the session with the real diagnostics attached.
- A repair proposal must contain at least one change. An empty proposal is a
  failure, not a success.
- Repair never edits test commands, disables lint rules, or removes assertions
  automatically. It can propose a code change, which the user reviews.

## 8. Cancellation

Cancellation is cooperative and checked:

- before and after every provider request,
- during workspace retrieval,
- while a child process is running (the runner terminates it),
- before applying a change set.

Sequence:

```text
any non-terminal state -> cancelling
cancelling -> cancelled            (normal)
cancelling -> failed               (cleanup itself failed)
```

Guarantees:

- A cancelled provider request cannot later produce a change set.
- A cancelled command is recorded as `cancelled: true` and `passed: false`.
- Cancellation marks every `running` or `awaiting-approval` task as
  `cancelled`; it does not mark any task `completed`.
- The completion report has outcome `cancelled`, and records which side effects
  completed before cancellation.

## 9. Persistence checkpoints and resume

The repository stores sessions after every transition and every task/evidence
mutation. Each stored session contains a `schemaVersion`, ordered events and a
`pausedFrom` value when paused.

On `restore(sessionId)`:

1. The stored schema is validated and migrated if it is an older supported
   version. Malformed sessions are dropped, not partially loaded.
2. The workspace root name must match the current workspace. A mismatch marks
   the session `failed` and leaves it visible for inspection.
3. If the previous process stopped in `executing`, `applying`, `validating`,
   `repairing`, `diagnosing` or `cancelling`, the session is moved to `paused`
   with `needsReview = true` and `pausedFrom = ready`. It is never resumed
   automatically mid-operation.
4. Every recorded applied file is hashed and compared with the hash captured at
   apply time. A missing or modified file marks the session `failed` with
   `needsReview = true` and a path-specific reason.
5. `resume(sessionId)` returns the session to `pausedFrom` without starting a
   provider call or a command. The user must make the next decision explicitly.
6. Completed tasks are never re-executed, and completed sessions are returned
   unchanged.

## 10. Failure taxonomy

| Class | Examples | State | Report outcome |
| --- | --- | --- | --- |
| `configuration` | Invalid provider URL, missing setting, malformed plan JSON | `failed` | `failed` |
| `authorization` | Unsafe path, excluded file, command not allowlisted | `failed` | `failed` |
| `conflict` | File changed after diff, create over existing file | `failed` (after review) | `failed` |
| `validation` | Non-zero exit, timeout, spawn error | `diagnosing` then `failed` or repaired | depends on final evidence |
| `cancellation` | User cancel | `cancelled` | `cancelled` |
| `provider` | HTTP error, empty response, timeout | `failed` | `failed` |
| `internal` | Unexpected exception | `failed` | `failed` |

Diagnostics carry `severity`, `source`, optional `file`/`line`, and the failing
command. They are displayed to the user and included in the completion report.

## 11. Invariants verified by tests

1. No transition into `applying` or `repairing` without a recorded approval of a
   matching kind and non-empty selected ids.
2. No file write before `ChangeService.prepare` produced a plan and the user
   approved ids from that plan.
3. No command execution unless the command is in the allowlist and passes
   `policy.validate`.
4. No `completed` state without `CompletionReport` whose validation evidence
   comes from an actual `ValidationRun`.
5. No terminal state has outgoing transitions.
6. No task is selected twice concurrently.
7. A dependency cycle is rejected before any provider request for implementation.
8. A restored session cannot auto-execute an interrupted side effect.
9. `maxSteps` and `maxRepairIterations` are enforced at the call site, not only
   in the UI.
10. Cancellation never produces `completed`.
