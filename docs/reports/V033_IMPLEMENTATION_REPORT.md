# v0.3.3 Implementation Report

## Baseline and branch
- Baseline: v0.3.2 commit `227d4ff1d92618fe257bd1d7f9fc3cf3d461535a`
- Branch: `feature/v0.3.3`

## Version
- 0.3.3

## Key changes
- Workspace root selection now scores multiple workspace folders instead of blindly selecting the first, and invalidates stale indexes on workspace folder changes.
- Removed file-scheme restriction in workspace indexing to support remote/virtual roots.
- Added read-only inspection command (`quantsmind.inspectWorkspace`).
- Added self-diagnostics command (`quantsmind.runSelfDiagnostics`) with report generation in extension storage.
- Added `SelfDiagnosticsService`.

## Verification
- Lint: pass
- Compile: pass
- Dependency checks: pass
- Unit/integration/packaged: pending final notification

## VSIX
- Path: `quantsmind-vscode-ai-coder-0.3.3.vsix`
- SHA-256: `1D05AA2CB1FDF51FCBACEA3B465E04556BFA969A11E2182E8505667427B101AA`
- Size: 250288 bytes
- Entries: 100

## Git
- Commit: pending
- Stable branches unchanged; no merge/tag/release/publish.