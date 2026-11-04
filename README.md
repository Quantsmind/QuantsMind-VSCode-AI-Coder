# QuantsMind AI Coder

A standalone Visual Studio Code extension that turns your AI provider into an
**agentic, project-aware development assistant** with explicit context control,
**approval-first file changes**, allowlisted validation, bounded repair and
**evidence-based completion reports**. Version **0.3.0** is an **alpha preview**:
it is not a Marketplace release and is not general availability.

This product is completely independent. It does not depend on QuantsMind-Agent,
another QuantsMind repository, a shared source folder, a common SDK, a shared
runtime, or an external project workspace.

## What works today

### Agent sessions

An agent session follows one explicit pipeline:

```text
requirement
 -> project inspection
 -> development plan (tasks, dependencies, acceptance criteria)
 -> plan approval
 -> task scheduling
 -> implementation (one change set per task)
 -> per-file change review
 -> apply approved files
 -> build/test/lint/type-check evidence
 -> diagnostics and bounded repair (reviewed again)
 -> revalidation
 -> completion report
```

- The control-center panel shows the current session state, every stage, the
  task graph, approval cards with unified diffs, validation output, diagnostics
  and the final report.
- Plan approval, change-set approval and repair approval are independent. None
  of them approves a command or another stage.
- Sessions are persisted and can be **restored** after a window reload. Restore
  revalidates applied file hashes and requires review before any resume.
- Sessions can be paused at safe boundaries, resumed, cancelled and deleted.
- **Undo** restores the backups created by the most recent applied change set.

### Conversations and answers

- Sidebar chat view in the Activity Bar with markdown and fenced code rendering,
  per-code-block **Copy**, and inline file references.
- OpenAI-compatible chat completions over HTTPS, with streaming or
  non-streaming responses.
- Opt-in plain HTTP for loopback endpoints such as a local model server.
- Ask, explain and generate modes with a read-only system prompt.
- Conversations persisted across window reloads: create, switch, rename by
  first message, and delete, bounded to 30 conversations.

### Project intelligence

- Local workspace index with technology detection, entry points, top-level
  structure and test-file awareness.
- `analyzeProject` derives languages, package manager (from lockfiles), scripts,
  dependency names, configuration files and modules **without reading file
  contents beyond `package.json`**.
- **Summarize Workspace** produces a reviewable summary without sending
  anything.
- **Attach Relevant Workspace Files** ranks local files against your task
  description and attaches them for review before you press Send.
- `.gitignore` plus built-in secret, dependency, build-output, binary and
  large-file exclusions.
- Configurable indexed-file, retrieved-file, character and attachment limits.

### Approval-first changes

- The provider returns complete file contents (create, modify, delete, rename),
  never fuzzy patches.
- SHA-256 baselines detect files that changed after the diff was prepared.
- Writes are contained to the workspace, and every applied file is backed up.
- A file changed after review is reported as a conflict and left untouched.
- **Show Change History** lists recent change sets and can restore them.

### Validation and repair

- Only an exact command from your allowlist can run, and only after you choose
  it and approve the run.
- Commands run without a shell (`spawn` with `shell: false`; documented
  Windows `.cmd` shim exception), with a sanitized environment, output caps,
  timeout and cancellation.
- Output, exit code, timeout, cancellation and redaction are captured as
  validation evidence.
- A failed validation can produce one bounded repair proposal, which is again
  subject to per-file review and approval. Repair never weakens tests, removes
  assertions or disables lint rules automatically.
- When repair is exhausted or rejected, the session fails with the real
  diagnostics attached, not a fabricated success.

### Evidence and security

- Every session appends ordered events; the completion report is derived from
  those events and real command results.
- API keys live in VS Code SecretStorage, never in settings or logs.
- Masked-key redaction scrubs the exact stored credential and recognizable
  masked forms from prompts, errors, command output and logs.
- Provider settings are application-scoped so a workspace cannot redirect your
  credential.
- Strict webview content security policy with no remote resources.

## What it deliberately does not do

- It does not modify workspace files without explicit plan and per-file
  approval.
- It does not run arbitrary shell commands; only exact allowlisted validation
  commands can run, and only after you approve them.
- It does not expose a model-to-tool channel. The model proposes JSON; the local
  controller performs every side effect after validation.
- It does not approve or apply its own plans, repairs or commands.
- It does not scan or upload your workspace automatically. The index is local.
- It does not include a backend service, database, or telemetry.
- It does not support native tool calls, image inputs, or multimodal content.
- It does not publish, tag, or deploy anything.

