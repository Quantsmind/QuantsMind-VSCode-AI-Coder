# v0.3.0 System Architecture

Product: QuantsMind AI Coder (`quantsmind.quantsmind-vscode-ai-coder`)

Version: 0.3.0 (internal release candidate, not GA)

Baseline: v0.2.0 (`develop` at `8c5ebbf`)

This document describes the architecture that is actually implemented on
`feature/v0.3.0`. It is written against the real module tree, not an imagined
project.

## 1. Product vision and scope

v0.2.0 was a workspace-aware, approval-first assistant. It could index a
workspace, retrieve relevant files, propose a multi-file change plan, apply
approved files, run an allowlisted validation command, and repair once.

v0.3.0 turns that assistant into a bounded agentic development workflow:

1. Analyze a natural-language requirement.
2. Inspect the project (languages, dependencies, scripts, entry points, tests).
3. Produce a structured development plan with tasks, dependencies and
   acceptance criteria.
4. Require explicit plan approval.
5. Execute tasks in dependency order, each producing a reviewable change set.
6. Require explicit change approval before any write.
7. Run approved build, test, lint or type-check commands.
8. Capture real output, exit codes and diagnostics.
9. On failure, produce a bounded root-cause hypothesis and repair change set.
10. Revalidate, then emit an evidence-based completion report.
11. Persist sessions and resume safely after an extension restart.

Scope boundaries:

- One VS Code extension, one npm package, one runtime dependency.
- No backend, database, telemetry, Python runtime, or QuantsMind service.
- No Marketplace publication, tags, or GitHub Releases in this campaign.
- The model never writes to disk or executes a process directly. Every side
  effect passes through a local policy and authorization layer.

## 2. Component architecture

```text
VS Code extension host
  src/extension.ts
    activation, commands, status bar, SecretStorage, OutputChannel
      |
      +-- ChatViewProvider (webview lifecycle, chat, approval UI)
      |     +-- chat/protocol.ts       strict webview <-> host messages
      |     +-- chat/prompts.ts        chat system prompts
      |     +-- chat/session.ts        bounded provider history
      |     +-- chat/persistence.ts    conversation store (globalState)
      |     +-- chat/webviewHtml.ts    CSP-fixed webview shell
      |
      +-- AgentOrchestrator (v0.3.0)
      |     +-- agent/stateMachine.ts  explicit transition table
      |     +-- agent/planning.ts      development-plan prompt + parser
      |     +-- agent/scheduler.ts     dependency order, retries, dedupe
      |     +-- agent/diagnostics.ts   failure classification
      |     +-- agent/report.ts        completion report builder
      |     +-- agent/models.ts        typed domain + runtime validators
      |     +-- sessions/repository.ts versioned session persistence
      |
      +-- ProjectIntelligence (v0.3.0)
      |     +-- project/intelligence.ts      dependency/script/config analysis
      |     +-- workspace/indexService.ts    workspace file index + retrieval
      |     +-- workspace/analyze.ts         language/entry-point detection
      |     +-- workspace/ignore.ts          .gitignore matching
      |
      +-- ChangeService (v0.2.0, reused)
      |     +-- changes/model.ts       change kinds + safe paths + hashes
      |     +-- changes/plan.ts        change-set prompt + parser
      |     +-- changes/diff.ts        dependency-free unified diff
      |     +-- changes/review.ts      review cards
      |     +-- changes/apply.ts       preflight, backups, apply, undo
      |     +-- changes/fs.ts          workspace-contained file system
      |     +-- changes/history.ts     persisted change history
      |
      +-- CommandExecutionService (v0.3.0 policy + v0.2.0 runner)
      |     +-- commands/policy.ts     risk classes and approval requirements
      |     +-- commands/runner.ts     structured spawn, limits, cancellation
      |
      +-- CompletionService + provider registry
      |     +-- providers/openaiCompatible.ts
      |     +-- providers/capabilities.ts
      |
      +-- security: credential, secretStore, redact, logger
      +-- config: defaults, resolve, settings
```

