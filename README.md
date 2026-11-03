# QuantsMind AI Coder

A standalone Visual Studio Code extension for asking coding questions about code
you explicitly attach. Version **0.1.0** is an **alpha preview**: it is not a
Marketplace release and is not general availability.

This product is completely independent. It does not depend on QuantsMind-Agent,
another QuantsMind repository, a shared source folder, a common SDK, a shared
runtime, or an external project workspace.

## What works in v0.1.0

- Sidebar chat view in the Activity Bar.
- OpenAI-compatible chat completions over HTTPS.
- Opt-in plain HTTP for loopback endpoints such as a local model server.
- Streaming responses rendered incrementally.
- Stop control and a total request timeout.
- Attach the current selection, the active file, or files you pick explicitly.
- Ask, explain, and generate modes with a read-only system prompt.
- API keys stored in VS Code SecretStorage, never in settings or logs.
- Built-in secret/dependency exclusions plus configurable context limits.
- Secret detection and redaction before any attached content is sent.
- Clear normalized errors with actionable hints.

## What it deliberately does not do

- It does not modify, create, or delete workspace files.
- It does not run terminal commands or apply patches.
- It does not scan or upload your workspace automatically.
- It does not include a backend service, database, or telemetry.
- It does not support tool calls, image inputs, or multimodal content.
- It does not persist chat history across window reloads.

## Requirements

- VS Code **1.95.0** or newer (desktop).
- An OpenAI-compatible provider endpoint and API key, or a local model server
  that exposes the same API shape.
- Node.js **20 or newer** only if you are building or testing from source.

## Install from a VSIX

```bash
code --install-extension quantsmind-vscode-ai-coder-0.1.0.vsix
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

The status bar item opens a quick menu with the most common actions.

## Security model

- **Explicit sending.** Nothing leaves VS Code until you attach content and
  press **Send**. Attaching alone never makes a network request.
- **Explicit context.** Only the selection, active file, or user-picked files
  are candidates. There is no background workspace scan.
- **Credential isolation.** Keys live in SecretStorage. There is no API-key
  setting. Logs pass every line through redaction.
- **Redaction.** Exact stored credentials and recognizable secret patterns are
  replaced before context is sent. Error bodies and logs are redacted too.
- **Endpoint validation.** HTTPS is required remotely; loopback HTTP is opt-in.
  URLs with embedded credentials, query strings, or fragments are rejected.
- **No execution.** The extension has no file-write or command-execution path.
- **Webview lockdown.** Strict CSP, nonce-based scripts, no remote assets, and
  no inline executable scripts.

See [SECURITY.md](SECURITY.md) for reporting and the full threat model.

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

- [Architecture](docs/ARCHITECTURE.md)
- [Development guide](docs/DEVELOPMENT.md)
- [Testing guide](docs/TESTING.md)
- [Live provider validation](docs/LIVE_PROVIDER_VALIDATION.md)
- [Contributing](CONTRIBUTING.md)

The integration suite launches an isolated VS Code instance and uses a local
OpenAI-compatible mock server. No external credential is required for the test
suite. A real provider request requires your own valid API key and endpoint; the
repository never contains one.

## Packaging and release status

`npm run package` produces `quantsmind-vscode-ai-coder-0.1.0.vsix` locally.
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