## Requirements

- VS Code **1.95.0** or newer (desktop).
- An OpenAI-compatible provider endpoint and API key, or a local model server
  that exposes the same API shape.
- Node.js **20 or newer** only if you are building or testing from source.

## Install from a VSIX

```bash
code --install-extension quantsmind-vscode-ai-coder-0.3.0.vsix
```

Reload the window if VS Code requests it. Open the QuantsMind icon in the
Activity Bar, or run **QuantsMind: Open Chat** from the Command Palette.

## Configure

1. Run **QuantsMind: Set API Key** and paste the provider key. The input is
   masked and the value is stored in VS Code SecretStorage.
2. Run **QuantsMind: Configure Provider** to set the base URL, model, timeout,
   and other provider options. Provider settings are application-scoped.
3. Optionally run **QuantsMind: Select Model** for a quick model change.

### OpenAI-compatible endpoint

Set `quantsmind.provider.baseUrl` to the API root, for example
`https://api.openai.com/v1`. The extension appends `/chat/completions`.

### Local model example

For a local server on port `11434`:

```json
{
  "quantsmind.provider.baseUrl": "http://127.0.0.1:11434/v1",
  "quantsmind.provider.model": "your-local-model"
}
```

Plain HTTP is accepted only for `localhost`, `127.0.0.1`, and `::1`. Remote
endpoints must use HTTPS. You can disable loopback HTTP entirely with
`quantsmind.provider.allowInsecureLocalhost`.

## Run an agent session

1. Open a workspace folder.
2. Switch the mode to **Agent session (plan -> execute)**, describe the
   requirement, and press **Send**. Alternatively run
   **QuantsMind: Start Agent Session**.
3. Review the development plan: summary, approach, risks, tasks, dependencies
   and acceptance criteria. Approve or reject it.
4. Each task produces a change set. Review the per-file diff and approve only
   the files you want, or reject the set.
5. Approved files are backed up and written. Choose an allowlisted validation
   command to collect build/test evidence.
6. If validation fails, request a repair, review it, and approve the repair
   files you want. Repair is revalidated.
7. The completion report records the real outcome, tasks, files, validation
   evidence, diagnostics and anything unresolved.

## Settings

| Setting | Default | Scope | Purpose |
| --- | --- | --- | --- |
| `quantsmind.provider.type` | `openai-compatible` | application | Provider adapter |
| `quantsmind.provider.baseUrl` | `https://api.openai.com/v1` | application | API root URL |
| `quantsmind.provider.model` | `gpt-4o-mini` | application | Model identifier |
| `quantsmind.provider.requestTimeoutMs` | `120000` | application | Total request timeout |
| `quantsmind.provider.maxOutputTokens` | `2048` | application | `max_tokens` value |
| `quantsmind.provider.temperature` | `0.2` | application | Sampling temperature |
| `quantsmind.provider.stream` | `true` | application | Prefer SSE streaming |
| `quantsmind.provider.allowInsecureLocalhost` | `true` | application | Permit loopback HTTP |
| `quantsmind.context.excludeGlobs` | `[]` | resource | Additional exclusion globs |
| `quantsmind.context.maxFileSizeKb` | `256` | resource | Per-file size limit |
| `quantsmind.context.maxTotalChars` | `48000` | resource | Total attached characters |
| `quantsmind.context.maxFiles` | `20` | resource | Maximum attachments per request |
| `quantsmind.workspace.maxIndexedFiles` | `5000` | resource | Local index cap |
| `quantsmind.workspace.maxRetrievedFiles` | `8` | resource | Files retrieved per request |
| `quantsmind.workspace.retrievalMaxChars` | `40000` | resource | Retrieved-context budget |
| `quantsmind.agent.maxSteps` | `6` | resource | Provider calls per agent session |
| `quantsmind.agent.maxRepairIterations` | `1` | resource | Repair passes after failure |
| `quantsmind.agent.timeoutMs` | `180000` | resource | Agent step timeout |
| `quantsmind.commands.allowlist` | five npm commands | resource | Approved validation commands |
| `quantsmind.commands.timeoutMs` | `120000` | resource | Validation command timeout |
| `quantsmind.commands.maxOutputChars` | `120000` | resource | Captured output cap |