Module dependency rule: everything under `agent/`, `project/`,
`sessions/`, `changes/model|plan|diff|apply`, `commands/policy|runner`,
`providers/` is provider-neutral and free of `vscode` imports except the
adapters noted in section 3. Adapters (`changes/fs.ts`,
`changes/changeService.ts`, `workspace/indexService.ts`,
`config/settings.ts`, `chat/chatViewProvider.ts`, `extension.ts`) may use
`vscode`.

## 3. Layer responsibilities

| Layer | Modules | Responsibility |
| --- | --- | --- |
| Presentation | `chat/chatViewProvider.ts`, `chat/protocol.ts`, `media/*` | Render state, collect explicit user decisions, never invent progress |
| Application | `agent/orchestrator.ts` | Own the session lifecycle and call services in order |
| Domain | `agent/models.ts`, `agent/stateMachine.ts`, `agent/planning.ts`, `agent/scheduler.ts`, `agent/diagnostics.ts`, `agent/report.ts` | Pure rules and data |
| Integration | `workspace/indexService.ts`, `project/intelligence.ts`, `changes/*`, `commands/*`, `sessions/repository.ts` | Interact with VS Code, disk, processes, and globalState |
| Platform | `extension.ts`, `config/settings.ts`, `security/*` | Activation, settings, SecretStorage, logging |

## 4. Agent controller architecture

`AgentOrchestrator` is a single controller instance per extension activation.
It owns a map of sessions by id and a single active execution per session.

It does not contain UI logic. It receives:

- a `complete(messages, token)` function (provider-neutral),
- a `ProjectIntelligence`-shaped inspector/retriever,
- the existing `ChangeService` interface,
- a command execution function,
- a session repository,
- resolved limits,
- a logger and an `onChange` callback.

It returns immutable `AgentSessionView` snapshots. The chat provider forwards
them to the webview and records a human-readable transcript.

Concurrency rules:

- One session may run one execution phase at a time.
- A phase acquires an internal `busy` flag; a second call returns a structured
  conflict instead of running twice.
- Request sequence ids in the chat layer prevent late provider deltas from
  being displayed after a newer request or a cancel.
- The scheduler refuses to start a task whose status is `running` or
  `completed`, preventing duplicate execution.

## 5. Task and execution state machine

See [V030_EXECUTION_STATE_MACHINE.md](V030_EXECUTION_STATE_MACHINE.md) for the
full table. Summary:

```text
IDLE
 -> ANALYZING -> INSPECTING -> PLANNING
 -> AWAITING_PLAN_APPROVAL
 -> READY
 -> EXECUTING
 -> AWAITING_CHANGE_APPROVAL
 -> APPLYING -> VALIDATING
 -> DIAGNOSING -> AWAITING_REPAIR_APPROVAL -> REPAIRING
 -> (next task) EXECUTING
 -> COMPLETED | FAILED | CANCELLED
```

`PAUSED` is reachable only at safe points (`READY`, the approval states and
`DIAGNOSING`); a session cannot pause while a provider request or child process
is in flight. `resume` returns to the state that was paused. `CANCELLING` is a
transient state; user cancellation is cooperative and always ends in
`CANCELLED`, never `COMPLETED`.

Task states are separate from session states: `pending`, `blocked`, `running`,
`awaiting-approval`, `applied`, `validation-failed`, `repairing`, `completed`,
`failed`, `skipped`, `cancelled`.

## 6. Provider abstraction

`src/providers/types.ts` defines `AiProvider`. v0.3.0 preserves the
OpenAI-compatible adapter and adds a capability descriptor
(`src/providers/capabilities.ts`):

- `nativeToolCalling`: not used by v0.3.0; the adapter requests structured JSON
  in message text instead.
- `structuredOutput`: always `true` (validated JSON text).
- `streaming`: from settings.
- `maxContextChars`: advisory budget for request assembly.

Every model response is parsed as untrusted JSON. A malformed or unsupported
response fails closed with a user-visible reason. No model-supplied object is
executed, and no model-supplied path is written without the change path gate.

## 7. Workspace intelligence architecture

`WorkspaceIndexService` keeps a bounded in-memory path index and performs
lexical + metadata retrieval (v0.2.0). v0.3.0 adds `project/intelligence.ts`:

