# v0.3.0 implementation report

Date: 2026-11-03
Branch: `feature/v0.3.0`
Implementation commit: `d56ece5`
Documentation commit: `4abf813`

## Scope delivered

The extension moved from a single approval-first task runner to a plan-first
agent session platform. The pipeline is:

```text
requirement -> local inspection -> development plan -> plan approval
  -> deterministic task scheduling -> per-task implementation
  -> per-file change review -> approval -> apply with backups
  -> approved validation command -> diagnostics
  -> bounded repair proposal -> approval -> revalidation
  -> evidence-based completion report
```

## Architecture as implemented

| Layer | Module | Responsibility |
| --- | --- | --- |
| Session model | `src/agent/models.ts` | Typed session, plan, task, approval, evidence, report and capability models |
| State machine | `src/agent/stateMachine.ts` | Allowed transitions, pause/resume rules, stage derivation |
| Planning | `src/agent/planning.ts` | Development-plan prompt and strict parser |
| Scheduling | `src/agent/scheduler.ts` | Graph validation, blocked refresh, runnable selection, ordering |
| Orchestration | `src/agent/orchestrator.ts` | Session lifecycle, approvals, apply, validation, repair, restore |
| Diagnostics | `src/agent/diagnostics.ts` | Failure evidence to diagnostics, no model guesswork |
| Report | `src/agent/report.ts` | Completion report from recorded evidence |
| Tools | `src/agent/toolRouter.ts` | Typed router, fail-closed, no default write/execute handler |
| Runtime | `src/agent/runtime.ts` | VS Code adapters for provider, workspace, hash, commands, storage |
| Project intelligence | `src/project/intelligence.ts` | Local languages, scripts, configs, modules, entry points, tests |
| Sessions | `src/sessions/repository.ts` | Versioned storage, validation, migration, compaction |
| Providers | `src/providers/capabilities.ts` | Capability descriptor; no native tool channel |
| Commands | `src/commands/policy.ts` | Risk classification independent of the allowlist |
| Control center | `src/chat/chatViewProvider.ts`, `src/chat/protocol.ts`, `media/chat.js`, `media/chat.css` | Session list, stages, approvals, diffs, diagnostics, report |

## What was implemented

- **Typed models and interfaces.** `AgentSession`, `AgentState`,
  `DevelopmentPlan`, `Requirement`, `AcceptanceCriterion`, `AgentTask`,
  `TaskExecution`, `ProjectContext`, `WorkspaceFileReference`, `ChangeSet`,
  `FileChange`, `UnifiedDiff`, `ApprovalRequest`, `ApprovalDecision`,
  `ToolRequest`, `ToolExecutionResult`, `CommandPolicy`, `Diagnostic`,
  `RepairProposal`, `ValidationRun`, `ValidationEvidence`, `SessionEvent`, and
  `CompletionReport`.
- **Orchestration interfaces.** `IAgentController`, `IPlanningService`,
  `ITaskScheduler`, `IProjectIntelligence`, `IProvider`, `IToolRouter`,
  `IFileChangeService`, `IApprovalService`, `ICommandExecutionService`,
  `IDiagnosticsService`, `IRepairService`, `ISessionRepository`,
  `IValidationService`, and `ICompletionReportService`.
- **State machine.** Explicit transitions, terminal-state guards, pause and
  resume rules, cancellation, and stage derivation that only counts recorded
  artifacts.
- **Planning engine.** A bounded requirement, a JSON development-plan prompt,
  and a parser that enforces task ids, dependency existence, acyclicity, path
  safety, criteria limits, and exact command allowlisting.
- **Scheduler.** Pure functions for graph validation, blocked-task refresh,
  next-runnable selection, deterministic topological ordering, and the
  `runnable` / `waiting` / `done` / `deadlock` / `stopped` decisions.
- **Project intelligence.** Local project facts, `package.json` script and
  dependency awareness, modules, entry points, config files, and test-file
  counts. Retrieval delegates to the existing workspace index.
- **Multi-step execution.** One active task per session, repeated scheduling,
  provider-call limits, repair limits, timeouts, and per-task change sets.
- **Change control.** Reused the v0.2.0 complete-file change model, path
  containment, SHA-256 baselines, per-file approval, backups, undo, and change
  history.
- **Command execution.** A risk policy that denies destructive commands even
  when allowlisted, exact allowlist matching, no-shell spawn, sanitized
  environment, workspace containment, output caps, timeout, cancellation, and
  redacted evidence.
- **Diagnostics and repair.** Parsing of real command output into bounded
  diagnostics, a repairable `diagnosing` state, a bounded repair proposal, a
  fresh approval, and mandatory revalidation.
- **Session persistence.** A versioned store with field-level sanitization,
  legacy migration, a future-schema guard, event/output caps, compaction,
  workspace-root checks, interrupted-write failure, and applied-file hash
  revalidation on restore.
- **Control center.** Session creation and selection, stage and state display,
  plan cards, task status, per-file diffs and approvals, validation output,
  diagnostics, repair review, completion report, pause, resume, cancel, restore,
  delete, and undo.
- **Provider layer.** An unchanged OpenAI-compatible transport plus a
  capability descriptor that reports no native tool calling and advisory
  context limits.
- **Version and packaging.** Version `0.3.0` across the manifest, lockfile,
  scripts, tests, provider user agent, and fallback version. The packaged
  extension remains an alpha preview.

## Not implemented or deliberately out of scope

- Native tool calling or a model-controlled executor. The tool router exists
  but has no default write or execute handler.
- Image, audio, or multimodal messages.
- Automatic apply, automatic command execution, or automatic resume of an
  interrupted side effect.
- Parallel task execution.
- Multi-root workspace indexing (the first workspace root is used).
- A general terminal or arbitrary shell execution.
- Marketplace, Open VSX, tags, releases, telemetry, backend, or database.
- Live third-party provider validation. No real provider call was made.

## Baseline and change size

- Baseline: `8c5ebbf` (v0.2.0 merged into `develop`).
- Implementation commit: `d56ece5` — 39 files, 8,315 insertions, 494 deletions.
- Documentation commit: `4abf813` — 25 files, 3,623 insertions, 242 deletions.
- No changes were made to `main` or `develop`. No merge, tag, release, or
  publication occurred.

## Verification summary

The full local pipeline `npm run verify` completed with exit code 0. Details are
in [V030_TEST_AND_VALIDATION_REPORT.md](V030_TEST_AND_VALIDATION_REPORT.md).
