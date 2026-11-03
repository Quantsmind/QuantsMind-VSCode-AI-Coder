# v0.3.0 Security Model

This document describes the security controls implemented in v0.3.0 and the
residual risks that remain. It is written against the code in
`src/agent`, `src/changes`, `src/commands`, `src/context`, `src/security`,
`src/workspace`, `src/providers` and `src/chat`.

## 1. Assets

| Asset | Why it matters |
| --- | --- |
| Workspace source files | User data and intellectual property |
| Files outside the workspace | Must never be read or written by the agent |
| Provider credentials | Long-lived secrets; compromise enables abuse and billing |
| Excluded / ignored files | May contain `.env`, keys, customer data |
| Command execution | Runs with the user's OS account and privileges |
| Session history and evidence | May contain source fragments and command output |
| Extension integrity | A malicious update or dependency could bypass all controls |

## 2. Actors and trust levels

| Actor | Trust | Capability |
| --- | --- | --- |
| User | Trusted for decisions | Chooses provider, approves plans, files and commands |
| Extension host | Trusted code | Mediates every side effect |
| VS Code webview | Untrusted input | Renders state; can only send protocol messages |
| Model provider | Untrusted output | Returns text/JSON; never executes anything |
| Workspace content | Untrusted data | May contain instructions, secrets or malicious code |
| Child processes | Untrusted programs | Run only when allowlisted and approved |
| Other workspace extensions | Outside this extension's control | Not mediated; documented limitation |

The model and the workspace are treated as data sources, never as principals.
Neither can grant a permission. Only an explicit user decision can.

## 3. Trust boundaries and controls

| Boundary | Threat | Primary control | Secondary control |
| --- | --- | --- | --- |
| Webview → host | Malformed or spoofed messages | Strict discriminated-union parser (`chat/protocol.ts`) | Message size/shape checks; unknown messages ignored |
| Webview → host | Approving ids not shown to the user | Pending approval request is authoritative | Unknown ids fail closed and write nothing |
| Host → provider | Secret exfiltration in prompts | Explicit retrieval with exclusions and redaction | User-initiated requests only |
| Host → provider | Prompt injection from workspace files | Context wrapped and marked untrusted in system prompt | Model output still passes all local gates |
| Provider → host | Malicious JSON / paths / commands | Strict parsers, path gate, command policy | Fail closed with a visible reason |
| Model → disk | Arbitrary write, traversal, ADS, UNC, symlink escape | `normalizeChangePath`, workspace containment, per-file approval | SHA-256 preflight and backups |
| Model → process | Command injection, chaining, destructive actions | Exact allowlist, no metacharacters, no direct tool channel | `spawn` with `shell:false`, sanitized environment |
| Host → disk | Overwrite after review (TOCTOU) | Hash preflight immediately before write | Conflict reported, file untouched |
| Host → globalState | Sensitive data persisted | Session whitelist of fields, caps, redaction | No credentials, no raw provider bodies |
| Host → OutputChannel | Leakage in logs | `redactSecrets` on every line | Lifecycle metadata only |
| Host → webview | XSS / script injection | CSP `default-src 'none'`, nonce script, local assets | All dynamic text escaped in `media/chat.js` |

## 4. File system controls

### 4.1 Path gate

Every proposed path passes `normalizeChangePath` (`src/changes/model.ts`):

- rejects non-strings, empty paths and paths over 500 characters,
- rejects control characters,
- rejects absolute POSIX paths, drive-letter paths and UNC paths,
- rejects any colon (Windows drive-relative paths and NTFS alternate data
  streams),
- rejects `..` segments,
- collapses `.` and empty segments,
- returns a forward-slash workspace-relative path.

The resulting path is joined to the workspace root by `WorkspaceChangeFs`, which
also verifies containment after resolution. No model-supplied path is used as an
absolute path.

### 4.2 Exclusions

Before reading or writing, `ChangeService.prepare` applies
`isPathExcluded` with the configured context globs. Built-in sensitive patterns
(`.env`, keys, certificates, credential stores, `.git`, `node_modules`, build
outputs) are always present. User globs add to them; they cannot remove the
built-in set. `.gitignore` filters the retrieval index so ignored files are not
offered as context.

### 4.3 Review, approval and preflight

