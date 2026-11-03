# v0.3.0 test and validation report

Date: 2026-11-03
Branch: `feature/v0.3.0`
Commits: `d56ece5` (implementation), `4abf813` (documentation)

All results below were produced locally on the machine described under
Environment. Nothing in this report is inferred from CI or from a live
provider, because neither was executed.

## Environment

| Item | Value |
| --- | --- |
| OS | Windows 10.0.26300 x64 |
| Shell | Git Bash |
| Node.js | v24.18.0 |
| npm | 11.11.1 |
| VS Code under test | 1.95.0 (cached archive `.vscode-test/vscode-win32-x64-archive-1.95.0`) |
| Provider used by tests | Deterministic loopback mock server |
| External credentials used | None |

## Commands and results

| Command | Result |
| --- | --- |
| `npm run lint` | Passed, no output |
| `npm run compile` | Passed |
| `npm run verify:deps` | Passed; runtime minimatch 11.0.4 pinned, 8 development-only copies documented |
| `npm run test:unit` | **339 passing** (5 s) |
| `npm run test:integration` | **28 passing** (16 s), extension host exit code 0 |
| `npm run package` | Passed; 99 files, 240.26 KB in the final rebuild |
| `npm run verify:vsix` | All checks passed |
| `npm run test:packaged` | **4 passing** (1 s), extension host exit code 0 |
| `npm run verify:install` | Installed `quantsmind.quantsmind-vscode-ai-coder@0.3.0` into an empty extensions directory |
| `npm run verify` (full pipeline) | **Exit code 0**; repeats all gates above |

### Full pipeline evidence

`npm run verify` output markers:

```text
339 passing (5s)
28 passing (16s)
DONE  Packaged: quantsmind-vscode-ai-coder-0.3.0.vsix (99 files, 240.18 KB)
All VSIX checks passed.
4 passing (1s)
Verified installed extension: quantsmind.quantsmind-vscode-ai-coder@0.3.0
```

The integration and packaged runs printed an initial "Extension host
unresponsive" notice followed by "is responsive"; both hosts completed with
exit code 0 and all tests passed. These notices are VS Code host startup
diagnostics, not test failures.

The packaged README gained the report links after the full pipeline, so the
artifact was rebuilt once more at the end. That rebuild printed
`99 files, 240.26 KB`; `npm run verify:vsix` and `npm run test:packaged`
(4 passing) were re-run against it and passed. Documentation under `docs/` is
excluded from the package, so later report edits do not change the artifact.
The packaged artifact table below records the final rebuild.

## Coverage by workstream

| Workstream | Evidence |
| --- | --- |
| V030-01 orchestration | `agentStateMachine.test.ts`, `agentOrchestrator.test.ts` |
| V030-02 project intelligence | `projectIntelligence.test.ts`, `workspaceIndex.test.ts` (integration) |
| V030-03 planning | `agentPlanning.test.ts`, `protocol.test.ts` |
| V030-04 multi-step workflow | `agentScheduler.test.ts`, `agentOrchestrator.test.ts` |
| V030-05 multi-file implementation | `changeModel.test.ts`, `changeApply.test.ts`, `changeReview.test.ts`, `agentOrchestrator.test.ts` |
| V030-06 command execution | `commandPolicy.test.ts`, `commandRunner.test.ts` |
| V030-07 diagnostics and repair | `agentOrchestrator.test.ts` (diagnosis, repair approval, repair limit) |
| V030-08 sessions and resume | `sessionRepository.test.ts`, `agentOrchestrator.test.ts` (restore, hash drift, review gate) |
| V030-09 control center | `webviewHtml.test.ts`, `protocol.test.ts`, `chat.test.ts` (integration) |
| V030-10 provider and context | `provider.test.ts`, `endpoint.test.ts`, `filters.test.ts`, `projectIntelligence.test.ts` |
| V030-11 security and reliability | `redact.test.ts`, `errors.test.ts`, `commandPolicy.test.ts`, `protocol.test.ts`, `sessionRepository.test.ts` |

