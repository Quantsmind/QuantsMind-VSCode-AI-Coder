# v0.2.0 Completion Report

Date: 2026-11-03

Product: QuantsMind AI Coder (`quantsmind.quantsmind-vscode-ai-coder`)

Version: 0.2.0 (alpha preview, not general availability)

Branch: `feature/v0.2.0`, created from `develop` at `1bbff3a`

Implementation commit: `e8e87f8` (`feat: add approval-first workspace assistant
for v0.2.0`)

## 1. Scope and outcome

The v0.2.0 campaign extended the read-only chat extension into a
workspace-aware assistant with:

- Local workspace indexing, summaries, and relevant-file retrieval.
- Structured multi-file change plans with reviewable unified diffs.
- Per-file approval, workspace-contained apply, backups, undo, and history.
- A staged agent workflow with limits, cancellation, and no false completion.
- Approved, allowlisted validation command execution.
- Persisted conversations and an improved chat surface.
- Remediation of the provider-masked API-key redaction defect.
- Expanded unit, integration, extension-host, packaged, and CI coverage.
- Documentation and version updates for 0.2.0.

All code is on the local `feature/v0.2.0` branch. Nothing was pushed, tagged,
merged, published, or connected to a remote.

## 2. Baseline preserved

- `develop` baseline commit: `1bbff3a` (`docs: add live validation runbook and
  hardening report`).
- Pre-existing working-tree changes and untracked v0.1.1 report files were kept.
- The historical reports `docs/reports/V011_RELEASE_HARDENING_REPORT.md` and
  `docs/reports/V011_LIVE_PROVIDER_VALIDATION_REPORT.md` were not deleted or
  rewritten as claimed passes.
- No reset, clean, stash, or overwrite of existing work was performed.

## 3. Implementation summary

| Area | Delivered |
| --- | --- |
| Credential safety | Masked-key and exact-credential redaction, header/userinfo scrubbing, redacted errors and logs |
| Workspace | Local index, technology/entry-point detection, `.gitignore` support, relevance retrieval, summaries |
| Changes | Create/modify/delete/rename model, JSON plan parser, unified diffs, review warnings, hashes |
| Approval | Per-file approval, reject, cancel, stale detection, contained writes, backups |
| Recovery | Reverse-order undo, conflict refusal, 50-entry persisted history |
| Agent | Retrieve/plan/review/approval/apply/validate/repair stages with step and time limits |
| Commands | Exact allowlist, shell-free execution, sanitized environment, output caps, timeouts |
| Chat | Persisted conversations, markdown/code rendering, copy, file references, status, error actions |
| Providers | Provider-neutral contract and registry; OpenAI-compatible/OpenRouter-compatible endpoint support |
| Tests | Unit and extension-host coverage for all new modules and the end-to-end approval cycle |
| CI | Cross-platform matrix, dependency guard, packaged verification |

The requirement-to-evidence matrix is in [FEATURES.md](../FEATURES.md).

## 4. Security remediation

See [V020_SECURITY_REMEDIATION.md](V020_SECURITY_REMEDIATION.md) for the defect
description, fixes, controls, and residual risk.

Key result: the provider-masked key fragment that appeared in the v0.1.1 Output
log is now redacted by the masked-form rules in `src/security/redact.ts`, with
regression tests in `test/unit/redact.test.ts` and `test/unit/errors.test.ts`.

No real credential was requested, printed, logged, committed, or included in any
test, fixture, report, or diagnostic.

## 5. Verification evidence

All commands below were executed locally on Windows 10.0.26300 x64 with Node
24.18.0, npm 11.11.1, and the downloaded VS Code 1.95.0 test host. Results are
recorded from the actual runs.

| Gate | Command | Result |
| --- | --- | --- |
| Lint | `npm run lint` | Passed, no findings |
| Dependency guard | `npm run verify:deps` | Passed; runtime minimatch 11.0.4; 8 dev-only entries below 11.0.1 |
| Compile | `npm run compile` | Passed |
| Unit tests | `npm run test:unit` | **282 passing (4s)** |
| Extension-host tests | `npm run test:integration` | **28 passing (8s)** |
| Production audit | `npm audit --omit=dev` | **0 vulnerabilities** |
| Packaging | `npm run package` | Passed; 86 files, 197.42 KB |
| VSIX inspection | `npm run verify:vsix` | All checks passed |
| Packaged-host tests | `npm run test:packaged` | **4 passing (2s)** |
| Clean install | `npm run verify:install` | Installed and listed as `quantsmind.quantsmind-vscode-ai-coder@0.2.0` |
| Full dependency audit | `npm audit` | 19 development-only advisories (1 low, 17 moderate, 1 high); runtime is clean |

### Full audit detail

`npm audit` reports development-only findings in the ESLint,
`@typescript-eslint`, `@vscode/vsce`, and Mocha toolchains, including a high
`serialize-javascript` advisory reached through Mocha. The suggested automatic
fix downgrades Mocha to 5.0.5, which is not acceptable. These packages are not
included in the VSIX and are not loaded by the extension at runtime. They remain
a maintenance item.

### Test-host notes

The extension host logs a transient "unresponsive" message while VS Code starts,
then recovers and completes. The suite exited with code 0. No test was marked as
passed without executing.