Provider settings are application-scoped so a workspace cannot redirect your
stored credential to a different host. Built-in exclusions for secrets,
credentials, SSH keys, dependencies and build output cannot be removed; user
patterns add to them.

The default allowlist is `npm run compile`, `npm run lint`, `npm test`,
`npm run test:unit` and `npm run verify`. Add project-specific commands to the
resource-scoped setting only if you would approve running that exact string.

## Commands

- **QuantsMind: Open Chat**
- **QuantsMind: New Chat**
- **QuantsMind: Explain Selection**
- **QuantsMind: Ask About Selection**
- **QuantsMind: Generate Code Suggestion**
- **QuantsMind: Attach Active File to Chat**
- **QuantsMind: Set API Key**
- **QuantsMind: Clear API Key**
- **QuantsMind: Configure Provider**
- **QuantsMind: Select Model**
- **QuantsMind: Show Log**
- **QuantsMind: Summarize Workspace**
- **QuantsMind: Attach Relevant Workspace Files**
- **QuantsMind: Start Agent Session**
- **QuantsMind: Show Change History**

The internal **QuantsMind: Show Menu** command backs the status bar item and is
hidden from the Command Palette.

## Security model

- **Explicit sending.** Nothing leaves VS Code until you attach content and
  press **Send** or start an agent session.
- **Explicit context.** Only the selection, active file, user-picked files, or
  locally retrieved workspace files are candidates.
- **Approval before writes.** Plans, change sets, repairs and commands are
  approved independently. Approval ids are validated against the pending
  request and are single-use.
- **No ambient tool authority.** The model cannot call a tool, write a file or
  run a command. It returns structured JSON that local parsers gate.
- **Credential isolation.** Keys live in SecretStorage. There is no API-key
  setting. Logs pass every line through redaction.
- **Redaction.** Exact stored credentials, masked credential forms, JWTs,
  bearer tokens, and URL userinfo are replaced before context is sent. Error
  bodies, command output and logs are redacted too.
- **Endpoint validation.** HTTPS is required for remote endpoints. Loopback HTTP
  is allowed out of the box so local runtimes such as Ollama and LM Studio work
  without configuration; set `quantsmind.provider.allowInsecureLocalhost` to
  `false` to require HTTPS everywhere. Plain HTTP to a remote host is always
  rejected. URLs with embedded credentials, query strings or fragments are
  rejected.
- **Contained writes.** Change paths must be relative, symlink-free, and inside
  the workspace. Windows drive-relative paths, alternate data streams, `..`
  traversal and UNC paths are rejected.
- **Controlled execution.** Only exact allowlisted commands run, without a
  shell, with a sanitized environment, output caps, timeouts and cancellation.
- **Webview lockdown.** Strict CSP, nonce-based scripts, no remote assets, and
  no inline executable scripts.
- **Restricted Mode.** Agent sessions, file writes, repairs and validation
  commands require workspace trust. Chat and context retrieval stay available,
  which means attached or retrieved file content can still be sent to your
  provider in an untrusted workspace — trust controls what the extension may
  *do*, not what you may ask it to *read*.
- **No telemetry.** The extension sends nothing to us. The only outbound
  request is the one to the provider endpoint you configure.

See [SECURITY.md](SECURITY.md) and
[docs/architecture/V030_SECURITY_MODEL.md](docs/architecture/V030_SECURITY_MODEL.md)
for the full threat model, and
[docs/TERMINAL_SECURITY.md](docs/TERMINAL_SECURITY.md) for command execution
constraints.

## Getting help

QuantsMind collects no telemetry, so diagnosing a report needs the two things only
you can see. Start with the built-in diagnostics:

1. `Ctrl+Shift+P` → **QuantsMind: Run Complete Self-Diagnostics**. It writes a
   sanitized Markdown report — versions, workspace trust state, provider readiness,
   index counts — to
   `<extension globalStorage>/diagnostics/self-diagnostics-<timestamp>.md` and shows
   you that path. It never contains prompt text, file content or keys.
2. Open the **QuantsMind AI Coder** Output channel and copy the lines around the
   failure. Those lines carry identifiers, counts and sizes by design.
3. Note the extension version and your VS Code version (both are in the report).

Then open an issue with the report attached:
<https://github.com/ajit-ai/QuantsMind-VSCode-AI-Coder/issues>. Do not paste your API
key "to help debug" — a `sk-…` value in an issue is a live credential, and the logs
are built so that you never need to.