- `analyzeProject(files)` is pure: it consumes `{ path, content }` records.
- It detects languages and package managers from lockfiles and manifests.
- It parses `package.json` as untrusted JSON and extracts script names,
  commands and dependency names (never versions into prompts).
- It discovers `tsconfig`, ESLint, test and CI configuration files.
- It maps top-level modules by file counts.
- It reports detected scripts as context facts; the planner may only choose a
  validation command from the user's exact allowlist.
- Every derived fact is a `ContextFact` with an optional workspace `path`, so
  the user can see which file the fact came from.

Exclusions are enforced before content is returned: built-in sensitive
patterns, user globs, `.gitignore`, binary/empty/oversized files, and total
budget. Only redacted content can be placed into a provider request.

## 8. Tool routing architecture

The model does not receive an executable tool channel in v0.3.0. Instead, the
local controller performs the actions and asks the model only for structured
artifacts (a development plan, a change set, a repair proposal). This is the
controlled structured-response strategy required when native tool calling is
not guaranteed.

`agent/models.ts` defines the `ToolRequest`/`ToolExecutionResult` contracts for
future native tool adapters. Any future adapter must route through
`CommandPolicy` and `AgentOrchestrator`; the contracts deliberately contain no
direct execution function.

## 9. File modification and patch architecture

The v0.2.0 change pipeline is reused:

1. The model returns complete file contents (never patches that need fuzzing).
2. `changes/plan.ts` parses strictly and rejects malformed entries.
3. `changes/model.ts` normalizes paths and rejects absolute, drive-relative,
   alternate-data-stream, UNC, control-character and traversal forms.
4. `ChangeService.prepare` reads the current content, computes SHA-256, and
   builds review diffs.
5. The user approves individual files or the whole set.
6. `changes/apply.ts` preflights every approved change against its hash,
   writes a backup outside the workspace, and only then mutates.
7. `changes/history.ts` records the outcome for undo.

A change not approved by the user is never applied. A file changed after diff
generation is reported as a conflict and left untouched. Undo refuses to
overwrite files modified after apply.

## 10. Approval and authorization architecture

Approvals are explicit and scoped:

| Approval | Grant | Does not grant |
| --- | --- | --- |
| Development plan | Permission to attempt the listed tasks | Any file write, any command, any destructive action |
| Change set / file selection | Permission to apply those change ids | Permission to run a command or touch another file |
| Validation command | Permission to run that exact allowlisted command once | Permission to run other commands or repeat without a new request |
| Repair change set | Permission to apply the repair diff | Permission to weaken tests or bypass validation |
| Destructive command | Not supported by default; requires a separate explicit confirmation if ever enabled | — |

The plan schema forbids destructive operations entirely; the change model has
no shell or delete-directory primitive beyond deleting a listed file, which
still requires per-file approval.

## 11. Terminal execution architecture

`commands/policy.ts` classifies a requested command before execution:

- `validation`: an exact allowlist entry that looks like a build/test/lint/
  type-check command and contains no shell metacharacters.
- `destructive`: matches known destructive verbs (`rm`, `del`, `format`,
  `shutdown`, `git reset --hard`, `git clean`, publish/deploy verbs). Always
  rejected in v0.3.0.
- `unknown`: anything else. Rejected unless the exact command is allowlisted;
  even then it is treated as requiring approval.

`commands/runner.ts` executes with `spawn` and `shell: false` where the
platform permits it. On Windows, `.cmd`/`.bat` shims such as `npm.cmd` require
`cmd.exe /d /s /c`; the runner resolves the executable and uses the wrapper
only for those shims. Shell metacharacters remain rejected at validation, and
the command string is the exact allowlisted entry. This limitation is
documented in [../TERMINAL_SECURITY.md](../TERMINAL_SECURITY.md).

The runner enforces a workspace-contained cwd, a sanitized environment,
bounded stdout/stderr, a hard timeout, cooperative cancellation, and redaction
before returning output. Exit code, duration, approval identity and truncation
are recorded.

## 12. Persistence architecture

Two stores exist:

