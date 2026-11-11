# Editing and approval workflow

QuantsMind can propose and apply multi-file changes, but only after you review
and approve them. There is no automatic apply path.

## Start a task

Run **QuantsMind: Start Agent Session** (or use the agent control in the chat
view) and describe the requirement. The v3.0.0 session pipeline then:

1. Inspects the workspace locally (indexed, bounded, trust-gated) and builds context.
2. Proposes a development plan (summary, approach, risks, tasks, dependencies,
   acceptance criteria) and stops for your approval.
3. On approval, executes each task, producing a per-file change set and stopping
   again for approval before anything is written.
4. Captures validation evidence via an allowlisted command; on failure it can
   propose a bounded, approval-gated repair.

The change-set wire format is a `summary` plus a `changes` array. Each change
has a `kind` (`create`, `modify`, `delete`, or `rename`), a workspace-relative
`path`, a short `summary`, plus `content` for create/modify or `fromPath` for
rename.

If the request is ambiguous, the documented response is an empty `changes`
array. The session still stops at approval, and you can reject it.

## Review

The task panel shows the stage list, the plan summary, per-file diffs, and
warnings:

- **Create** warns if a file already exists.
- **Modify**, **delete**, and **rename** warn if the source file is missing.
- Diffs include create, delete, and rename headers, context lines, and
  truncation markers for very large files.

Approval is per file. You can:

- **Apply selected files** with the checkboxes in the review panel.
- **Reject all** and end the task.
- **Cancel task** while a stage is running.

No file is written while the task is `awaiting-approval`.

## Apply

For each approved change, before mutating anything, the extension:

1. Re-reads the current file.
2. Compares its SHA-256 hash with the baseline recorded during review.
3. Detects existing targets for create and rename.
4. Records a backup in extension global storage.

Then it writes, deletes, or moves the file. Results are reported per file as
`applied`, `skipped`, `conflict`, or `failed`. A conflict leaves the file
untouched. A failure in one file does not roll back files that already applied;
use undo for those.

The final task status is `applied` only when at least one change was written.
Cancelled, rejected, failed, and validation-failed tasks have distinct statuses.

## Undo

- From the task panel: **Undo applied changes**.
- From history: **QuantsMind: Show Change History** and pick an undoable entry.

Undo restores backups in reverse order. It refuses to overwrite a file that was
edited after apply and reports the conflict instead. A create is undone by
deleting the created file only if its current content still matches what was
written.

Backups are stored under the extension's global storage directory, in a folder
per task ID. They are not written into the workspace.

## Change history

The last 50 change sets are persisted in extension storage with status, summary,
files, timestamps, and undo availability. History never contains credentials or
file content beyond diff metadata; the actual backups live on disk in global
storage.

## Path safety

Change paths must be relative. The following are rejected:

- Absolute paths and drive letters.
- Windows drive-relative paths and alternate data streams (`C:file`,
  `file:stream`).
- UNC paths and `..` traversal.
- Control characters and paths over 500 characters.
- Paths excluded by built-in or user security rules (`.env`, credentials,
  dependencies, build output).

The file adapter resolves each path against the workspace URI and rejects any
result that escapes the workspace root.

## What is intentionally missing

- Automatic apply after planning.
- Automatic command execution after apply.
- Rollback of a partially failed apply. Undo the successful files explicitly.
- Binary file edits. Plans are text-only.
- Applying changes when no workspace folder is open.
