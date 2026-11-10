# Planning and tasks

An agent session turns a user requirement into a typed development plan, asks
for plan approval, and then executes the plan one task at a time. This page
documents the plan contract, the parser's limits, task statuses, and the
deterministic scheduler.

The implementation lives in [src/agent/planning.ts](../src/agent/planning.ts)
and [src/agent/scheduler.ts](../src/agent/scheduler.ts); the types are in
[src/agent/models.ts](../src/agent/models.ts).

## Requirement

A requirement is the only input that originates from the user:

```ts
interface Requirement {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
}
```

The requirement text is limited to **4,000 characters**
(`MAX_REQUIREMENT_CHARS`). Longer input is rejected before any provider call.

## Plan schema

The provider must return one JSON object:

```json
{
  "summary": "Add a shared retry helper and use it in the client",
  "approach": "Introduce the helper, cover it with a unit test, then refactor the client.",
  "risks": ["The helper must not change existing retry counts"],
  "tasks": [
    {
      "id": "task-1",
      "title": "Add retry helper",
      "description": "Create src/retry.ts with bounded exponential retry.",
      "dependsOn": [],
      "suggestedFiles": ["src/retry.ts"],
      "validationCommand": "npm run test:unit",
      "criteria": [
        { "text": "A unit test covers the retry cap", "verification": "command" }
      ]
    },
    {
      "id": "task-2",
      "title": "Use helper in client",
      "description": "Replace the inline retry loop in src/client.ts.",
      "dependsOn": ["task-1"],
      "suggestedFiles": ["src/client.ts"],
      "criteria": [{ "text": "Client behavior is unchanged", "verification": "review" }]
    }
  ]
}
```

The parser tolerates a fenced code block or surrounding prose by extracting the
outermost `{ ... }`. Everything inside is treated as untrusted model output.

### Parser limits and normalization

| Item | Limit | Behavior beyond the limit |
| --- | --- | --- |
| Tasks per plan | 20 (`MAX_SESSION_TASKS`) | Plan rejected |
| Dependencies per task | 20 (`MAX_TASK_DEPENDENCIES`) | Extra entries dropped |
| Acceptance criteria per task | 10 (`MAX_TASK_CRITERIA`) | Extra entries dropped |
| Suggested files per task | 20 (`MAX_TASK_FILES`) | Extra entries dropped |
| Task title | 200 chars | Truncated |
| Task description | 4,000 chars | Truncated |
| Plan summary | 4,000 chars | Truncated or defaulted |
| Plan approach | 8,000 chars | Truncated |
| Risk entries | 20 × 500 chars | Extra entries dropped |
| Criterion text | 500 chars | Truncated |

Normalization rules:

- A task without a non-empty title is rejected as malformed.
- A task id must match `[A-Za-z0-9._-]{1,64}`; otherwise it is replaced with
  `task-<index>`. Duplicate ids are rejected.
- `suggestedFiles` entries pass through `normalizeChangePath`. Absolute paths,
  `..` traversal, drive-relative paths, alternate data streams, and UNC paths
  are dropped with a warning rather than repaired.
- A dependency that names an unknown task creates a validation error. Cycles
  are rejected with the cycle path in the message.
- A `validationCommand` is kept only when it exactly matches one of the user's
  allowlisted commands after whitespace normalization. Commands containing
  `; & | < > ` $ \` or line breaks are dropped. A dropped command produces a
  warning; a kept command without a `command`-based criterion also produces a
  warning.
- An empty `tasks` array is accepted with a warning. This is how the provider
  reports that the requirement is ambiguous or needs no file change.

The parser never reads or writes the workspace. Findings are surfaced as plan
warnings in the chat view before the user approves the plan.

## Plan approval

The plan is a separate approval from per-file change approval. Nothing is
written while a plan waits for approval. The user can approve the plan or reject
it; rejection ends the session in `rejected` without touching any file.

After approval the session enters `ready`, and the scheduler decides which task
runs next.

## Task statuses

| Status | Meaning |
| --- | --- |
| `pending` | Waiting for dependencies or for the scheduler |
| `blocked` | At least one dependency failed, was skipped, or was cancelled |
| `running` | The provider is producing a change set for this task |
| `awaiting-approval` | A change set (or repair) for this task awaits per-file approval |
| `applied` | Approved files were written; validation may follow |
| `validation-failed` | The approved validation command failed |
| `repairing` | A bounded repair plan is being produced or applied |
| `completed` | The task's changes were applied and, when configured, validation passed |
| `failed` | The task stopped on an error or a rejected approval |
| `skipped` | The user cancelled or the task was bypassed by a dependency failure |
| `cancelled` | The session was cancelled while the task was active |

## Scheduler semantics

The scheduler is pure and deterministic. It operates on an immutable task list
and returns a decision; it never starts work itself.

1. **Refresh.** For every `pending` or `blocked` task:
   - if any dependency is in a failure status (`failed`, `skipped`,
     `cancelled`), the task becomes `blocked`;
   - if every dependency is `completed`, the task becomes `pending`;
   - otherwise it stays pending. A `blocked` task whose dependencies are neither
     failed nor fully complete returns to `pending` while it waits.
2. **Active task check.** If any task is `running`, `awaiting-approval`,
   `applied`, `validation-failed`, or `repairing`, the decision is `waiting`
   and names the active task. One task owns the session at a time.
3. **Completion check.** If there are no tasks, or every task is `completed`,
   the decision is `done`.
4. **Runnable check.** The first `pending` task whose dependencies are all
   `completed`, in plan order, becomes the `runnable` task.
5. **Stopped check.** If every task is terminal (completed, failed, skipped, or
   cancelled), the decision is `stopped`.
6. Otherwise the decision is `deadlock`, with the detail naming blocked tasks.

`ScheduleReason` is therefore one of `runnable`, `waiting`, `done`, `deadlock`,
or `stopped`. The orchestrator records these decisions in the session event log
so a resumed session can explain why it is paused.

## Ordering

`orderTasks` performs a stable topological sort. Tasks with no unmet
dependencies are emitted in plan order; the sort fails (returns an empty list)
if a cycle is present. The parser rejects cycles before scheduling, so ordering
is used for display and for resume validation rather than as a security control.

## Related pages

- [Agent workflow](AGENT_WORKFLOW.md)
- [Project intelligence](PROJECT_INTELLIGENCE.md)
- [Change review](CHANGE_REVIEW.md)
- [Approval and security](APPROVAL_AND_SECURITY.md)