## 6. Continuous integration status

`.github/workflows/ci.yml` is configured with:

- A quality matrix on Ubuntu with Node 20, 22, and 24, plus Windows and macOS on
  Node 22.
- Lint, compile, unit tests, and the dependency guard.
- Extension-host tests on Ubuntu, Windows, and macOS.
- A release job that runs the full `npm run verify` pipeline under `xvfb-run`
  and uploads the VSIX.

**The CI jobs were not executed for this build.** No remote was created or
pushed. Ubuntu and macOS execution remains unverified, and the CI configuration
is not evidence of a passing pipeline. Only the local Windows results in section
5 were executed.

## 7. Artifact

| Property | Value |
| --- | --- |
| File | `quantsmind-vscode-ai-coder-0.2.0.vsix` |
| Size | 202,163 bytes (197.42 KB) |
| Entries | 86 |
| SHA-256 | `d0daa2629ee85b2138d21e842288cd3c9108060a9a9977fc6f77d9ca9ee3f178` |
| Runtime dependency | `minimatch` 11.0.4 (patched) |
| Manifest version | 0.2.0 |
| Preview flag | `true` |

The archive contains the compiled `out/src` tree, `media`, manifest, README,
LICENSE, CHANGELOG, and the runtime minimatch package. It excludes source, tests,
docs, scripts, CI, source maps, TypeScript declarations, dev dependencies,
credentials, and fixture secrets.

## 8. Installation and manual validation

Install:

```bash
code --install-extension quantsmind-vscode-ai-coder-0.2.0.vsix
```

Manual smoke test:

1. Confirm the provider is configured and the status shows ready.
2. Run **QuantsMind: Summarize Workspace** and check exclusions.
3. Attach a selection and send a prompt; confirm streaming and Stop.
4. Run **QuantsMind: Start Agent Task** on a disposable file; confirm the task
   stops at `awaiting-approval` and no file changes.
5. Approve the file, verify the content, then **Undo applied changes**.
6. Run an allowlisted validation command and confirm the exact command, output,
   and exit status.
7. Inspect the Output channel after an authentication failure and confirm no key
   or masked key fragment appears.

The full live-gate procedure remains
[LIVE_PROVIDER_VALIDATION.md](../LIVE_PROVIDER_VALIDATION.md). It has **not** been
re-run for v0.2.0.

## 9. Known limitations

See [LIMITATIONS.md](../LIMITATIONS.md). The most relevant for release:

- Only the OpenAI-compatible `/chat/completions` shape; no tool calling or
  multimodal input.
- Lexical, metadata-based retrieval; no embeddings or symbol graph.
- Text-only changes; partial apply is not automatically rolled back.
- Commands are allowlisted but not sandboxed.
- First workspace root only for indexing.
- No telemetry, update service, or remote backend.
- Ubuntu/macOS CI and the v0.2.0 live provider gate remain unexecuted.

## 10. Git change summary

Branch: `feature/v0.2.0` from `develop` (`1bbff3a`).

New source areas:

- `src/agent/`
- `src/changes/`
- `src/commands/runner.ts`
- `src/workspace/`
- `src/chat/persistence.ts`

Modified areas include the extension entry point, chat provider and protocol,
prompts, webview HTML/CSS/JS, configuration defaults and resolution, redaction,
provider errors and user agent, version surfaces, CI, packaging scripts, and
tests.

New tests:

- `test/unit/`: `agentTaskRunner`, `changeApply`, `changeDiff`, `changeFs`
  helper, `changeHistory`, `changeModel`, `changePlan`, `changeReview`,
  `commandRunner`, `configV2`, `conversationStore`, `workspaceAnalyze`,
  `workspaceIgnore`.
- `test/integration/workspaceIndex.test.ts`.
- Fixtures `test/fixtures/output.js` and `test/fixtures/sleep.js`.
- An end-to-end plan/approve/write/undo test in
  `test/integration/chat.test.ts`.

Documentation: README, CHANGELOG, SECURITY, CONTRIBUTING, architecture,
development, testing, live validation, and new feature/provider/workspace/
editing/terminal-security/limitations/upgrade docs and reports.

No remote, push, merge, tag, or publication operation was performed. The commit
is local to the feature branch.

## 11. Release-readiness status

**Conditionally ready for internal preview evaluation; not ready for public or
GA release.**

Ready:

- Version 0.2.0 is consistent across the manifest, scripts, packaged tests, and
  documentation.
- Lint, compile, unit, extension-host, packaged-host, archive inspection, and
  clean-install checks passed locally on Windows.
- The shipped runtime has no known production dependency advisory.
- The masked-key redaction defect is fixed with regression coverage.
- The approval, apply, undo, and command boundaries are implemented and tested.

Outstanding before any public release:

1. Execute the v0.2.0 live provider procedure, including an Output-channel
   credential scan after a provider error.
2. Execute the configured Ubuntu and macOS CI jobs on a real remote.
3. Decide whether development-only audit findings must be resolved first.
4. Complete a visual and accessibility review of the webview.
5. Obtain explicit authorization for any remote, push, tag, or publication
   operation. None was requested or performed.

Do not describe v0.2.0 as GA, Marketplace-published, or fully live-validated.
