# QuantsMind AI Coder

A standalone Visual Studio Code extension that turns your AI provider into a
workspace-aware coding assistant with **explicit context control and
approval-first file changes**. Version **0.2.0** is an **alpha preview**: it is
not a Marketplace release and is not general availability.

This product is completely independent. It does not depend on QuantsMind-Agent,
another QuantsMind repository, a shared source folder, a common SDK, a shared
runtime, or an external project workspace.

## What works in v0.2.0

### Conversations and answers

- Sidebar chat view in the Activity Bar with markdown and fenced code rendering,
  per-code-block **Copy**, and inline file references.
- OpenAI-compatible chat completions over HTTPS, with streaming or
  non-streaming responses.
- Opt-in plain HTTP for loopback endpoints such as a local model server.
- Streaming responses rendered incrementally with a Stop control and a total
  request timeout.
- Ask, explain, and generate modes with a read-only system prompt.
- Conversations persisted across window reloads: create, switch, rename by
  first message, and delete, bounded to 30 conversations and 120,000 characters
  per conversation.
- Ask, explain, generate, attach selection, attach active file, or pick files
  explicitly.
- Clear normalized errors with actionable hints, including a masked-key
  explanation instead of echoing a redacted credential.

### Workspace intelligence

- Local workspace index with technology detection, entry points, top-level
  structure, and test-file awareness.
- **Summarize Workspace** produces a reviewable summary without sending
  anything.
- **Attach Relevant Workspace Files** ranks local files against your task
  description and attaches them for review before you press Send.
- `.gitignore` plus built-in secret, dependency, build-output, binary, and
  large-file exclusions.
- Configurable indexed-file, retrieved-file, character, and attachment limits.

### Approval-first changes

- **Start Agent Task** asks the provider for a structured multi-file plan
  (create, modify, delete, rename) with per-file review diffs.
- Nothing is written until you approve. You can approve a subset, reject all,
  or cancel.
- SHA-256 baseline hashes detect files that changed after the plan was created.
- Writes are contained to the workspace, and every applied file is backed up.
- **Undo** restores backups and refuses to overwrite files edited after apply.
- **Show Change History** lists recent change sets and can restore them.

### Validation and repair

- Run an approved validation command (for example `npm run test:unit`) against
  the applied changes. Commands are displayed exactly before they run.
- Commands must match the allowlist, contain no shell metacharacters, and run
  without a shell inside the workspace root.
- Output, exit code, timeout, cancellation, and redaction are captured.
- A failed validation can trigger one bounded repair plan; the repair is again
  subject to review and approval.

### Security

- API keys stored in VS Code SecretStorage, never in settings or logs.
- Masked-key redaction: both the exact stored credential and recognizable
  masked forms (`sk-…abcd`) are scrubbed from prompts, error bodies, and logs.
- Authorization headers, URL userinfo, JWTs, and common token formats are
  sanitized.
- Built-in secret/dependency exclusions plus configurable context limits.
- Strict webview content security policy with no remote resources.

## What it deliberately does not do

- It does not modify workspace files without explicit per-task approval.
- It does not run arbitrary shell commands; only allowlisted validation
  commands can run, and only after you press the run control.
- It does not approve or apply its own plans.
- It does not scan or upload your workspace automatically. The index is local.
- It does not include a backend service, database, or telemetry.
- It does not support tool calls, image inputs, or multimodal content.
- It does not publish, tag, or deploy anything.

## Requirements

- VS Code **1.95.0** or newer (desktop).
- An OpenAI-compatible provider endpoint and API key, or a local model server
  that exposes the same API shape.
- Node.js **20 or newer** only if you are building or testing from source.

## Install from a VSIX

