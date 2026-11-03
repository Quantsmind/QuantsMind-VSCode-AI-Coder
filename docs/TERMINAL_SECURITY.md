# Terminal and command security

QuantsMind does not expose a general terminal. It can run one validation command
after you approve it, using a strict allowlist.

## Allowed commands

The default allowlist is:

```text
npm run compile
npm run lint
npm test
npm run test:unit
npm run verify
```

Edit `quantsmind.commands.allowlist` to add project-specific commands. Matching
is exact after trimming and whitespace normalization. A command that only
resembles an entry is rejected.

## Validation rules

Before a command can run:

1. It must be non-empty and at most 200 characters.
2. It must not contain control characters.
3. It must not contain these shell metacharacters: `;`, `&`, `|`, `<`, `>`,
   `` ` ``, `$`, newline, or carriage return.
4. The executable token must be a bare command name. Path-qualified forms such as
   `/usr/bin/npm`, `C:\npm`, and `.\npm` are rejected.
5. It must exactly match an allowlist entry.
6. The working directory must resolve inside the workspace root.

The command is also shown verbatim in the task panel before it runs.

## Execution

- `spawn` is called with `shell: false`.
- On Windows, the runner invokes `cmd.exe /d /s /c <command>` so an npm shim can
  execute. It still passes no shell metacharacters and no user quoting.
- The environment is rebuilt from a fixed allowlist: `PATH`/`Path`,
  `SystemRoot`, `ComSpec`, `PATHEXT`, `WINDIR`, `TEMP`/`TMP`,
  `HOME`/`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`,
  `PROGRAMFILES`, `COMMONPROGRAMFILES`, `NUMBER_OF_PROCESSORS`,
  `PROCESSOR_ARCHITECTURE`, `OS`, `LANG`, `LC_ALL`, `TERM`, and `SHELL`.
  Unrelated parent variables are not forwarded. `CI=1`, `NO_COLOR=1`, and
  `FORCE_COLOR=0` are set for deterministic output.
- stdin is ignored. stdout and stderr are captured separately and merged for
  display.
- The process runs in the workspace root.
- A timeout terminates the process, and cancellation does the same.
- Output is capped by `quantsmind.commands.maxOutputChars` (default 120000).

## Output handling

Captured output is redacted before it reaches the UI. The same redaction rules
used for prompts apply, including exact credentials and masked key fragments.
Output is also bounded and truncated so a runaway command cannot freeze the
webview.

## Validation and repair

A validation result records the command, exit code, captured output, timeout
flag, cancellation flag, and pass/fail. A non-zero exit code fails validation.

After a failure you can request a repair plan. Repair:

- Is limited by `quantsmind.agent.maxRepairIterations`.
- Produces a new plan that is reviewed and approved like any other.
- Never reuses a previously approved command or applies files automatically.

## Limits

| Setting | Default | Meaning |
| --- | --- | --- |
| `quantsmind.commands.allowlist` | five npm commands | Exact permitted commands |
| `quantsmind.commands.timeoutMs` | 120000 | Per-command timeout |
| `quantsmind.commands.maxOutputChars` | 120000 | Captured output cap |
| `quantsmind.agent.maxSteps` | 6 | Provider calls per task |
| `quantsmind.agent.timeoutMs` | 180000 | Task step timeout |

## Residual risks

- An allowlisted command can run arbitrary project tooling. The allowlist is a
  trust boundary you control; keep it narrow.
- A dependency's lifecycle script may still perform network or file access when
  an allowlisted npm script runs it.
- The runner does not sandbox the process beyond working-directory containment,
  environment filtering, timeouts, and output caps.
- Validation output may contain sensitive project data. It stays local in the
  chat view and is redacted, but review it before sharing.
