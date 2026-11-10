# v0.3.1 Security Remediation Report

## Findings addressed
- F1 (workspace trust): enforced `vscode.workspace.isTrusted` in orchestrator start/resume/approve/validate, ChangeService prepare/apply/undo, command runner, and chat UI. Restricted Mode allows read-only chat/inspection only.
- F2 (symlink/junction containment): `WorkspaceChangeFs.resolve` now canonicalizes root and existing targets/ancestors, rejects escaping links, fails closed for non-file schemes.
- F3 (apply/repair/undo): unique `applyId` per apply, per-apply backup namespace, append-only history, reverse-order task-level undo with hash checks.
- F4 (settings scope): allowlist, agent limits, command timeouts scoped to application.
- F5 (npm script visibility/governance): removed `npm run verify` from default allowlist; command classification retains destructive/unknown refusal.

## Tests
- Existing 371 tests retained (339 unit + 28 integration + 4 packaged).
- Security regression paths exercised by integration tests.

## Known limitations
- TOCTOU residual risk documented; not claimed race-free.
- Windows junction tests rely on platform; CI matrix should cover.