- `ConversationStore` (v0.2.0): bounded chat transcripts in globalState.
- `SessionRepository` (v0.3.0): versioned agent sessions in globalState.

The session store:

- writes a `schemaVersion` envelope,
- validates every field on read and drops malformed sessions rather than
  failing activation,
- migrates v1-shaped fixtures to the current version,
- caps the number of sessions, events per session, and stored characters,
- never stores credentials, raw provider requests, full command output beyond
  the configured cap, or file content not already part of a change record.

Resume revalidates the workspace:
- the session must belong to the current workspace root name,
- applied files are checked against their recorded SHA-256,
- previously completed tasks are not re-executed,
- a plan whose baseline has drifted is marked `needs-review` instead of being
  applied blindly.

## 13. Error handling and recovery

- Provider errors are normalized by `providers/errors.ts` (v0.2.0) and never
  include raw bodies.
- Parse failures are `configuration`-class user errors; the session ends in
  `FAILED` with an actionable hint.
- Command failures become `ValidationEvidence` and trigger `DIAGNOSING`.
- Repair is bounded by `maxRepairIterations`; when exhausted the session ends
  `FAILED` with the remaining diagnostics, never a fake success.
- Cancellation is cooperative and checked at every await boundary. Child
  processes are terminated (SIGTERM then SIGKILL after 2 s).
- Unexpected exceptions are logged (redacted) and end the phase in `FAILED`;
  they never leave the UI busy.

## 14. Security boundaries

See [V030_SECURITY_MODEL.md](V030_SECURITY_MODEL.md). Summary:

| Boundary | Control |
| --- | --- |
| Webview → host | Strict message parser; no file/command message without explicit approval ids |
| Host → provider | Explicit user action; application-scoped provider settings; HTTPS except loopback |
| Workspace → prompt | Explicit retrieval; exclusions; redaction; budget |
| Model → disk | Safe path gate; per-file approval; hash preflight; backups |
| Model → process | Exact allowlist; policy classification; no shell metacharacters; sanitized env |
| Secrets | SecretStorage only; redaction on logs, errors, command output, session logs |
| Untrusted content | System prompts mark workspace/tool output as data; instructions cannot grant permissions |

## 15. Observability and evidence

- Every session appends ordered `SessionEvent` records (state change, task
  start/finish, approval decision, change apply, command result, diagnostic,
  repair, completion).
- `CompletionReport` is generated from those events plus actual
  `ValidationRun` data. It never invents a command result.
- The Output channel receives lifecycle metadata only, redacted on every line.
- Evidence can be exported as Markdown from the report (contains no secrets).

## 16. Extension activation and lifecycle

`src/extension.ts` constructs settings, SecretStorage, provider service,
workspace index, project intelligence, change service, session repository,
orchestrator and chat provider. It registers the webview, commands, status bar,
configuration/secret listeners, and a workspace file watcher that invalidates
the index.

On deactivation the chat provider cancels in-flight provider requests, aborts
the active session step, disposes view listeners, and the status bar is hidden.
Recoverable state is persisted at every transition; if the host ends before a
cancellation checkpoint can be written, restart loads the last stored snapshot,
revalidates applied file hashes, and requires review before resume. It never
auto-executes an interrupted side effect.

## 17. Data flow

```text
User requirement
  -> ChatViewProvider.startAgentSession
  -> Orchestrator: ANALYZING
       -> ProjectIntelligence.inspect (local files only)
  -> INSPECTING (summaries + sources)
  -> PLANNING: provider returns DevelopmentPlan JSON
  -> parse + validate (tasks, dependencies, criteria)
  -> AWAITING_PLAN_APPROVAL (persisted)
  -> user approves
  -> READY -> scheduler picks runnable task
  -> EXECUTING: retrieval + provider returns change-set JSON
  -> ChangeService.prepare (hash + diff)
  -> AWAITING_CHANGE_APPROVAL
  -> user approves file ids
  -> APPLYING (backup + write)
  -> VALIDATING (explicit approved command)
  -> on failure: DIAGNOSING -> repair proposal -> approval -> REPAIRING -> revalidate
  -> next task or COMPLETED
  -> CompletionReport
```

