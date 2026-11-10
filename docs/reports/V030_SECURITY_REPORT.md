# v0.3.0 security report

Date: 2026-11-03
Branch: `feature/v0.3.0`
Implementation commit: `d56ece5`

## Scope

This report covers the v0.3.0 changes: the agent session pipeline, project
intelligence, typed development plans, the scheduler, the control center,
command risk policy, diagnostics and repair, and session persistence. It does
not re-audit the unchanged v0.2.0 transport beyond regression checks.

## Security controls

### Authorization

- Four distinct user actions: plan approval, per-file change-set approval,
  repair approval, and explicit validation run.
- A plan approval never authorizes a write or a command.
- Selecting zero files rejects the change set and applies nothing.
- Approval ids must belong to the pending request and the stored change set.
- `pendingApproval` is cleared before execution continues, so a decision cannot
  be replayed.
- There is no model-facing API that applies files, runs commands, or moves the
  session through an approval.

### Untrusted model output

- Development plans are parsed strictly: task id pattern, duplicate rejection,
  known-dependency checks, cycle detection, task/criteria/file limits, and
  normalized workspace-relative paths.
- Unsafe suggested paths are dropped with a warning; invalid graphs fail
  closed.
- A model-proposed validation command is kept only if it exactly matches the
  user's allowlist and contains no shell metacharacters.
- Change sets pass the v0.2.0 path and content validators before preparation.
- Diagnostics come from real command evidence, not from model claims.
- The tool router has no default write or execute handler and rejects malformed
  requests.

### File writes

- Workspace containment through `normalizeChangePath` and the change file
  system adapter.
- Rejection of absolute paths, traversal, drive letters, colons, alternate data
  streams, UNC paths, and control characters.
- SHA-256 baseline check before modify, delete, or rename.
- Refusal to overwrite a create or rename destination that appeared after
  preparation.
- Per-file backups and reverse-order undo that refuses to overwrite later user
  edits.
- Built-in secret and dependency exclusions cannot be disabled by settings.

### Command execution

- Two independent gates: risk classification and exact allowlist validation.
- Destructive commands (`rm`, `git reset --hard`, `git clean`, `git push`,
  `npm publish`, `docker push`, `kubectl delete`, `terraform apply`, and
  similar) are refused even when allowlisted.
- Shell metacharacters, control characters, path-qualified executables, empty
  commands, and commands over 200 characters are rejected.
- `spawn` uses `shell: false`; the working directory must resolve inside the
  workspace.
- The environment is rebuilt from a fixed allowlist; unrelated parent
  variables are not forwarded.
- Timeout, `SIGTERM` then `SIGKILL`, cooperative cancellation, and output caps.
- Captured output is redacted before it reaches the UI.
- No API key is placed in command arguments or the child environment. The
  stored key is used only for redaction.

### Credentials and redaction

- API keys remain in VS Code SecretStorage; there is no credential setting.
- Provider settings remain application-scoped, so a workspace cannot redirect a
  stored key to another host.
- Endpoint validation rejects embedded credentials, query strings, fragments,
  and non-loopback HTTP.
- Exact credentials, masked key fragments, JWTs, bearer tokens, private keys,
  URL userinfo, and assignment/JSON secrets are redacted from prompts, errors,
  logs, and command output.
- Error bodies are sanitized and bounded.

### Sessions and restore

- Stored sessions are schema-checked and field-whitelisted; malformed sessions
  are dropped rather than partially trusted.
- The task graph and change paths are re-validated on load.
- A session is restored only when its `workspaceRoot` matches the current
  workspace.
- Applied files are re-hashed; drift fails the session with review required.
- Sessions interrupted in `applying` or `repairing` fail rather than resuming an
  unknown write.
- If integrity cannot be checked, the session is marked `needsReview`.
- Events and validation output are bounded and redacted.

### Webview

- Strict CSP, nonce-based local scripts, no remote assets, no inline executable
  scripts.
- Escaped output and metadata rendered with DOM text APIs.
- Strict message parsing: unknown or malformed messages are ignored, approval
  ids are strings and capped, and oversized id lists are truncated.

### Dependency surface

- One runtime dependency: `minimatch` 11.0.4, pinned; the packaged copy is
  verified at or above 11.0.1.
- `npm audit --omit=dev` reported 0 runtime vulnerabilities (info, low,
  moderate, high, critical).
- Development-only older minimatch copies are documented as non-shipped and
  rejected by the VSIX dependency guard.

## Verification evidence

| Control | Evidence |
| --- | --- |
| Plan rejection and parsing | `test/unit/agentPlanning.test.ts` |
| Scheduler graph safety | `test/unit/agentScheduler.test.ts` |
| Approval and lifecycle invariants | `test/unit/agentOrchestrator.test.ts`, `test/unit/agentStateMachine.test.ts` |
| Command policy and process boundary | `test/unit/commandPolicy.test.ts`, `test/unit/commandRunner.test.ts` |
| Path, hash, backup and undo | `test/unit/changeModel.test.ts`, `test/unit/changeApply.test.ts` |
| Redaction | `test/unit/redact.test.ts`, `test/unit/errors.test.ts`, `test/unit/logger.test.ts` |
| Protocol and CSP | `test/unit/protocol.test.ts`, `test/unit/webviewHtml.test.ts` |
| Session validation and migration | `test/unit/sessionRepository.test.ts` |
| Restore and hash drift | `test/unit/agentOrchestrator.test.ts` |
| Packaged secret scan and dependency guard | `npm run verify:vsix`, `npm run verify:deps` |
| Runtime advisory check | `npm audit --omit=dev` |

All listed automated tests passed in the executed suite; see
[V030_TEST_AND_VALIDATION_REPORT.md](V030_TEST_AND_VALIDATION_REPORT.md).

## Findings and residual risks

1. **Approval is a human control.** A user can approve a malicious or incorrect
   diff. The extension cannot prove semantic correctness.
2. **Allowlisted commands are trusted tooling.** An approved `npm` script can
   run dependency lifecycle scripts with network and file access. The process is
   not sandboxed beyond cwd containment, environment filtering, timeout, output
   caps, and cancellation.
3. **Windows launcher.** Node spawns `cmd.exe /d /s /c <command>` on Windows to
   run package-manager shims. Metacharacters and quoting are rejected before
   this point, but the launcher is a platform-specific residual risk.
4. **Diagnostics are heuristic.** Output parsing can miss or misattribute an
   error. Repair is advisory and may introduce new defects.
5. **Session events are not tamper-proof.** They are a local audit aid, not a
   cryptographic log.
6. **Workspace index scope.** Only the first workspace root is indexed; secrets
   are excluded by path and content rules, but a newly introduced credential
   format could be missed until redaction patterns are updated.
7. **No live-provider validation.** Third-party provider behavior, including
   error text and stream handling, was not exercised with a real credential.
8. **No GitHub Actions evidence in this session.** Cross-platform CI is
   configured but was not executed or verified remotely here.

No unresolved high-severity defect was found in the executed automated checks.
This is not a claim that no defect exists.
