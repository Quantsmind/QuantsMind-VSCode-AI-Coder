# Approval and security

QuantsMind treats the provider, its output, and any workspace content sent to
it as untrusted. Authorization always comes from the user through a typed
webview message or a VS Code command. Nothing the model writes can grant itself
permission.

This page summarizes the control points. The full threat model is in
[V030_SECURITY_MODEL.md](architecture/V030_SECURITY_MODEL.md).

## Approval gates

| Gate | Trigger | What is authorized | What is not |
| --- | --- | --- | --- |
| Plan | `approvePlan` | Execution of the plan's tasks may begin | No file write, no command |
| Change set | `approveChangeSet` with selected file ids | Exactly the selected files of one change set | No other file, no command, no automatic follow-up |
| Repair | `approveRepair` with selected file ids | Exactly the selected repair files | No re-use of a previous approval |
| Validation | Explicit run action with a command | One command that passes the exact allowlist and risk policy | No arbitrary command, no automatic run |

- Plan approval and change approval are separate. Approving a plan never writes
  a file.
- Selecting zero files rejects the change set. The session ends `rejected` or
  the task fails; nothing is written.
- Each `ApprovalDecision` is stored on the session with its request id, kind,
  selected ids, outcome, and timestamp.
- A decision for a stale request id is refused instead of applied.
- The `pendingApproval` field is cleared before execution continues, so a
  decision cannot be replayed.
- Validation is never started by the model. The user runs it after the applied
  task is ready, and the command is checked again at execution time.

## State invariants

- One task owns execution at a time. The scheduler returns `waiting` while a
  task is `running`, `awaiting-approval`, `applied`, `validation-failed`, or
  `repairing`.
- `applied` is set only after a real write succeeds. It is never inferred from
  model text.
- A failed validation transitions to `diagnosing`, not `completed`.
- A rejected plan, rejected changes, or rejected repair ends in `rejected` or
  `failed`, never `completed`.
- Cancellation marks active and pending work `skipped` or `cancelled` and clears
  any pending approval.
- Paused sessions can only resume into a resumable state; terminal states cannot
  transition.

These rules are enforced in
[src/agent/stateMachine.ts](../src/agent/stateMachine.ts) and covered by
`test/unit/agentStateMachine.test.ts`.

## Trust boundaries

| Boundary | Control |
| --- | --- |
| Workspace to prompt | Built-in secret and dependency exclusions, user globs, `.gitignore`, size and count limits, redaction |
| Prompt to model | Only explicitly attached or locally retrieved content; no automatic upload |
| Model to disk | Path normalization, workspace containment, baseline hashes, per-file approval, backups, undo |
| Model to process | Exact allowlist, independent destructive-command classification, bare executable, no shell metacharacters, sanitized environment, timeout, output caps |
| Model to tools | Typed tool router with no default write or execute handler; model output cannot invoke it |
| Webview to host | Strict message protocol, bounded ids, nonce-based CSP, no remote assets |
| Host to logs | Credential and token redaction on every line |
| Host to provider | HTTPS, or loopback HTTP only while `allowInsecureLocalhost` is enabled and always logged at warn level |
| Restored sessions | Schema validation, migration, and hash revalidation before resume |

## Transport to the provider

Remote endpoints must use HTTPS — plain HTTP to a non-loopback host is rejected
by the endpoint validator and no setting opens it. Loopback HTTP is permitted by
default so local runtimes work out of the box, which means a request over it is
clear text on this machine:

- any local process that answers the configured port receives the prompt and the
  `Authorization` header, so the default is safe for a runtime you started, not
  for an arbitrary port number;
- a loopback host is treated as not requiring a credential, so a request proceeds
  unauthenticated;
- workspace trust does not participate — the transport comes from
  application-scoped settings, so a restricted workspace still uses it.

Set `quantsmind.provider.allowInsecureLocalhost` to `false` to require HTTPS for
loopback too. Every request that actually goes over plain HTTP writes one
warn-level line naming the host and the setting, so the choice is auditable in
the `QuantsMind AI Coder` Output channel rather than being an invisible default. See
[Provider configuration](PROVIDER_CONFIGURATION.md#plain-http-to-a-local-provider).

## Untrusted content

Workspace files are reference data, not instructions. The planning prompt says
so explicitly. The extension does not implement a general instruction-following
tool loop, so content in a file cannot ask the agent to apply changes, run a
command, or widen permissions. The only ways to act remain user-triggered
approvals and the exact-command gate.

## Credentials

- API keys live in VS Code SecretStorage. There is no API-key setting.
- Keys are never placed in command arguments or the child-process environment.
- The runner receives the stored key only to redact it from captured output.
- Error bodies, logs, prompts, and validation output pass through redaction,
  including masked forms such as `sk-…abcd`.

## Residual risks

- An approved diff can still be wrong. Approval is a human control, not a proof
  of correctness.
- An allowlisted command can run arbitrary project tooling.
- The extension cannot prevent a user from approving a malicious plan.
- Diagnostics and repair are advisory; a repair can introduce new defects.
- The process is not sandboxed beyond working-directory containment,
  environment filtering, timeouts, and output caps.

See [Command execution](COMMAND_EXECUTION.md),
[Change review](CHANGE_REVIEW.md), and
[V030_SECURITY_MODEL.md](architecture/V030_SECURITY_MODEL.md) for detail.