```bash
code --install-extension quantsmind-vscode-ai-coder-0.2.0.vsix
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
| `quantsmind.workspace.maxIndexedFiles` | `5000` | resource | Local index size cap |
| `quantsmind.workspace.maxRetrievedFiles` | `8` | resource | Files attached per retrieval |
| `quantsmind.workspace.retrievalMaxChars` | `40000` | resource | Retrieved-context budget |
| `quantsmind.agent.maxSteps` | `6` | resource | Provider calls per agent task |
| `quantsmind.agent.maxRepairIterations` | `1` | resource | Repair passes after failure |
| `quantsmind.agent.timeoutMs` | `180000` | resource | Agent task step timeout |
| `quantsmind.commands.allowlist` | five npm commands | resource | Approved validation commands |
| `quantsmind.commands.timeoutMs` | `120000` | resource | Validation command timeout |
| `quantsmind.commands.maxOutputChars` | `120000` | resource | Captured output cap |

Provider settings are application-scoped so a workspace cannot redirect your
stored credential to a different host. Built-in exclusions for secrets,
credentials, SSH keys, dependencies, and build output cannot be removed; user
patterns add to them.

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
- **QuantsMind: Start Agent Task (Plan Changes)**
- **QuantsMind: Show Change History**

The internal **QuantsMind: Show Menu** command backs the status bar item and is
hidden from the Command Palette.

## How a change is applied

1. Run **Start Agent Task** and describe the change.
2. The extension selects relevant local files and asks the provider for a JSON
   change plan.
3. Review the summary, per-file warnings, and unified diffs in the chat view.
4. Approve selected files or reject the plan. Nothing has been written yet.
5. Approved files are written with workspace containment and per-file backups.
6. Optionally run an allowlisted validation command.
7. If validation fails, request a bounded repair plan and review it again.
8. Undo restores backups; conflicting files are reported and left untouched.

## Security model

- **Explicit sending.** Nothing leaves VS Code until you attach content and
  press **Send** or start an agent task.
- **Explicit context.** Only the selection, active file, user-picked files, or
  locally retrieved workspace files are candidates.
- **Approval before writes.** Plans are never applied automatically. Approval is
  per file and per task.
- **Credential isolation.** Keys live in SecretStorage. There is no API-key
  setting. Logs pass every line through redaction.
- **Redaction.** Exact stored credentials, masked credential forms, JWTs,
  bearer tokens, and URL userinfo are replaced before context is sent. Error
  bodies and logs are redacted too.
- **Endpoint validation.** HTTPS is required remotely; loopback HTTP is opt-in.
  URLs with embedded credentials, query strings, or fragments are rejected.
- **Contained writes.** Change paths must be relative, symlink-free, and inside
  the workspace. Windows drive-relative paths, alternate data streams, `..`
  traversal, and UNC paths are rejected.
- **Controlled execution.** Only allowlisted commands run, without a shell,
  with a sanitized environment, output caps, timeouts, and cancellation.
- **Webview lockdown.** Strict CSP, nonce-based scripts, no remote assets, and
  no inline executable scripts.

See [SECURITY.md](SECURITY.md) for reporting and the full threat model, and
[docs/TERMINAL_SECURITY.md](docs/TERMINAL_SECURITY.md) for command execution
constraints.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Feature completion matrix](docs/FEATURES.md)
- [Providers](docs/PROVIDERS.md)
- [Workspace intelligence](docs/WORKSPACE.md)
- [Editing and approval workflow](docs/EDITING.md)
- [Terminal and command security](docs/TERMINAL_SECURITY.md)
- [Limitations](docs/LIMITATIONS.md)
- [Upgrading from 0.1.x](docs/UPGRADE.md)
- [Development guide](docs/DEVELOPMENT.md)
- [Testing guide](docs/TESTING.md)
- [Live provider validation](docs/LIVE_PROVIDER_VALIDATION.md)
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

`npm run package` produces `quantsmind-vscode-ai-coder-0.2.0.vsix` locally.
`npm run verify:vsix` validates the archive contents. `npm run test:packaged`
installs the VSIX into an isolated VS Code instance and verifies activation and
basic interaction. `npm run verify` runs the full release-candidate pipeline,
including the dependency guard, lint, tests, archive inspection, packaged-host
tests, and clean-install verification.

This baseline is **not published** to the Visual Studio Marketplace, Open VSX,
or any other registry. Do not treat it as a GA release.

## Independence

The source tree is a single npm package. There are no Git submodules, no
monorepo tooling, no Python runtime, no third-party QuantsMind SDK, and no
dependency on another QuantsMind project. All runtime code is TypeScript compiled
to CommonJS for the VS Code extension host.

## License

MIT. See [LICENSE](LICENSE).
