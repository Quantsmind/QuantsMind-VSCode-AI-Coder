# Command execution

QuantsMind does not expose a terminal. It can run **one exact validation
command** after you approve it. This page documents the command policy, the
execution boundary, evidence capture, and the remaining risks.

Implementation: [src/commands/policy.ts](../src/commands/policy.ts),
[src/commands/runner.ts](../src/commands/runner.ts).

## Two independent gates

A command must pass both gates:

1. **Risk classification** (`evaluateCommand`). The command is classified as
   `validation`, `read-only`, `destructive`, or `unknown`. Destructive commands
   are refused even if they appear in the allowlist. This gate is independent of
   the allowlist on purpose, so a configuration mistake cannot enable `rm`,
   `git reset --hard`, `npm publish`, `docker push`, `terraform apply`, and
   similar commands.
2. **Exact allowlist validation** (`validateCommand`). The normalized command
   must exactly match an entry in `quantsmind.commands.allowlist`.

Both gates must pass. Every allowed command still reports
`requiresApproval: true`; approval is a separate, explicit step.

## Validation rules

Before execution:

1. The command must be non-empty and at most 200 characters.
2. It must not contain control characters.
3. It must not contain shell metacharacters: `;`, `&`, `|`, `<`, `>`, `` ` ``,
   `$`, newline, or carriage return.
4. The executable must be a bare command name. `/usr/bin/npm`, `C:\npm`,
   `.\npm`, and similar path-qualified forms are rejected.
5. It must exactly match an allowlist entry after trimming and whitespace
   normalization.
6. The working directory must resolve inside the workspace root.

The exact command string is shown in the chat view before it runs.

## Execution boundary

- `spawn` is called with `shell: false`; stdin is ignored.
- On Windows the runner uses `cmd.exe /d /s /c <command>` as the launcher so
  package-manager shims such as `npm` can execute. No shell metacharacters,
  user quotes, or additional arguments are accepted into the command.
- The environment is rebuilt from a fixed allowlist (PATH, SystemRoot, ComSpec,
  PATHEXT, WINDIR, TEMP/TMP, HOME/USERPROFILE, APPDATA, LOCALAPPDATA,
  PROGRAMDATA, PROGRAMFILES, COMMONPROGRAMFILES, processor variables, OS, LANG,
  LC_ALL, TERM, SHELL). Unrelated parent variables are not forwarded.
  `CI=1`, `NO_COLOR=1`, and `FORCE_COLOR=0` are set for deterministic output.
- The process runs in the workspace root.
- A timeout terminates the process with `SIGTERM`, followed by `SIGKILL` after
  two seconds. Cancellation does the same.
- Output is captured from stdout and stderr and bounded by
  `quantsmind.commands.maxOutputChars` (default 120,000 characters).
- Captured output is redacted with the same rules as prompts, including exact
  credentials and masked key fragments.

The extension never injects an API key into command arguments or the command
environment. The command runner receives the stored secret only to redact it
from output.

## Evidence capture

A validation run records:

```ts
interface ValidationEvidence {
  readonly command: string;
  readonly exitCode: number | null;
  readonly passed: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly output: string;
  readonly error?: string;
}
```

A non-zero exit code, timeout, cancellation, spawn error, or missing exit code
fails validation. The run is stored on the session and appears in the completion
report. A failed run can trigger a bounded repair proposal, which is reviewed
and approved like any other change set.

## Tool router

The typed `ToolRouter` in [src/agent/toolRouter.ts](../src/agent/toolRouter.ts)
supports five kinds: `read-file`, `list-files`, `apply-change-set`,
`run-command`, and `collect-diagnostics`. No handler is registered by default
for write or execute kinds, a missing handler fails closed, and model output
cannot invoke the router. The orchestrator uses the command service directly
after approval; the router is an extension point, not an authority.

## Limits

| Setting | Default | Meaning |
| --- | --- | --- |
| `quantsmind.commands.allowlist` | five npm commands | Exact permitted commands |
| `quantsmind.commands.timeoutMs` | 120000 | Per-command timeout |
| `quantsmind.commands.maxOutputChars` | 120000 | Captured output cap |
| `quantsmind.agent.timeoutMs` | 180000 | Wall-clock limit for an agent step |

## Residual risks

- An allowlisted command can run arbitrary project tooling. Keep the allowlist
  narrow; it is a trust boundary you control.
- A package script can invoke dependency lifecycle scripts with network or file
  access.
- The runner does not sandbox the process beyond working-directory containment,
  environment filtering, timeouts, output caps, and cancellation.
- Validation output can contain sensitive project data. It stays local and is
  redacted, but review it before sharing.

## Related pages

- [Terminal and command security](TERMINAL_SECURITY.md)
- [Debugging and repair](DEBUGGING_AND_REPAIR.md)
- [Approval and security](APPROVAL_AND_SECURITY.md)