## Acceptance scenarios A-L

| Scenario | Verification | Status |
| --- | --- | --- |
| A. Inspect a local project without sending file content | Project intelligence reads only `package.json`; workspace integration checks indexing and retrieval | IMPLEMENTED AND VERIFIED |
| B. Produce a valid plan with tasks, dependencies and criteria | `agentPlanning.test.ts` valid-plan case; `agentOrchestrator.test.ts` full lifecycle | IMPLEMENTED AND VERIFIED |
| C. Reject malformed plans, duplicate ids, cycles and unsafe paths | `agentPlanning.test.ts`, `agentScheduler.test.ts` | IMPLEMENTED AND VERIFIED |
| D. Approve a plan and execute tasks in dependency order | `agentOrchestrator.test.ts`, `agentScheduler.test.ts` | IMPLEMENTED AND VERIFIED |
| E. Review and approve change sets per file; reject applies nothing | `agentOrchestrator.test.ts` rejection cases; integration chat test | IMPLEMENTED AND VERIFIED |
| F. Apply approved files with backups and detect stale files | `changeApply.test.ts`; orchestrator workspace-conflict case | IMPLEMENTED AND VERIFIED |
| G. Run an allowlisted validation command and capture evidence | `agentOrchestrator.test.ts`, `commandRunner.test.ts` | IMPLEMENTED AND VERIFIED |
| H. Reject non-allowlisted, metacharacter and destructive commands | `commandPolicy.test.ts`, `commandRunner.test.ts` | IMPLEMENTED AND VERIFIED |
| I. Diagnose a failed validation and propose a bounded repair | `agentOrchestrator.test.ts` repair cases | IMPLEMENTED AND VERIFIED |
| J. Revalidate after repair; fail honestly when repair is exhausted | `agentOrchestrator.test.ts` repair-limit and repair-rejection cases | IMPLEMENTED AND VERIFIED |
| K. Complete with an evidence-based report; no fabricated success | `agentOrchestrator.test.ts` report assertions, including no-command evidence | IMPLEMENTED AND VERIFIED |
| L. Restore a persisted session, revalidate hashes and require review | `sessionRepository.test.ts`, `agentOrchestrator.test.ts` restore cases | IMPLEMENTED AND VERIFIED |

"VERIFIED" here means implemented and covered by deterministic automated tests
that were executed in this session. It does not mean a live provider or a manual
UI pass occurred.

## Packaged artifact

| Item | Value |
| --- | --- |
| File | `quantsmind-vscode-ai-coder-0.3.0.vsix` |
| Size | 246,024 bytes (240.26 KiB) |
| Entries | 99 |
| SHA-256 | `462e6503949cdc4080626f638241a22f655cdc46b9392fce5cee78284fa46170` |
| Manifest version | `0.3.0` |
| Commands | 16 |
| Runtime dependency | minimatch 11.0.4 only |

`verify:vsix` confirmed required entries, absence of source/tests/docs/scripts,
absence of `.env`, `.npmrc`, `.netrc`, `.pypirc`, maps and TypeScript files,
preview status, the command count, application-scoped provider settings, and
the packaged minimatch version.

## Not executed

- **Live third-party provider validation.** No credential was requested or used.
  See [LIVE_PROVIDER_VALIDATION.md](../LIVE_PROVIDER_VALIDATION.md).
- **Manual control-center UI pass.** Automated tests validate the HTML, CSP,
  protocol, and message flow; they do not prove visual layout or interaction
  quality.
- **macOS and Linux local execution.** The CI workflow defines those jobs, but
  they were not run locally and no GitHub Actions result is claimed.
- **GitHub Actions execution.** The workflow change was not pushed or triggered
  during this session.
- **Accessibility audit.** No screen-reader or visual audit was performed.

## Determinism and isolation

All automated provider traffic stays on loopback. The workspace fixture contains
dummy values only. No test modifies a user project; extension-host tests use an
isolated VS Code instance and fixture workspace. No test requires an external API
key.
