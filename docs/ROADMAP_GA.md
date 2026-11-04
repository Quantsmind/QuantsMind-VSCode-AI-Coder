# QuantsMind VS Code AI Coder — General Availability Plan

**Document created:** 2026-11-04
**Repository state at creation:** branch `feature/v0.3.3`, HEAD `402d163`, 31 uncommitted entries
before this file was written (32 with it)
**Installed build under evaluation:** `quantsmind.quantsmind-vscode-ai-coder@0.3.4` (SHA-256 `58bf8e39412262acd21c933c9a8d9034fa163dc78676d7de265cd803e7efac22`)
**Current qualification verdict:** CONDITIONALLY QUALIFIED — see [V0.3.4_FINAL_QUALIFICATION_STATUS.md](./reports/V0.3.4_FINAL_QUALIFICATION_STATUS.md)

This document is the complete plan to move the product from "conditionally qualified build sitting
uncommitted on a feature branch" to a version the team is willing to hand to strangers. Nothing in
it has been executed yet: it is a plan, not a status report.

---

## 0. Gate 0 — the one decision that changes every other step

GA is not a single target. The exit criteria differ by distribution channel, so this must be settled
first.

| Option | What it means | Extra work it imposes |
| --- | --- | --- |
| **A. Public Marketplace GA** | `vsce publish` under publisher `quantsmind`, discoverable by anyone, auto-updating | Full marketplace compliance: icon, screenshots, `qna`, privacy statement, agreement to the Marketplace publisher policy, a publishable PAT, support/feedback channel, and a commitment to patch security findings on a SLA |
| **B. Controlled GA (recommended if user base is known)** | Versioned `.vsix` distributed to named installs (internal team, clients on a signed artifact + SHA-256) | Skips artwork/privacy/`qna`; still needs the same technical gates, plus a documented install/rollback path — which this project already has |
| **C. Preview/beta** | Publish as `pre-release` on the Marketplace | Same as A but with lower support expectations and a visible "not GA" label |

**Recommendation: B first, then A.** The product is technically strong (417 automated tests green,
live provider path confirmed, two controlled in-place installs with full data preservation) but has
eight unobserved manual checks, no artwork, and no localization or telemetry story. Those block a
"anyone can install this" claim far more than they block "these twelve people install this VSIX."

Everything below is written for A; the phases marked **[B-only skip]** are the ones a controlled
release can defer.

---

## 1. GA exit criteria (the definition of done)

v0.4.0 GA is declared only when **all** of these are demonstrably true, each with an artifact:

1. **Committed:** the work is on a release branch, committed, tagged `v0.4.0`; `git status` clean.
2. **Green on the full chain:** `npm run verify` passes end-to-end on Windows, macOS and Linux in CI,
   twice consecutively with no flaky-retry masking.
3. **Version-agnostic release tooling:** no hardcoded version strings anywhere in `scripts/` or test
   config; `npm run release -- --bump patch|minor|major` performs the whole bump atomically.
4. **All nine manual qualification tests observed and PASS** in a real, normally launched VS Code
   window by a human, with the sanitized Output-channel evidence attached.
5. **Upgrade path proven:** 0.3.3 → 0.4.0 on a profile holding *real* pre-0.3.4 conversations, with
   history, attachments, settings and credentials preserved and one rollback executed successfully.
6. **Security sign-off:** dependency audit clean (or every finding triaged in writing), redaction
   verified against a live request log, workspace-trust behaviour confirmed in restricted mode, no
   plaintext credential in any artifact.
7. **Marketplace readiness [B-only skip]:** icon, ≥1 screenshot, `qna` set, README with
   features/limitations/pricing/privacy, `engines.vscode` policy applied.
8. **Operations:** known-issues list published, CHANGELOG complete for the release, support route
   stated, diagnostics command verified to produce sanitized output.
9. **Artifact integrity:** published VSIX SHA-256 recorded in the release notes and matching the
   CI-built artifact.
