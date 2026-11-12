# Coding workflows — v2.5.5

This page documents the coding-workflow layer added in v2.5.5: structured
plans for substantial tasks, multi-file change tracking, patch safety,
checkpoints and recovery, and validation guidance. It composes the features
documented in [Agent workflow](AGENT_WORKFLOW.md),
[Project intelligence](PROJECT_INTELLIGENCE.md),
[Language intelligence](LANGUAGE_INTELLIGENCE.md),
[Build and test integration](BUILD_AND_TEST.md) and
[Change review](CHANGE_REVIEW.md) — it does not replace any of them, and it
does not enable any autonomous execution.

## Where it fits

The workflow layer coordinates the existing pieces: repository and language
intelligence select context; the development planner proposes tasks; change
sets, approvals, diffs, backups and undo work exactly as before; the command
runner still gates every command behind workspace trust and an allowlist;
checkpoints annotate the existing session lifecycle. Nothing here executes an
unapproved edit or command.

## Structured plans for substantial tasks

A coding task is routed between the two existing paths:

- **Simple tasks** — short, single-purpose questions — stay in the ordinary
  flow. No plan is forced on you.
- **Substantial tasks** — those with multi-file, multi-language,
  restructuring or restructuring-category signals — produce a **structured
  plan** first. Routing is deterministic and conservative
  (`src/workflow/classify.ts`); the reasons are visible in session events.

A structured plan (v2.5.5 envelope, `src/workflow/plan.ts`) contains:

- **Objective and scope** — the plan summary and per-task titles.
- **Evidence** — locally established facts: primary/supporting languages and
  detection confidence (v2.5.4 inventory), build-system detections, the
  requirement itself. Evidence never invents tooling that was not detected.
- **Assumptions** — model proposals explicitly labelled as unverified
  (suggested paths, plan steps), plus a detection-quality caveat when
  confidence is partial or unknown.
- **Category** — one of `bugfix`, `feature`, `refactor`, `test`, `docs`,
  `dependency`, `cross-language`, `other` (heuristic classification).
- **Expected files** — validated, deduplicated, workspace-relative, bounded.
- **Completion criteria** — deduplicated acceptance criteria from the plan.
- **Validation strategy** — text grounded in detection; the exact commands
  come from `detect_build_system`, never guessed.

The plan is shown in the approval prompt before anything consequential
happens; nothing applies until you approve it.

## Multi-file changes and scope tracking

- Relevant files are chosen with repository intelligence and the v2.5.4
  cross-language relationships (shared API contracts, SQL schema ↔ models,
  client/server layers, build files ↔ compiled sources). These relations
  **inform** selection; they never trigger edits.
- Every applied change-set can be compared against the plan's expected
  files with `checkChangeScope` (`src/workflow/scope.ts`):
  - `unexpected` — applied files the plan did not expect (scope expansion is
    surfaced, never hidden);
  - `missing` — expected files never applied (partial completion is reported
    as partial);
  - `matched` — in-scope applied files.
- Task completion distinguishes `planned-not-applied`, `partial` and
  `complete`; the session is never reported complete while expected work
  remains unresolved. At completion the session records a `Change scope:`
  note (matched/missing/unexpected) in the event timeline alongside the
  workflow phase notes.

## Patch and edit safety

The apply pipeline (`src/changes/apply.ts`) enforces:

- Path validation and workspace boundaries; absolute paths, `..` traversal
  and control characters are rejected before any tool on disk runs.
- Baseline hashes on every modify; stale files are conflicts, never
  silent overwrites.
- A backup of every file written before mutation; `undoAppliedChanges`
  restores in reverse order and refuses to clobber post-apply user edits.
- Per-file failure isolation: conflicts/failures in one file never abort or
  silently downgrade the rest; results are itemized.
- **Cancellation** (v2.5.5): `applyChangePlan` supports cooperative
  cancellation between files; the session's cancellation token stops further
  edits, unprocessed files are reported as skipped (never silently applied).
- Only explicitly approved changes are applied.

## Checkpoints and recovery

Coarse workflow phases (persisted as ordinary session note events with a
`workflow:<phase>` marker; `src/workflow/checkpoint.ts`):

`created → planned → awaiting-review → approved → editing → changes-applied
→ validation-pending → validation-complete → completed` (plus `blocked` and
`cancelled`).

- Transitions are validated (`canTransitionWorkflowPhase`); cancellation is
  legal from every non-terminal phase and terminal phases are sticky.
- After an interruption or crash, restoring the session parses the
  checkpoint trail: an interruption during `editing`/`changes-applied`
  forces `needsReview` and a note telling you to verify disk state before
  editing again — edits are **never** silently re-run.
- The existing checkpoint repository (execution snapshots) and the v2.5.0
  continuation planner are untouched; the workflow layer annotates, never
  replaces them.
- Completion is not reported while required steps remain unresolved;
  failed steps stay visible in the final report.

## Validation workflow

`detect_build_system` (unchanged execution path) now also returns a bounded
`validationPlan` with the commands actually detected (`build`/`test`), their
reasons and evidence quality — plus notes for tsconfig/ESLint markers.
Commands are **proposed, never auto-run**: execution still requires the
shared approved command runner (workspace trust + user allowlist + explicit
approval + cancellation + output limits). When nothing is detected the plan
contains no steps and a note telling the agent/user to inspect before
assuming commands — none are invented.

Validation outcomes are reported separately (see
`summarizeValidation`): `not-run`, `passed`, `failed`, `skipped`, `blocked`,
`inconclusive`. Mixed passed/skipped without a failure is `inconclusive`,
not success.

Focused validation before broader suites is the default posture; nothing
launches unbounded test campaigns.

## Approvals, MCP and privacy

- Plan approval, change approval, repair approval, command approval — all
  unchanged, all mandatory for consequential actions.
- MCP tools keep exact per-call approval; credentials stay in SecretStorage,
  outputs stay delimited/untrusted; the v2.5.5 envelope never contains
  contents of files (paths, counts and facts only).
- Language-intelligence content in prompts can be disabled with
  `quantsmind.languageIntelligence.enabled` (default true); the workflow
  layer obeys the same switch (the validation plan in `detect_build_system`
  is omitted when disabled).

## Known limitations

- Plans come from the model; evidence is local but scope is inherently
  approximate. `scope` tracking flags, it does not prevent, unexpected edits.
- `checkChangeScope` is a reporting layer; the extension does not block
  already-approved edits that fall out of scope mid-flight — it surfaces
  them.
- Validation proposals never bypass the allowlist; commands absent from the
  project remain unavailable by design.
- Checkpoints are coarse by design; fine-grained per-file restore semantics
  live in the existing apply/undo machinery.
- No autonomous retries, self-revision loops, plan/replan cycles or
  unattended execution are introduced in this version.