## 18. Sequence diagram: full lifecycle

```text
User            Chat UI          Orchestrator        Provider        Workspace/FS      Commands
 |  requirement    |                  |                 |                 |               |
 |---------------->| startAgentSession|                 |                 |               |
 |                 |----------------->| ANALYZING       |                 |               |
 |                 |                  |---------------->| inspect         |               |
 |                 |                  |<----------------|                 |               |
 |                 |                  | PLANNING        |                 |               |
 |                 |                  |---------------->| plan JSON       |               |
 |                 |                  |<----------------|                 |               |
 |                 |<-- plan card ----| AWAITING_PLAN_APPROVAL            |               |
 |  approve plan   |                  |                 |                 |               |
 |---------------->|----------------->| READY -> EXECUTING                |               |
 |                 |                  |---------------->| change JSON     |               |
 |                 |                  |-- prepare ----------------------->| read + hash   |
 |                 |<-- diff cards ---| AWAITING_CHANGE_APPROVAL          |               |
 |  approve files  |                  |                 |                 |               |
 |---------------->|----------------->| APPLYING ------------------------>| backup+write  |
 |                 |                  | VALIDATING ----------------------|-------------->| run
 |                 |<-- output -------|                                 |               |
 |                 |                  |<-----------------------------------------------| exit
 |                 |                  | success -> next task / COMPLETED  |               |
 |                 |<-- report -------|                 |                 |               |
```

## 19. Module and interface definitions

| Interface | Implemented by | Purpose |
| --- | --- | --- |
| `IAgentController` | `AgentOrchestrator` | Start, approve, pause, resume, cancel, resume-from-store |
| `IPlanningService` | `agent/planning.ts` | Build plan messages, parse and validate plans |
| `ITaskScheduler` | `agent/scheduler.ts` | Order, dedupe, retry, block detection |
| `IProjectIntelligence` | `project/intelligence.ts` + `WorkspaceIndexService` | Inspect and retrieve |
| `IProvider` | `AiProvider` | Chat completion |
| `IToolRouter` | contracts only in v0.3.0 | Future tool routing |
| `IFileChangeService` | `ChangeService` | Prepare, apply, undo |
| `IApprovalService` | orchestrator approval methods | Record scoped decisions |
| `ICommandExecutionService` | `commands/policy.ts` + `runner.ts` | Validate and execute |
| `IDiagnosticsService` | `agent/diagnostics.ts` | Classify failures |
| `IRepairService` | orchestrator repair phase | Bounded repair proposals |
| `ISessionRepository` | `sessions/repository.ts` | Versioned persistence |
| `IValidationService` | orchestrator validation phase | Record real command results |
| `ICompletionReportService` | `agent/report.ts` | Evidence-based report |

## 20. Migration strategy from v0.2.0

- All v0.2.0 chat, provider, workspace, change, command and security modules are
  preserved. The v0.2.0 single-plan workflow is no longer reachable from the UI;
  the orchestrator drives the same `ChangeService` and command runner. The
  legacy `src/agent/taskRunner.ts` remains compiled but unreferenced.
- Existing conversations in `quantsmind.chat.conversations.v1` continue to
  load unchanged.
- Existing change history in `quantsmind.changes.history.v1` continues to load.
- New settings are additive and resource-scoped; existing provider settings
  remain application-scoped.
- Session storage starts at schema version 1 and includes an explicit envelope
  so future versions can migrate rather than discard.
- No v0.2.0 credential, backup, or evidence is deleted.

## 21. Known limitations and deferred functionality

- No native tool calling; structured JSON only.
- Lexical retrieval, no embeddings or symbol graph.
- Commands are allowlisted and unsandboxed; they run with the user's account.
- On Windows, `.cmd`/`.bat` shims use `cmd.exe`; this is a documented platform
  limitation, not a model-controlled shell.
- The webview is a single chat surface with embedded plan/task cards, not a
  separate multi-view control center. All required actions are present.
- No remote sync, multi-root orchestration, or background execution.
- Live third-party provider validation is not part of the automated suite; see
  `docs/LIVE_PROVIDER_VALIDATION.md`.