1. The model returns complete file contents, never fuzzy patches.
2. `prepare` reads current content and records SHA-256 for every existing file.
3. Diffs are generated from the real before/after content.
4. The user approves individual change ids.
5. `applyChangePlan` rechecks each approved file against its recorded hash and
   refuses on mismatch.
6. Existing files are never overwritten by a `create`.
7. Backups are written outside the workspace before mutation.
8. Undo refuses to overwrite files modified after apply.

A file that appears after review but before apply is a conflict; it is not
overwritten. A partially applied set is reported as partial, with per-file
results, and is never described as complete.

### 4.4 Boundaries not protected

- Other VS Code extensions and external programs can modify the workspace while
  a session runs. Hash preflight detects this only at apply time.
- Symbolic links inside the workspace are resolved by the operating system.
  The containment check uses resolved paths, but a link created concurrently
  after the check is a residual TOCTOU risk. This is documented rather than
  hidden.
- The extension does not sandbox child processes at the OS level.

## 5. Command execution controls

### 5.1 Policy before execution

`src/commands/policy.ts` classifies every requested command:

| Class | Examples | v0.3.0 decision |
| --- | --- | --- |
| `validation` | `npm run test:unit`, `npm run lint`, `cargo test` | Allowed only if the exact string is in the user's allowlist |
| `read-only` | `git status`, `node --version` | Allowed only if exact allowlist; still requires explicit approval |
| `destructive` | `rm`, `del`, `format`, `git reset --hard`, publish/deploy | Always denied |
| `unknown` | anything else | Denied unless exact allowlist; treated as requiring approval |

The policy is not a prefix check. It uses the exact normalized command, rejects
shell metacharacters, requires a bare executable name, and delegates tokenization
to the same code the runner uses.

### 5.2 Execution controls

`runApprovedCommand` enforces:

- one command string, maximum 200 characters,
- no shell metacharacters (`; & | < > \` $` newline),
- exact allowlist membership,
- workspace-contained working directory,
- `spawn(..., { shell: false })`,
- a sanitized environment allowlist (no arbitrary `*_TOKEN`, `*_KEY`, etc.),
- `CI=1`, `NO_COLOR=1`, `FORCE_COLOR=0`,
- bounded output (default 120,000 characters),
- a hard timeout (default 180 seconds),
- SIGTERM then SIGKILL after 2 seconds on timeout or cancellation,
- redaction of the active API key and known secret patterns before output is
  returned, logged or persisted.

Approval is per command and single-use. The validation command the user
approves is exactly the command that runs; there is no interpolation of paths,
tokens or model text.

### 5.3 Windows shim limitation

On Windows, npm/yarn/pnpm expose `.cmd` shims that cannot be spawned directly
without `cmd.exe`. The runner resolves the bare allowlisted command and invokes
`%ComSpec% /d /s /c "<exact command>"`. This is not a model-controlled shell:
the command must already be an exact allowlist entry, and metacharacters are
rejected before this branch. The limitation is that `cmd.exe` parsing rules
still apply to the exact allowlisted string, so allowlist entries must be
reviewed as shell strings on Windows. This is documented in
`docs/TERMINAL_SECURITY.md`.

## 6. Provider boundary

- Provider settings are application-scoped. Workspace settings cannot redirect
  requests to an attacker-controlled endpoint.
- HTTPS is required by default; plain HTTP is allowed only for loopback
  addresses when `quantsmind.provider.allowInsecureLocalhost` is enabled.
- The API key is read from VS Code SecretStorage at request time and is never
  written to settings, logs, sessions, reports, fixtures or command arguments.
- Provider errors are normalized (`src/providers/errors.ts`); response bodies
  are not echoed into the UI or logs.
- The request contains only explicitly retrieved, redacted, budgeted content.
  File contents are never sent automatically.
- Native tool calling is not enabled in v0.3.0. The model cannot call a tool;
  the local controller asks for structured JSON and performs every action after
  local validation.
- Model output is untrusted JSON. Invalid shapes fail closed. A parse error
  never degrades into "assume the plan is fine".

### Prompt-injection handling

Workspace content is wrapped in `<workspace_context>` and the system prompt
states that it is untrusted reference data. Tool output (command output,
diagnostics) is treated the same way. The security model does not depend on the
model obeying this instruction: even a fully compromised model response can only
propose paths and commands, both of which pass the gates above. Instructions
found in a file cannot create an approval, change the allowlist, or execute
anything.

