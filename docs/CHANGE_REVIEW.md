# Change review

Every file change in an agent session goes through a review step before it can
touch the workspace. This page describes the change-set model, review output,
approval, apply outcomes, and undo.

Implementation: [src/changes](../src/changes), orchestration in
[src/agent/orchestrator.ts](../src/agent/orchestrator.ts).

## Change-set model

A provider response for one task is parsed into a `ChangeSet`:

```ts
interface ChangeSet {
  readonly id: string;
  readonly taskId: string;
  readonly summary: string;
  readonly plan: ChangePlan;
  readonly diffs: readonly UnifiedDiff[];
  readonly warnings: readonly string[];
  readonly createdAt: string;
}
```

A `ChangePlan` contains up to **20** `FileChange` entries. Each entry has a
stable id, a kind (`create`, `modify`, `delete`, or `rename`), a
workspace-relative path, an optional source path for renames, optional full
content (up to 1,000,000 characters per change), a summary, and, once prepared,
an expected SHA-256 hash.

Plan-wide content is capped at 4,000,000 characters. Paths are normalized with
`normalizeChangePath`, which rejects absolute paths, `..` traversal, drive
letters, colons (Windows drive-relative paths and alternate data streams), UNC
paths, control characters, and paths longer than 500 characters.

## Preparation

Before review, `ChangeService.prepare`:

1. rejects paths excluded by the workspace security rules;
2. reads the current content of every affected source file;
3. records a SHA-256 baseline hash for modify, delete, and rename operations;
4. refuses to prepare a plan that only creates a file that already exists
   (it warns, and apply will later refuse);
5. refuses to prepare a plan whose source file does not exist;
6. builds unified diffs and per-file warnings.

If any preparation error occurs, the plan is returned with no reviewable
changes and the errors are shown in the chat view. Preparation only reads; it
never writes.

## Review output

Each reviewable change contains its diff, added and deleted line counts, and
whether the diff was truncated. Diffs are line-based and include:

- `---` / `+++` headers with create, modify, delete, or rename metadata;
- a rename header with the source and destination paths;
- hunk context around changes;
- a large-file fallback that shows a bounded diff instead of the full file.

Warnings are shown next to the affected file. Typical warnings include an
existing destination for a create or rename, or a dropped unsafe path reported
by the planner.

## Approval

Approval is per file and per change set. The chat view sends
`approveChangeSet` with the change-set id and the selected file ids. The
approval is recorded as an `ApprovalDecision` on the session:

```ts
interface ApprovalDecision {
  readonly requestId: string;
  readonly kind: 'plan' | 'change-set' | 'repair' | 'validation-command';
  readonly approvedIds: readonly string[];
  readonly outcome: 'approved' | 'rejected';
  readonly decidedAt: string;
}
```

Rules:

- Selecting zero files rejects the whole change set; nothing is written.
- Unknown or duplicate ids are ignored by the protocol parser.
- The same approval request cannot be decided twice; a stale request id is
  rejected rather than applied.
- Approval of a change set does not approve a validation command. Those are
  separate approval kinds.
- Approval of a plan does not approve any file; it only allows execution to
  begin.

## Apply outcomes

Application is workspace-contained. Each write creates a backup before the
file is replaced. A change is refused if:

- its baseline hash no longer matches the file on disk;
- a create or rename destination appeared after preparation;
- the path is outside the workspace or fails containment checks;
- the change was not selected in the approval decision.

`ApplyOutcome` reports applied files, conflicts, and failures separately. The
history entry records one of `applied`, `partial`, `rejected`, or `undone`.
A partial apply is reported as partial; it is never described as complete.

## Undo and history

- Every applied file is backed up under extension storage, grouped by task.
- Undo runs in reverse order and refuses to overwrite a file that was edited
  after apply; those files are reported as conflicts and left untouched.
- Change history keeps the last **50** entries and can restore an entry from its
  backups.
- Undo does not revert validation runs or diagnostics; the completion report
  continues to describe what happened.

## What review does not protect against

Review is a human control, not a proof of correctness. It does not:

- execute or type-check the proposed code;
- guarantee that a change matches the requirement;
- prevent a well-crafted plan from being approved by a user who does not read
  the diff;
- sandbox writes beyond path containment and backup/undo;
- approve itself.

The extension never approves or applies its own plans. Provider output is
untrusted input to this pipeline.

## Related pages

- [Agent workflow](AGENT_WORKFLOW.md)
- [Planning and tasks](PLANNING_AND_TASKS.md)
- [Approval and security](APPROVAL_AND_SECURITY.md)
- [Debugging and repair](DEBUGGING_AND_REPAIR.md)