Behaviour that is expected but looks wrong at first glance — for example pre-0.3.4
conversations reporting `capturedContext=0` or `legacy` attachment chips after an
upgrade — is listed in [docs/LIMITATIONS.md](docs/LIMITATIONS.md) and
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Documentation

- [Agent workflow](docs/AGENT_WORKFLOW.md)
- [Project intelligence](docs/PROJECT_INTELLIGENCE.md)
- [Planning and tasks](docs/PLANNING_AND_TASKS.md)
- [Change review](docs/CHANGE_REVIEW.md)
- [Command execution](docs/COMMAND_EXECUTION.md)
- [Approvals and security](docs/APPROVAL_AND_SECURITY.md)
- [Debugging and repair](docs/DEBUGGING_AND_REPAIR.md)
- [Sessions and resume](docs/SESSIONS_AND_RESUME.md)
- [Provider configuration](docs/PROVIDER_CONFIGURATION.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Architecture overview](docs/ARCHITECTURE.md)
- [v0.3.0 system architecture](docs/architecture/V030_SYSTEM_ARCHITECTURE.md)
- [Execution state machine](docs/architecture/V030_EXECUTION_STATE_MACHINE.md)
- [Security model](docs/architecture/V030_SECURITY_MODEL.md)
- [Data model](docs/architecture/V030_DATA_MODEL.md)
- [Provider and tool contracts](docs/architecture/V030_PROVIDER_AND_TOOL_CONTRACTS.md)
- [Feature completion matrix](docs/FEATURES.md)
- [Providers](docs/PROVIDERS.md)
- [Workspace intelligence](docs/WORKSPACE.md)
- [Editing and approval workflow](docs/EDITING.md)
- [Terminal and command security](docs/TERMINAL_SECURITY.md)
- [Limitations](docs/LIMITATIONS.md)
- [Upgrading from 0.2.0](docs/UPGRADE.md)
- [Development guide](docs/DEVELOPMENT.md)
- [Testing guide](docs/TESTING.md)
- [Live provider validation](docs/LIVE_PROVIDER_VALIDATION.md)
- [v0.3.0 implementation report](docs/reports/V030_IMPLEMENTATION_REPORT.md)
- [v0.3.0 completion report](docs/reports/V030_COMPLETION_REPORT.md)
- [v0.3.0 test and validation report](docs/reports/V030_TEST_AND_VALIDATION_REPORT.md)
- [v0.3.0 security report](docs/reports/V030_SECURITY_REPORT.md)
- [v0.3.4 final qualification status](docs/reports/V0.3.4_FINAL_QUALIFICATION_STATUS.md)
- [GA security and trust audit](docs/reports/V0.4.0_GA_PHASE5_SECURITY_TRUST_AUDIT.md)
- [Release-candidate validation protocol](docs/RC_VALIDATION_PROTOCOL.md)
- [Path to General Availability](docs/ROADMAP_GA.md)
- [Contributing](CONTRIBUTING.md)

## Development

```bash
npm ci
npm run compile
npm run lint
npm run verify:deps
npm run test:unit
npm run test:integration
npm run package
npm run verify:vsix
```

The integration suite launches an isolated VS Code instance and uses a local
OpenAI-compatible mock server. No external credential is required for the test
suite. A real provider request requires your own valid API key and endpoint; the
repository never contains one.

## Packaging and release status

`npm run package` produces `quantsmind-vscode-ai-coder-<version>.vsix`, named from
`package.json`, locally. `npm run verify:vsix` validates the archive contents.
`npm run verify:release` fails if any script, source file or test pins the release
version to a literal. `npm run test:packaged`
installs the VSIX into an isolated VS Code instance and verifies activation and
basic interaction. `npm run verify` runs the full release-candidate pipeline,
including the dependency guard, lint, tests, archive inspection, packaged-host
tests and clean-install verification. `npm run release -- --bump patch|minor|major`
performs the manifest and lockfile bump and prints the commit, tag and checksum
steps; it never commits, tags, pushes or publishes on its own.

This baseline is **not published** to the Visual Studio Marketplace, Open VSX,
or any other registry. Do not treat it as a GA release.

## Independence

The source tree is a single npm package. There are no Git submodules, no
monorepo tooling, no Python runtime, no third-party QuantsMind SDK, and no
dependency on another QuantsMind project. All runtime code is TypeScript compiled
to CommonJS for the VS Code extension host.

## License

MIT. See [LICENSE](LICENSE).
