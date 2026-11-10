# Debugging and repair

A failed validation is evidence, not a prompt for the model to declare success.
QuantsMind derives diagnostics from the real command output, then offers a
bounded repair proposal that goes through the same review and approval pipeline
as any other change set.

Implementation: [src/agent/diagnostics.ts](../src/agent/diagnostics.ts) and the
repair methods in [src/agent/orchestrator.ts](../src/agent/orchestrator.ts).

## From failure to diagnostics

When an approved validation command fails, `analyzeValidationFailure` converts
the recorded `ValidationRun` into diagnostics:

- a spawn or execution error, if one was recorded;
- a timeout diagnostic with the measured duration;
- parsed TypeScript errors (`file.ts(12,3): error TS1234: ...`);
- parsed compact errors (`file.ts:12:3 error ...`);
- parsed generic `file:line: error` lines, `AssertionError` messages, and
  `FAIL <file>` lines;
- warning lines, up to five;
- a fallback diagnostic with the exit code and the last non-empty output lines
  when nothing else matched.

Limits: at most **20** diagnostics per analysis, line messages are truncated to
2,000 characters, and every message is redacted. The analyzer never asks a model
what the failure might be, and it never invents a file or line number: a
diagnostic only carries `file` and `line` when the command output contained
them.

The session transitions from `validating` to `diagnosing`; it does **not**
transition to `completed`.

## Requesting a repair

Repair is user-triggered. Before a proposal is requested, the orchestrator
checks:

- the session is in `diagnosing`;
- a task is in `validation-failed`;
- the task's `repairAttempts` is below `quantsmind.agent.maxRepairIterations`
  (default 1);
- the session's provider-call count is below `quantsmind.agent.maxSteps`
  (default 6);
- validation evidence exists for the failed task.

The repair prompt contains the task, the failing command, the captured evidence,
and the derived diagnostics. Local retrieval is used to attach relevant files.
The response is parsed as a normal change plan, prepared against the current
workspace (including fresh SHA-256 baselines), and stored as a
`RepairProposal`:

```ts
interface RepairProposal {
  readonly id: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly diagnosis: string;
  readonly summary: string;
  readonly plan: ChangePlan;
  readonly diffs: readonly UnifiedDiff[];
  readonly createdAt: string;
}
```

Empty repair plans, unsafe paths, preparation errors, and unparseable responses
fail the session rather than being retried silently.

## Repair approval and revalidation

1. The session enters `awaiting-repair-approval` with a `pendingApproval` of
   kind `repair`.
2. The user approves selected repair files or rejects the proposal.
3. Rejection records the decision and fails the session. Nothing is written.
4. Approval applies exactly the selected files with the same containment,
   hash, and backup rules as normal changes.
5. The task returns to `applied` and the session enters `validating`. The
   validation command must be run again by the user; the previous result is
   never reused as proof that the repair worked.

A repair cannot exceed the configured repair iterations. When the limit is
reached, the session fails with an explicit message and the completion report
lists the unresolved diagnostics.

## What repair does not do

- It does not automatically edit files or run commands.
- It does not bypass per-file review.
- It does not reuse an earlier approval.
- It does not weaken tests, lint rules, or security settings to make validation
  pass.
- It does not claim success from model text; only a new passing validation run
  counts as evidence.

## Related pages

- [Command execution](COMMAND_EXECUTION.md)
- [Change review](CHANGE_REVIEW.md)
- [Agent workflow](AGENT_WORKFLOW.md)
- [Planning and tasks](PLANNING_AND_TASKS.md)
