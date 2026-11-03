# Troubleshooting

Diagnose problems from the chat view first: errors are normalized, redacted, and
usually include an action such as **Set API Key**, **Open Settings**, or
**Show Log**.

## Provider and credentials

**"The API key is not configured" / authentication error**
Run **QuantsMind: Set API Key**. Keys are stored in VS Code SecretStorage, not
in settings. If you changed providers, confirm the base URL and key belong to
the same host.

**"The API key is masked"**
The key stored or entered was a masked fragment such as `sk-…abcd`, not a real
credential. Re-enter the full key. QuantsMind does not echo either form.

**401 / 403 responses**
The provider rejected the key, the model name, or account access. Check
`quantsmind.provider.model`, the account's access to it, and the endpoint host.
OpenRouter-compatible endpoints use the same OpenAI-compatible shape but may
require a model identifier prefixed with the vendor name.

**429 responses**
The provider is throttling. Wait and retry, or reduce request size and
frequency. The extension does not retry automatically on your behalf.

**"Plain HTTP is only allowed for loopback providers"**
Remote endpoints must use HTTPS. For a local server, use `localhost`,
`127.0.0.1`, or `::1`, and keep
`quantsmind.provider.allowInsecureLocalhost` enabled.

**"The provider base URL must not contain query parameters or fragments"**
Use the API root only, for example `https://api.openai.com/v1`.

**Requests time out**
Raise `quantsmind.provider.requestTimeoutMs`. Very large plans and long streams
need more time. Agent steps are separately bounded by
`quantsmind.agent.timeoutMs`.

## Workspace intelligence

**The workspace summary is empty or small**
The index skips secrets, dependencies, build output, binary files, empty files,
and files above `quantsmind.context.maxFileSizeKb`. It is also capped by
`quantsmind.workspace.maxIndexedFiles`. Check whether your project is inside one
of the built-in exclusions or your own `quantsmind.context.excludeGlobs`.

**No relevant files are attached**
Retrieval ranks paths and content against your task text. Use a more specific
description, or attach files explicitly. Retrieval is bounded by
`quantsmind.workspace.maxRetrievedFiles`, `quantsmind.workspace.retrievalMaxChars`,
and `quantsmind.context.maxTotalChars`.

**"Open a workspace folder"**
The extension needs a workspace folder for indexing, retrieval, change
containment, and command execution.

## Planning

**"The provider response did not contain a JSON development plan"**
The model returned prose or an unusable shape. Retry, reduce the request, or use
a model that follows JSON instructions. The parser tolerates a fenced JSON block
and surrounding text, but not malformed JSON.

**"The development plan exceeds the 20-task limit"**
Split the requirement into smaller sessions.

**"The task graph contains a dependency cycle"**
The provider produced an invalid plan. Retry; do not approve it.

**A validation command was dropped**
The proposed command was not an exact entry in
`quantsmind.commands.allowlist`, or it contained shell metacharacters. Add the
exact command to the allowlist if you trust it.

**Plan approval does nothing**
The plan must be in `awaiting-plan-approval`, and the request must be the
current pending approval. A stale request is rejected rather than applied.

## Change review and apply

**"No files were applied. The workspace may have changed since the plan was
created."**
A baseline hash or destination check failed. Re-run the task so a fresh plan and
fresh hashes are produced.

**"Only N of M changes were applied"**
Some files conflicted or failed. The applied subset is recorded and backed up;
review the workspace and the change history before retrying.

**A file is refused as excluded**
Built-in secret and dependency exclusions cannot be removed. If the file is
legitimate, move it out of an excluded location or adjust user globs. Do not
weaken the built-in rules.

**Undo refuses to restore a file**
The file was edited after apply. Undo leaves it untouched and reports a
conflict. Restore it manually from your own version control if needed.

**"The pending change set is missing from the session"**
The stored session no longer contains the reviewed change set. Start a new task.
Do not approve an old request id.

## Validation and commands

**"The validation command is not permitted"**
The command failed the exact allowlist or the destructive-command classification.
Destructive commands remain refused even if you add them to the allowlist.

**The command times out**
Raise `quantsmind.commands.timeoutMs` only if the command legitimately needs
more time. The timeout kills the process; it does not mark validation as passed.

**Output is truncated**
The captured output is capped by `quantsmind.commands.maxOutputChars` (default
120,000). Run the command in a terminal if you need the full log, but note that
terminal execution is outside the extension's approval workflow.

**The command ends with no output**
Check that the executable is installed and on PATH. The environment is rebuilt
from a fixed allowlist, so a variable your script depends on may not be
forwarded. Validation output records a spawn error when the process cannot
start.

## Repair

**"The task reached the configured repair limit"**
`quantsmind.agent.maxRepairIterations` (default 1) has been reached. Review the
diagnostics and change history, fix the issue outside the session, or start a
new session. The limit is not bypassed automatically.

**A repair passed review but validation still fails**
The repair is a proposal, not a guarantee. Request another repair only while
the iteration and step limits allow it.

## Sessions

**A session was not restored**
- It belongs to a different workspace root and was intentionally skipped.
- Its schema is newer than this build and was ignored.
- Its stored snapshot was corrupt and was dropped.
- A file changed or disappeared after it was applied; the session is marked
  `failed` for review.

Check **Show Log** for the reason.

**"The session was interrupted while approved changes were being written"**
The extension cannot know whether a write completed. Review the workspace and
the change history, then start a new task rather than resuming blindly.

**Session storage is full**
At most 50 sessions are retained, each capped at 200,000 serialized characters.
Older sessions are evicted. Remove sessions you no longer need.

## UI and installation

**The chat view is blank after install**
Reload the window. Confirm VS Code is 1.95.0 or newer and that the extension is
enabled. Check the log for activation errors.

**A button does nothing**
The control center disables actions that are invalid for the current state. The
stage list and status line show why. A stale approval, a busy session, or a
terminal state will reject the action rather than silently ignoring it.

**Reporting a security issue**
Follow [SECURITY.md](../SECURITY.md). Do not include real credentials in a
report.

## Related pages

- [Provider configuration](PROVIDER_CONFIGURATION.md)
- [Command execution](COMMAND_EXECUTION.md)
- [Sessions and resume](SESSIONS_AND_RESUME.md)
- [Live provider validation](LIVE_PROVIDER_VALIDATION.md)
