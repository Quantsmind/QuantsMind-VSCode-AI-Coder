# Feature completion matrix (v0.2.0)

This matrix maps the v0.2.0 campaign workstreams to shipped behavior and
evidence. It describes what exists in this build; it does not claim prior gates
passed.

| Workstream | Requirement | Shipped behavior | Evidence |
| --- | --- | --- | --- |
| A | Fix provider-masked key redaction | Masked key fragments (`sk-…abcd`, `Bearer sk-***`, masked assignments and JSON) are redacted before display, logging, or sending; exact credentials are replaced first | `src/security/redact.ts`, `test/unit/redact.test.ts`, `test/unit/errors.test.ts` |
| A | Credential and sensitive-data protection | SecretStorage only, no credential setting, sanitized auth headers and URL userinfo, JWT/token/private-key rules, redacted logs and error bodies | `src/security/*`, `src/providers/errors.ts`, `docs/reports/V020_SECURITY_REMEDIATION.md` |
| A | Actionable errors | Normalized codes with hints; masked-key explanation instead of echo; error card actions to set a key, open settings, or show the log | `src/providers/errors.ts`, `src/chat/chatViewProvider.ts`, `media/chat.js` |
| B | Workspace structure discovery | Local index of workspace paths with language, size, entry points, top-level structure, and test-file awareness | `src/workspace/analyze.ts`, `src/workspace/indexService.ts` |
| B | Relevant-file retrieval | Query ranking and attach-for-review flow, bounded by settings | `src/workspace/indexService.ts`, `test/unit/workspaceAnalyze.test.ts`, `test/integration/workspaceIndex.test.ts` |
| B | Include/exclude policy | Built-in exclusions, user globs, `.gitignore`, `.git/info/exclude`, binary/large/empty rejection | `src/workspace/ignore.ts`, `src/context/filters.ts` |
| B | No automatic transmission | Index and retrieval are local; sending requires **Send** or a task start | `src/chat/chatViewProvider.ts`, `test/integration/workspaceIndex.test.ts` |
| C | Structured multi-file change model | Create, modify, delete, rename with summary, notes, per-file reason, and content | `src/changes/model.ts` |
| C | Plan and explanation | JSON plan parser with fenced/prose tolerance and strict validation | `src/changes/plan.ts`, `test/unit/changePlan.test.ts` |
| C | Unified diff | LCS-based diff with context, rename/delete/create headers, truncation, and large-file fallback | `src/changes/diff.ts`, `test/unit/changeDiff.test.ts` |
| C | Stale and conflict detection | SHA-256 baseline hashes checked at apply; conflicts reported | `src/changes/apply.ts`, `test/unit/changeApply.test.ts` |
| C | Workspace containment | Relative-path normalization, workspace URI containment, colon/ADS/traversal/UNC rejection | `src/changes/model.ts`, `src/changes/fs.ts`, `test/unit/changeModel.test.ts` |
| D | Review and approval UX | Per-file selection, approve/reject, warnings, diffs, and task status in the chat view | `src/changes/review.ts`, `media/chat.js`, `test/unit/changeReview.test.ts` |
| D | Backups and undo | Backup before write, reverse-order undo, refusal to overwrite later edits | `src/changes/apply.ts`, `test/unit/changeApply.test.ts` |
| D | Task change history | 50-entry persisted history with restore | `src/changes/history.ts`, `test/unit/changeHistory.test.ts` |
| D | Never silently modify files | No write path without an approval message carrying task and change IDs | `src/chat/protocol.ts`, `src/agent/taskRunner.ts` |
| E | Controlled agentic workflow | Stages: retrieve, plan, review, approval, apply, validate, repair | `src/agent/taskRunner.ts`, `test/unit/agentTaskRunner.test.ts` |
| E | Progress and cancellation | Stage status in the UI; Stop/cancel marks pending stages skipped | same |
| E | Limits | Provider-call, repair-iteration, and wall-clock limits | `src/config/resolve.ts`, `test/unit/configV2.test.ts` |
| E | No false completion | `applied` only after writes; failures, rejections, and cancellations have distinct statuses | `test/unit/agentTaskRunner.test.ts` |
| F | Approved command execution | User-triggered allowlisted command with exact display | `src/commands/runner.ts`, `media/chat.js` |
| F | No arbitrary shell | `shell: false`, bare executable, metacharacter rejection | `test/unit/commandRunner.test.ts` |
| F | Containment and sanitized output | Workspace cwd, sanitized environment, output cap, redaction | same |
| F | Timeouts and cancellation | Configurable timeout, abort signal, process termination | same |
| F | Cross-platform | Windows `cmd.exe` launch path plus POSIX path; tests run on three platforms in CI | `src/commands/runner.ts`, `.github/workflows/ci.yml` |
| G | Persisted conversations | Create, switch, delete, bounded storage across reloads | `src/chat/persistence.ts`, `test/unit/conversationStore.test.ts` |
| G | Chat rendering | Markdown-lite, fenced code, copy buttons, file references, streaming, Stop, status, errors | `media/chat.js`, `test/unit/webviewHtml.test.ts` |
| G | Task and review visibility | Stage list, diffs, warnings, validation output, undo control | `media/chat.js` |
| H | Provider architecture | Provider-neutral contract and registry; OpenAI-compatible and OpenRouter-compatible endpoints | `src/providers/*`, `docs/PROVIDERS.md` |
| H | Configuration and credentials | Configurable URL/model, SecretStorage only | `src/config/*`, `src/security/*` |
| H | Streaming and non-streaming | SSE and JSON modes | `src/providers/openaiCompatible.ts`, `test/unit/provider.test.ts` |
| H | Normalized safe errors | Nine stable codes with hints and redaction | `src/providers/errors.ts` |
| H | Extensible abstraction | New providers register a factory without chat/agent changes | `src/providers/registry.ts` |
| I | Unit tests | Workspace, config, changes, commands, persistence, agent, redaction | `test/unit` |
| I | Mock provider integration | Loopback OpenAI-compatible server; no live credential | `test/unit/helpers.ts`, `test/integration/chat.test.ts` |
| I | Extension-host and packaged tests | Activation, index, chat, plan/apply/undo, packaged VSIX | `test/integration`, `test/packaged` |
| I | Regressions | Masked key, Windows containment, executable path, empty plan | `test/unit`, `test/integration` |
| J | Cross-platform support | Windows/macOS/Linux CI jobs | `.github/workflows/ci.yml` |
| J | CI quality gates | Lint, compile, unit, extension host, dependency guard, VSIX, packaged tests | same |
| J | Advisory review | Runtime minimatch patched; dev-only advisories documented | `scripts/verify-dependencies.mjs`, `SECURITY.md` |
| K | Documentation | README, CHANGELOG, architecture, features, providers, workspace, editing, terminal security, testing, security, limitations, upgrade, reports | `docs/` |
| L | Version, VSIX, commit | 0.2.0 across the manifest, scripts, and tests; VSIX built and verified; feature branch commit | `package.json`, `docs/reports/V020_COMPLETION_REPORT.md` |

## Explicit non-goals in this build

- Tool calling, image input, and multimodal messages.
- Automatic command execution or automatic apply.
- Marketplace or Open VSX publication.
- Remote telemetry, update service, backend, or database.
- Persisting credentials or full workspace snapshots.