10. **Rollback:** previous VSIX retained and its restore path documented (already satisfied —
    `C:\Users\Lenovo\QuantsMind-Backups\v034-20261104T115340\`).

---

## 2. Phase plan

Effort figures are engineer-day estimates, not measured. "Owner" is who must act: **User** = you
(decision, paid call, or native UI), **Agent** = me (code, docs, verification I can actually observe).

### Phase 1 — Freeze and commit v0.3.4 / prepare the release branch
**Owner: User (authorization) · Effort: 0.5 day · Blocks everything else**

- Move off `feature/v0.3.3` (the branch name now trails three released versions) to
  `release/v0.4.0` — or keep the name and accept the confusion; it is a naming decision, not a
  correctness one.
- Commit the 31 uncommitted entries as logical commits, not one blob:
  `fix(chat): selection-aware restore and empty-history filtering` (the 6 source/media files),
  `test(chat): regression coverage for history restore` (4 test files), `docs: v0.3.4 reports` (12
  untracked reports + CHANGELOG).
- Push the branch (**needs explicit authorization** — nothing has ever been pushed by me in this
  session).
- **Exit gate:** `git status` clean, HEAD contains the fix, reports preserved.

### Phase 2 — Close the eight outstanding manual checks
**Owner: User + Agent (recording) · Effort: 0.5 day, parallel with 1/3**

Exactly the list from `V0.3.4_FINAL_QUALIFICATION_STATUS.md` §5, with what each needs:

| # | Check | Who | Blocking for |
| --- | --- | --- | --- |
| 1 | New Chat history status text | User reads the webview | GA |
| 4 | Attachment persistence across reload | User, `fixture-answer.ts` already prepared | GA |
| 5 | Attachment freshness warning (`42` → `7`) | User, same fixture | GA |
| 6 | Clear and Delete native confirmations + sibling preservation | User (modals cannot be driven headlessly) | GA |
| 7 | Live conversation isolation | User | GA |
| 8 | Stop during live streaming | User, consumes OpenRouter credit | GA |
| 9b | Workspace trust in a normally launched window | User — now directly testable, the post-fix window was launched normally | GA |
| 9c | Attachment warnings leak no content | User (depends on 4/5) | GA |
| — | `request context …` / `completion …` Output lines from a real request | User copies from Output panel | Security sign-off |
| — | Campaign 5 webview runtime observations (4) | User | Carry-forward, not GA-blocking |

- The Output channel only persists to disk when VS Code is started with `--logsPath`; for any
  evidence I am to read, launch with that flag or paste the panel text.
- **Exit gate:** every row above PASS with evidence in the manual qualification report; no row left
  as "assumed".

### Phase 3 — Release engineering
**Owner: Agent · Effort: 1.5–2 days · On the critical path**

Problems found while surveying the repo, all verifiable today:

1. **Hardcoded release-blocking version strings.** A version bump currently breaks verification:
   - [scripts/verify-vsix.mjs:100](../scripts/verify-vsix.mjs#L100) — `assert(manifest.version === '0.3.4', 'version is 0.3.4')`
   - [scripts/verify-vsix.mjs:190](../scripts/verify-vsix.mjs#L190) — regex pinning `Version="0.3.4"` in the C# identity
   - [scripts/verify-install.mjs:6-7](../scripts/verify-install.mjs#L6) — default VSIX filename and
     the `expected` `quantsmind.quantsmind-vscode-ai-coder@0.3.4` string
   - [.vscode-test.packaged.mjs:5](../.vscode-test.packaged.mjs#L5) — packaged-test fixture version
   Fix: read `version` from `package.json` at runtime; parameterize the identity check.
2. **No release task.** Add `npm run release` = bump (`package.json` + `package-lock.json` +
   `CHANGELOG.md` + the compile-time identity marker) → `npm run verify` → `git tag` → report SHA-256.
   Keep it explicit and manual-trigger only; never run it as part of my routine verification.
3. **CI does not cover the release chain.** `.github/workflows/ci.yml` runs lint/unit on a
   Windows/macOS/Linux matrix plus an extension-host job (Linux uses xvfb), and has **no publish or
   artifact step**. Extend to: full `npm run verify` on all three OSes, upload the built VSIX + its
   SHA-256 as artifacts, `npm audit --audit-level=high` as a reporting (non-blocking at first) step,
   and a `release` workflow gated on a tag plus manual `workflow_dispatch`.
4. **Known defect to fix before GA.** `ConversationStore.delete()` can promote a blank successor as
   the new active conversation — I deliberately did not touch it during the authorized §9 fix
   because it was out of scope. It is in scope now: delete → select next non-empty → notify.
5. **Version-number hygiene.** v0.3.4 shipped on a branch called `feature/v0.3.3`; decide whether the
   history fix is `0.3.4` (already installed, so rewriting it is worse) or `0.3.5`, and tag whichever
   is true. Then v0.4.0 GA as the first release produced by the new `npm run release`.
- **Exit gate:** a dry-run `npm run release -- --bump patch` on a scratch branch completes and the
  CI artifact SHA matches the local VSIX.

### Phase 4 — Product completeness gaps that a public listing would expose
**Owner: Agent (implementation) + User (scope decisions) · Effort: 2–5 days · [B-only skip for artwork]**

Current manifest facts that matter for GA, all measured from `package.json`:
19 commands, 21 settings under `quantsmind.provider.*`, `categories: ["AI","Programming Languages","Other"]`,
`license: MIT` with `LICENSE` present, `repository` pointing at `github.com/ajit-ai/QuantsMind-VSCode-AI-Coder`,
`capabilities.untrustedWorkspaces.supported: true`, `virtualWorkspaces: false`.

Gaps:

- **No `icon`, no `screenshot`, no `qna`, no `badges`, no `extensionKind`** — the Marketplace listing
  renders blank and unbranded. Needs brand assets from you; I can build the pages around them but I
  will not invent logo artwork silently.
- **`virtualWorkspaces: false`** while `untrustedWorkspaces: true`: the extension silently refuses in
  remote/SSH and Settings-profile/ghost workspaces. Either state the restriction in the README (cheap)
  or declare support per remote authority (expensive). Decide; do not leave implicit.
- **No localization at all** — zero `l10n` calls, no `package.nls.json`. VS Code shows raw English
  strings everywhere, which is acceptable for GA but should be a declared limitation, not an accident.
- **No telemetry, no crash reporting** — a genuinely good privacy property, but it means GA support
  relies entirely on the `QuantsMind: Run Complete Self-Diagnostics` command and the user pasting
  logs. Document that as *the* support path.
- **`engines.vscode: ^1.95.0`** vs the current stable 1.144.1. Policy decision: support latest + N−1
  (bump to a recent floor and drop old installs) or keep the wide floor (more users, more untested
  host versions). My recommendation: keep the floor, but run the integration matrix on the floor
  version and the current version, and say so in the README.
- **`LIMITATIONS.md` exists and is organized** (provider/model, workspace intelligence, planning,
  changes, validation, agent sessions, conversations, UI/platform, security) — promote its content
  into the README rather than leaving it as a file only a source reader finds.
- **Settings surface:** 21 keys is a lot for a first-run user with no onboarding. Minimum viable fix
  is a "first run" notice that names the two settings that matter (baseUrl + model) and points at the
  provider docs; a full onboarding webview is post-GA.
- **`allowInsecureLocalhost`** is a security-relevant setting; GA needs it documented with its
  threat model, default-off confirmed, and a warn-level log line whenever it is actually used.
- **Exit gate:** README, docs, and manifest consistent with the shipped behaviour; nothing the
  Marketplace would reject.

### Phase 5 — Security & trust sign-off
**Owner: Agent (audit) + User (decision on any residual risk) · Effort: 1 day**

- **Dependency surface is already good:** one runtime dependency, `minimatch@11.0.4`. Keep it that
  way; add `npm audit` and a `verify:deps` lockfile-integrity assertion to CI (Phase 3).
- **Credential handling re-verified against a live request:** the SecretStorage row survived both
  0.3.3→0.3.4 and 0.3.4→0.3.4-fix in-place upgrades — proven functionally, because your live
  OpenRouter call returned exactly `READY`. Remaining gap: the request-time log lines have never been
  inspected by me (Phase 2, last-but-one row).
- **Redaction test at request time, not just activation:** assert no `sk-…`, no `Bearer …`, no
  `apiKey=` in a capture that *includes* a real completion. Pattern scan exists and gave 0 hits
  across activation + history reload; widen it to a request.
- **Workspace trust in restricted mode (9b)** — currently unobserved. `untrustedWorkspaces.supported:
  true` is a promise: an untrusted folder must not let the extension read workspace files, run
  terminal commands, or auto-apply edits. This needs a live observation, not a manifest diff.
- **Apply/undo and command-execution paths:** reviewed in earlier campaigns (v0.3.1 security
  remediation, v0.3.0 hardening). Re-run the existing suites, do not re-derive them.
- **Exit gate:** signed security checklist; every `quantsmind.provider.*` key's effect described in
  `docs/PROVIDER_CONFIGURATION.md` / `APPROVAL_AND_SECURITY.md`.

### Phase 6 — Support & operations
**Owner: Agent (docs) + User (channel) · Effort: 0.5 day · [B-only skip: public channel]**

- Publish **known issues for GA** derived from `LIMITATIONS.md` plus the §6 "expected, not defects"
  notes (legacy conversations showing `unavailable`/`capturedContext=0` after upgrade is the one most
  likely to be reported as a bug).
- Define the **support route** for a Marketplace release: GitHub issues on `ajit-ai/QuantsMind-VSCode-AI-Coder`
  (public repo — check nothing sensitive is in it before going public) or a private channel with
  "controlled release" framing.
- Verify `QuantsMind: Run Complete Self-Diagnostics` writes a sanitized report to
  `globalStorage\quantsmind.quantsmind-vscode-ai-coder\diagnostics\` and that pasting one is enough to
  triage a report without asking the user for their key.
- **Exit gate:** README "Getting help" section, issue template asking for the diagnostics path and
  version, and an explicit statement that the extension collects no telemetry.

### Phase 7 — Release-candidate validation on a clean environment
**Owner: User (machine/profile) + Agent (instrumentation & evidence) · Effort: 1 day · On the critical path**

Automated tests run against a mock provider and a temp profile, so they cannot prove the two things
GA actually depends on: a real provider under real load, and a real upgrade touching real data.

- **RC build** produced by `npm run release` from a tagged commit; SHA-256 recorded.
- **Cold install:** fresh VS Code profile, no prior QuantsMind, install the RC VSIX, configure the
  provider, run the nine qualification tests from the manual report top to bottom.
- **Upgrade test (the one that matters):** a profile holding real pre-0.3.4 conversations upgraded
  0.3.3 → RC, verifying history restore order, attachment chips reading `legacy` correctly, settings
  and credentials preserved, and no storage rewrite that loses records. Then **execute the rollback**
  once, so the rollback path is proven rather than assumed.
- **Migration salvage:** the read-and-salvage path for unreadable records needs a deliberately
  corrupted store exercised on disk, not only in a unit fixture.
- **Three-host CI evidence:** Windows, macOS, Linux extension host all green on the RC.
- **Exit gate:** RC report with PASS on every item, no unobserved rows.

### Phase 8 — Publish
**Owner: User (PAT, Marketplace consent) + Agent (mechanical publish) · Effort: 0.5 day**

- `vsce publish` requires a Visual Studio Marketplace **publisher `quantsmind`** with a PAT; that
  account and the consent to publish are yours. **I will not publish without an explicit go-ahead for
  that specific action.**
- Publish order: `--dry-run` equivalent (package + `verify:vsix`) → publish → confirm
  `code --list-extensions --show-versions` against the Marketplace entry → attach SHA-256 to the
  GitHub release notes.
- Post-publish: keep the previous VSIX in the backup root for at least one release cycle; do not
  delete `C:\Users\Lenovo\QuantsMind-Backups\v034-20261104T115340\` until GA is accepted.
- **Exit gate:** listing live, version correct, artifact checksum published.

### Phase 9 (post-GA, explicitly out of scope)
Terminal execution hardening, multi-file agent runs, localization, onboarding webview, real
telemetry opt-in, `virtualWorkspaces` support, auto-update channel policy. Listing these here keeps
them from creeping into the GA gate.

---

## 3. Recommended GA version and sequencing

GA at **v0.4.0**: the release-engineering changes (version-agnostic verification, new CI chain) are
behaviour-affecting for maintainers and deserve a minor bump rather than being smuggled into a patch.
v0.3.4 stays v0.3.4 because it is already installed on your machine — retagging an installed build
creates exactly the ambiguity that made this session's version bookkeeping hard.

## 4. Risk & limitation register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **No native UI access from this agent** — I cannot click the webview, accept a modal, or read a live Output panel | The 8 manual checks cannot be self-certified; any "GA ready" claim from me would be fabrication | They are recorded as USER-owned rows with exact instructions; I never mark them PASS |
| **Logs only persist with `--logsPath`** | Evidence collection fails silently on a normally launched window | Documented in Phase 2; every evidence request names the flag |
| **Host policy blocks SecretStorage metadata reads** (two attempts denied this session) | Cannot directly measure the credential row | Already resolved functionally by the live `READY` call; do not re-attempt |
| **Live provider tests cost real credit** | Tests 2/8 and any request-log capture are paid | Batch them into one user session; Test 2 already passed, so only Test 8 remains paid |
| **31 entries uncommitted, all v0.3.4 work** | A crash or an errant clean destroys the release candidate | Phase 1 is first for exactly this reason |
| **Environment stalls in the integration host** (observed once: 2 timeouts + "host unresponsive", 1m vs 28s, passing standalone and on re-run) | CI flakiness will be blamed on the product | Per-OS reruns in CI with visible retry counts, not silent retries |
| **`untrustedWorkspaces: true` unverified in live restricted mode** | A security promise the product may not keep | Phase 5 gate; do not publish until 9b is observed |
| **Marketplace exposure of a repo that has never been public-checked** | Leaks internal paths/names if the repo goes public as-is | Review repo contents before creating the public listing |

## 5. Authorizations I need from you

1. **Phase 1:** permission to create `release/v0.4.0`, commit the 31 entries as the described set,
   and push that branch. (Nothing has been committed or pushed by me this session.)
2. **Phase 3:** permission to modify `scripts/verify-vsix.mjs`, `scripts/verify-install.mjs`,
   `.vscode-test.packaged.mjs`, `.github/workflows/ci.yml`, `package.json` (new `release` script),
   and to fix `ConversationStore.delete()`.
3. **Phase 4:** brand assets (icon, ≥1 screenshot), the `qna` URL, and the decision on
   `virtualWorkspaces` + `engines.vscode` policy.
4. **Phase 2/7:** your sessions in the real UI, including one paid streaming call for Test 8.
5. **Phase 8:** a Marketplace PAT for publisher `quantsmind` and an explicit, separate go-ahead to run
   `vsce publish`.

## 6. Execution order and critical path

**Critical path: 1 → 3 → 7 → 8.** Phase 2 (manual checks) and Phases 4–6 run in parallel with Phase 3
because they have no code dependency on it.

| Week | Agent | User |
| --- | --- | --- |
| W1 | Phase 1 commits (on authorization); start Phase 3 de-hardcoding | Phase 2 sessions 1–2 (tests 1, 4, 5, 6, 9b, 9c + Output lines) |
| W2 | Finish Phase 3 (`npm run release`, CI, `delete()` fix); Phase 5 audit | Phase 2 session 3 (Test 8, paid stream); Phase 4 decisions + brand assets |
| W3 | Phase 4 implementation; Phase 6 docs | Review README/manifest changes |
| W4 | Phase 7 instrumentation; fix whatever the RC run surfaces | Cold-install + upgrade/rollback sessions on a clean profile |
| W5 | Phase 8 publish (only on explicit go-ahead) | Confirm listing, retain backups |

**Immediate next action, independent of Gate 0:** commit the current v0.3.4 work (Phase 1). It is the
only item that is pure downside to delay — everything else can wait for a decision, but 31 uncommitted
entries including the shipped fix is the actual risk on the table today.
