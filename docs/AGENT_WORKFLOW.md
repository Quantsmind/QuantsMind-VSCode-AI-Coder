# Agent workflow

This page explains what happens between pressing **Send** in agent mode and
seeing a completion report. The normative state table is in
[architecture/V030_EXECUTION_STATE_MACHINE.md](architecture/V030_EXECUTION_STATE_MACHINE.md).

## Pipeline

```text
requirement
 -> analyzing
 -> inspecting        (local project facts)
 -> planning          (one provider request)
 -> awaiting-plan-approval
 -> ready
 -> executing         (one provider request per task)
 -> awaiting-change-approval
 -> applying          (approved files only)
 -> validating        (one approved allowlisted command)
 -> diagnosing        (on failure)
 -> awaiting-repair-approval
 -> repairing
 -> validating        (again)
 -> next task or completed
 -> completion report
```

`paused` can be entered only at `ready`, the approval states or `diagnosing`.
`cancelled`, `failed`, `rejected` and `completed` are terminal.

## Who does what

| Step | Owner | Side effect |
| --- | --- | --- |
| Requirement validation | `AgentOrchestrator.start` | None |
| Project inspection | `ProjectIntelligenceService.inspect` | Reads workspace metadata and `package.json` |
| Plan generation | Provider | None; returns JSON text |
| Plan parsing | `parseDevelopmentPlan` | None; rejects unsafe paths and commands |
| Plan approval | User + orchestrator | Records a decision; no file write |
| Task selection | `nextRunnableTask` | None |
| Implementation | Provider, then `ChangeService.prepare` | Reads files and computes hashes/diffs |
| Change approval | User + orchestrator | Records a decision; no write |
| Apply | `ChangeService.apply` | Backs up and writes approved files |
| Validation | `CommandExecutionService` | Runs one exact allowlisted command |
| Diagnosis | `DiagnosticService.analyze` | None |
| Repair proposal | Provider, then `ChangeService.prepare` | Reads files and computes diffs |
| Repair approval and apply | User + orchestrator | Backs up and writes approved repair files |
| Revalidation | `CommandExecutionService` | Runs the same approved command again |
| Completion report | `buildCompletionReport` | None; derives from recorded evidence |

The provider never receives the ability to execute a tool, write a file or run
a process. It returns JSON; local code validates and performs every action.

## Approval boundaries

1. **Plan approval** allows the agent to attempt the listed tasks. It grants no
   write and no command.
2. **Change-set approval** applies exactly the selected change ids. It grants no
   command and no other file.
3. **Repair approval** applies exactly the selected repair change ids. It does
   not weaken validation.
4. **Command approval** runs exactly one allowlisted command once.

Each approval is validated against the pending request, recorded with the
selected ids, and consumed before the side effect.

## Failure behavior

| Failure | Result |
| --- | --- |
| Malformed plan or change set | Session `failed` with a parse error; workspace untouched |
| Unsafe path or excluded file | Entry rejected; session fails closed |
| File changed after review | Conflict reported; that file untouched; partial apply reported honestly |
| Command not allowlisted or destructive | Command denied; no process starts |
| Validation failure | `diagnosing`; repair may be proposed |
| Repair rejected, empty or exhausted | Session `failed` with the real diagnostics |
| Cancellation | Session `cancelled`; no later side effect |
| Provider timeout or HTTP error | Session `failed`; raw body is not shown |

There is no fallback that "assumes the plan is fine" and no completion based on
model text alone.

## UI surface

The chat view renders, in order:

- the requirement and conversation transcript;
- the current state and ten stages (`requirement`, `inspect`, `plan`,
  `plan-approval`, `tasks`, `review`, `apply`, `validate`, `repair`, `report`);
- the development plan, task list and acceptance criteria;
- approval cards with per-file unified diffs;
- validation evidence with the exact command, exit code, timeout, cancellation
  and redacted output;
- diagnostics grouped by source and severity;
- the completion report with tasks, files, evidence and unresolved items;
- session actions: approve/reject, run validation, request repair, pause,
  resume, restore, cancel, undo and delete.

The webview is an untrusted renderer. It sends only typed messages from
`src/chat/protocol.ts`; malformed or unknown messages are ignored.

## Related pages

- [Project intelligence](PROJECT_INTELLIGENCE.md)
- [Planning and tasks](PLANNING_AND_TASKS.md)
- [Change review](CHANGE_REVIEW.md)
- [Command execution](COMMAND_EXECUTION.md)
- [Approvals and security](APPROVAL_AND_SECURITY.md)
- [Debugging and repair](DEBUGGING_AND_REPAIR.md)
- [Sessions and resume](SESSIONS_AND_RESUME.md)
