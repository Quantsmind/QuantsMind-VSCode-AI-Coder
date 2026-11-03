# Development guide

## Prerequisites

| Tool | Version |
| --- | --- |
| Node.js | 20, 22, or 24 |
| npm | 10 or newer |
| VS Code | 1.95.0 or newer for manual testing |
| OS | Windows, macOS, or Linux |

The project does not require Python, Docker, a database, a QuantsMind account, or
network access to a QuantsMind service.

## First build

```bash
npm ci
npm run compile
npm run lint
npm run test:unit
```

`npm ci` installs exact versions from `package-lock.json`. Do not switch to
`npm install` in CI.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run clean` | Remove `out`, `dist`, `coverage`, `.tmp`, `.vscode-test` |
| `npm run compile` | Type-check and emit CommonJS to `out` |
| `npm run watch` | Incremental TypeScript build |
| `npm run lint` | ESLint 10 flat config |
| `npm run test:unit` | Compile and run Mocha TDD unit tests in plain Node |
| `npm run test:integration` | Compile and run tests in an isolated VS Code 1.95 instance |
| `npm test` | Unit tests, then integration tests |
| `npm run verify:deps` | Fail if the shipped minimatch is below the patched release |
| `npm run package` | Produce the VSIX with `@vscode/vsce` |
| `npm run verify:vsix` | Inspect the VSIX archive and manifest |
| `npm run test:packaged` | Install the VSIX into an isolated VS Code and verify activation |
| `npm run verify:install` | Install the VSIX with the VS Code CLI into a temporary extensions directory |
| `npm run verify` | Lint, dependency guard, all tests, package, VSIX inspection, packaged tests, install |

## Project layout

```text
src/
  extension.ts                 activation, commands, status bar
  api.ts                       narrow exported API
  agent/                       staged agent task runner
  changes/                     change model, diffs, review, apply, undo, history
  chat/                        webview provider, HTML, protocol, prompts, session, persistence
  commands/                    command identifiers and approved command runner
  config/                      defaults, resolution, VS Code settings adapter
  context/                     explicit file access and filtering
  providers/                   provider contract, registry, OpenAI-compatible adapter
  security/                    credentials, SecretStorage, redaction, logging
  workspace/                   local index, analysis, ignore matching
  utils.ts                     small shared helpers
media/                         webview CSS, script, and icon
test/unit/                     plain Node tests, mock HTTP server, in-memory change fs
test/integration/              extension-host tests
test/packaged/                 packaged-VSIX activation test
test/packaged-extension/       minimal harness extension manifest for packaged tests
test/fixtures/workspace/       integration workspace with dummy secrets
test/fixtures/                 deterministic command-output helpers
scripts/                       clean, dependency guard, VSIX verification, install verification
docs/                          architecture, guides, and release reports
```

## Running the extension manually

1. Run `npm run compile`.
2. Open the project in VS Code.
3. Press F5 to launch an Extension Development Host.
4. Open the QuantsMind icon in the Activity Bar.
5. Run **QuantsMind: Set API Key** with a disposable key.
6. Set `quantsmind.provider.baseUrl` to a provider you control.
7. Attach a selection or file, ask a question, and press Send.
8. To exercise the change workflow, run **QuantsMind: Start Agent Task**, review
   the diffs, and approve a file you are willing to modify. Undo restores it.
9. To exercise validation, run an allowlisted command from the task panel.

The extension has no automatic activation of a webview request and no automatic
file write. Sending and applying are always manual.

## Integration tests

`npm run test:integration` uses `@vscode/test-cli`. The first run downloads
VS Code 1.95.0 into `.vscode-test` (roughly 140 MB). It then launches an isolated
instance with:

- The fixture workspace at `test/fixtures/workspace`.
- Workspace trust disabled for the test window.
- A scrubbed extensions directory.
- Test files compiled to `out/test/integration`.

The chat tests start a local `node:http` OpenAI-compatible mock server on a
loopback port. The extension is configured to use that endpoint, so no external
credential or internet API call is involved.

Override the host version when needed:

```bash
VSCODE_TEST_VERSION=1.96.0 npm run test:integration
```

Use a local VS Code installation:

```bash
VSCODE_INSTALLATION="C:\Program Files\Microsoft VS Code" npm run test:integration
```

On Linux CI, run under a virtual display:

```bash
xvfb-run -a npm run test:integration
```

## Packaged verification

```bash
npm run package
npm run verify:vsix
npm run test:packaged
npm run verify:install
```

`test:packaged` uses `.vscode-test.packaged.mjs`. That config loads a minimal
harness extension from `test/packaged-extension`, installs the produced VSIX
with `installExtensions`, and runs `out/test/packaged` tests. The tests prove
that the installed copy (not the development source directory) activates, its
commands are available, and its public API reports status.

`verify:install` locates a downloaded VS Code executable, uses a temporary
extensions and user-data directory, runs `--install-extension`, and checks
`--list-extensions --show-versions`. It skips with a clear message if no
executable is available, so set `VSCODE_EXECUTABLE` in that case.

## Packaging

```bash
npm run package
```

Output: `quantsmind-vscode-ai-coder-0.2.0.vsix`.

`.vscodeignore` excludes source, tests, docs, scripts, CI, source maps, and
TypeScript declarations. `vsce` includes the compiled `out/src` tree, `media`,
the manifest, README, LICENSE, and CHANGELOG.

## Security checks before a change

- `npm run verify:deps` must pass, and `npm audit --omit=dev` should report zero
  vulnerabilities.
- No credential value may appear in settings, tests, logs, or the VSIX.
- New context paths must go through `filters.ts`.
- New webview messages must go through `protocol.ts`.
- New network behavior must go through the provider abstraction.
- New settings that affect credentials must remain application-scoped.
- New file writes must go through `ChangeFs` and require explicit approval.
- New commands must require exact allowlist membership, and must not use a shell.
- Do not add a path that writes files or runs commands without user approval and
  containment checks.

## Troubleshooting

### The integration test cannot download VS Code

Check network access to `update.code.visualstudio.com`, or set
`VSCODE_INSTALLATION` to a local installation. The `restricted` environment in
some corporate networks blocks the download.

### The extension host is reported as unresponsive at startup

The test host may report a transient unresponsive window while VS Code loads.
The suite waits for completion; treat only test failures as failures.

### No active editor in integration tests

Open a fixture with `vscode.window.showTextDocument` before asserting selection
behavior. Test order is serial, so a previous test's editor is usually still
active, but tests should not depend on that.

### A real provider request fails with 401

The test suite uses a mock server and dummy credentials. Manual provider testing
needs a real key set through **QuantsMind: Set API Key** and a matching endpoint.
Never commit that key.