## 7. Secret handling and redaction

Redaction is applied at every output boundary:

- provider errors,
- command output (before it is returned),
- log lines,
- session events and completion reports,
- webview messages that include command output or errors.

The redactor removes the configured API key, authorization headers, bearer
tokens, common key formats (`sk-...`, AWS keys, private key blocks) and
user-defined secret values passed to the runner. A redacted value is replaced
with a stable marker; counts are tracked so truncated output is reported
honestly.

Session persistence stores only whitelisted fields. It never stores:

- API keys or credentials,
- raw provider request bodies or headers,
- full file content beyond the change record needed for review/history,
- command output beyond the configured output cap,
- absolute home-directory paths in evidence.

## 8. Approvals as authorization

The agent has no ambient authority. Each approval grants one scoped capability:

| Approval | Grants | Explicitly excludes |
| --- | --- | --- |
| Development plan | Permission to attempt listed tasks | Writes, commands, destructive actions |
| Change set | Apply the selected change ids once | Commands, unselected files, new sessions |
| Repair set | Apply selected repair ids once | Loosening tests, lint, security rules |
| Validation command | Run that exact command once | Other commands, automatic repetition |

Approval ids are validated against the pending request. The request is consumed
before the side effect. A second submission cannot replay it. Rejecting a plan
or change set writes nothing and is recorded as a rejection.

## 9. Integrity of evidence

The completion report is generated from recorded events and real command
results. It cannot claim a command passed unless a `ValidationRun` with
`exitCode === 0`, `cancelled === false` and `timedOut === false` exists. It
cannot claim a file was applied unless the apply outcome recorded it. Provider
text is never used as evidence of a side effect.

## 10. Supply chain

- One runtime dependency: `minimatch` pinned at a patched release.
- `npm audit` runs in CI; the runtime tree is verified by
  `scripts/verify-deps.mjs`.
- The VSIX verification script checks that no dev dependency, source file,
  map, log or credential file is packaged.
- CI runs on Ubuntu, Windows and macOS for unit, extension-host and packaged
  tests.

## 11. Residual risks and limitations

| Risk | Status | Mitigation |
| --- | --- | --- |
| Unsandboxed child processes | Accepted | Exact allowlist, per-command approval, sanitized env, timeout |
| Windows `cmd.exe` shim parsing | Accepted / documented | Exact allowlist strings; no metacharacters; user-reviewed entries |
| Symlink race inside workspace | Accepted / documented | Resolved containment check; hash preflight |
| Lexical retrieval may select a less relevant file | Accepted | Explicit user request; path reasons shown; no automatic execution |
| Provider may return malicious code | Accepted | Human reviews every diff; no auto-execution of returned code |
| Other extensions can change files | Accepted | Hash preflight; conflicts reported |
| Live provider behavior varies | Accepted | Deterministic mocks in tests; capability contract documented |
| Model may hallucinate completion | Mitigated | Completion requires recorded side effects and command evidence |

No claim in this document should be read as OS-level sandboxing. Commands run
with the user's privileges by design, which is why they are allowlisted and
explicitly approved.

## 12. Security test matrix

| Control | Unit test | Integration test |
| --- | --- | --- |
| Path traversal / absolute / ADS / UNC rejection | `changeModel.test.ts` | — |
| Excluded file refusal | `agentOrchestrator.test.ts`, `filters.test.ts` | — |
| Hash conflict leaves file untouched | `changeApply.test.ts` | `agentOrchestrator.test.ts` (conflict case) |
| Approval id validation | `agentOrchestrator.test.ts` | `chat.test.ts` (session protocol) |
| Command metacharacters and allowlist | `commandPolicy.test.ts`, `commandRunner.test.ts` | `agentOrchestrator.test.ts` |
| Process timeout and cancellation | `commandRunner.test.ts` | `agentOrchestrator.test.ts` (cancel validation) |
| Secret redaction | `redact.test.ts` | `credentials.test.ts` |
| Provider malformed JSON fails closed | `agentPlanning.test.ts` | `chat.test.ts` |
| Session migration / corrupted store | `sessionRepository.test.ts` | — |
| Terminal states and replay prevention | `agentStateMachine.test.ts` | `agentOrchestrator.test.ts` |
