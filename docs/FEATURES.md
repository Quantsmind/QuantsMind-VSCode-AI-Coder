# Feature completion matrix (v0.3.0)

This matrix maps the v0.3.0 campaign workstreams to shipped behavior and
evidence in this build. It describes what exists; it does not claim that every
external gate has passed. The consolidated results are in
[V030_TEST_AND_VALIDATION_REPORT.md](reports/V030_TEST_AND_VALIDATION_REPORT.md).

## Workstreams

| Workstream | Requirement | Shipped behavior | Primary evidence |
| --- | --- | --- | --- |
| V030-01 | Session orchestration and state machine | Explicit `AgentState` table, guarded transitions, persisted state events, single active execution per session, cancellation and pause/resume | `src/agent/stateMachine.ts`, `test/unit/agentStateMachine.test.ts` |
| V030-02 | Project intelligence | Local analysis of languages, package manager, scripts, dependencies, configuration files, modules, entry points and tests; only `package.json` content is read | `src/project/intelligence.ts`, `test/unit/projectIntelligence.test.ts` |
| V030-03 | Requirement and planning engine | Bounded requirement model, development-plan prompt and strict parser for tasks, dependencies, criteria and allowlisted commands | `src/agent/planning.ts`, `test/unit/agentPlanning.test.ts` |
| V030-04 | Multi-step workflow | Deterministic scheduler, dependency blocking, duplicate-execution guard, provider-call budget and per-task implementation | `src/agent/scheduler.ts`, `src/agent/orchestrator.ts`, `test/unit/agentScheduler.test.ts`, `test/unit/agentOrchestrator.test.ts` |
| V030-05 | Multi-file implementation | Reuses complete-file change sets, safe paths, SHA-256 preflight, per-file approval and backups | `src/changes/*`, `test/unit/change*.test.ts` |
| V030-06 | Real tool and command execution | Exact allowlist policy, risk classes, destructive-command denial, `spawn` without shell, sanitized environment, output caps, timeout, cancellation and evidence capture | `src/commands/policy.ts`, `src/commands/runner.ts`, `test/unit/commandPolicy.test.ts`, `test/unit/commandRunner.test.ts` |
| V030-07 | Debugging and self-repair | Diagnostics parsed from real output, bounded repair proposals, fresh per-file approval, revalidation, failure when repair is exhausted | `src/agent/diagnostics.ts`, `src/agent/orchestrator.ts`, `test/unit/agentOrchestrator.test.ts` |
| V030-08 | Persistent sessions and resume | Versioned store, validation on read, legacy migration, event caps, applied-hash revalidation, `needs-review` on drift, explicit restore | `src/sessions/repository.ts`, `test/unit/sessionRepository.test.ts`, `test/unit/agentOrchestrator.test.ts` |
| V030-09 | Developer control center | Sidebar session list, state/stage timeline, plan and task cards, diff approvals, repair and validation controls, diagnostics, report, pause/resume/cancel/restore/delete/undo | `src/chat/webviewHtml.ts`, `src/chat/protocol.ts`, `media/chat.js`, `media/chat.css`, `test/unit/protocol.test.ts`, `test/unit/webviewHtml.test.ts` |
| V030-10 | Provider and context layer | Provider-neutral completion, capability descriptor, application-scoped provider settings, explicit retrieval, exclusions, redaction and budgets | `src/providers/*`, `src/context/*`, `src/workspace/*`, `src/agent/runtime.ts` |
| V030-11 | Security and reliability | Strict webview parser, no model-to-tool channel, approval ids validated against the pending request, secret isolation, hash preflight, fail-closed parsing | `src/chat/protocol.ts`, `src/agent/orchestrator.ts`, `docs/architecture/V030_SECURITY_MODEL.md` |

## Acceptance scenarios A-L

The campaign defines deterministic scenarios A-L, exercised with mock providers
and local fixtures. The integration suite launches an isolated VS Code instance
and a loopback OpenAI-compatible server; no external key is required.

| Scenario | Expected behavior | Status in this build |
| --- | --- | --- |
| A | Index and inspect a real local project without sending file content | IMPLEMENTED AND COVERED (unit + integration index tests) |
| B | Produce a valid plan with tasks, dependencies and criteria | IMPLEMENTED AND COVERED |
| C | Reject malformed plans, duplicate ids, cycles and unsafe paths | IMPLEMENTED AND COVERED |
| D | Approve a plan and execute tasks in dependency order | IMPLEMENTED AND COVERED |
| E | Review and approve change sets per file; reject applies nothing | IMPLEMENTED AND COVERED |
| F | Apply approved files with backups and detect stale files | IMPLEMENTED AND COVERED |
| G | Run an allowlisted validation command and capture evidence | IMPLEMENTED AND COVERED |
| H | Reject non-allowlisted, metacharacter and destructive commands | IMPLEMENTED AND COVERED |
| I | Diagnose a failed validation and propose a bounded repair | IMPLEMENTED AND COVERED |
| J | Revalidate after repair; fail honestly when repair is exhausted | IMPLEMENTED AND COVERED |
| K | Complete with an evidence-based report; no fabricated success | IMPLEMENTED AND COVERED |
| L | Restore a persisted session, revalidate file hashes and require review | IMPLEMENTED AND COVERED |

The status wording above means the behavior is implemented and has automated
coverage in this repository. It does not mean a live third-party provider run
occurred; see `docs/LIVE_PROVIDER_VALIDATION.md`.

## Explicit non-goals in this build

- Native tool calling or a model-controlled executor.
- Image input, audio, or multimodal messages.
- Automatic apply, automatic command execution, or automatic resume of an
  interrupted side effect.
- Remote telemetry, update service, backend, database, or multi-user sessions.
- Marketplace or Open VSX publication, tags, or GitHub Releases.
- Persisting credentials or full workspace snapshots.
