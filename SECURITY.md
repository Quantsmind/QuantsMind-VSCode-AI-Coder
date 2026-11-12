# Security policy

## Supported versions

| Version | Support |
| --- | --- |
| 3.0.x (3.0.0) | Current release line; security fixes are applied to the latest 3.0.x build |
| 2.x and older | Superseded; no further fixes |
| Other | Not supported |

Version 3.0.0 is the current build. It is a GA-qualified local candidate; it
has not been published to any registry.

## Reporting a vulnerability

Do not open a public issue containing credentials, customer data, or a working
exploit. Report vulnerabilities privately through the source host's private
security advisory feature once a repository is authorized and configured by the
maintainers.

If no private channel is available, contact the maintainers through a channel
they have published for your engagement. Never include a real API key. Use a
redacted reproduction or a disposable test credential.

Please include:

- Affected version and VS Code version.
- Impact and attack preconditions.
- Minimal reproduction steps.
- Whether workspace content or credentials could be exposed.

## Security design

### Credentials

- API keys are stored only in VS Code SecretStorage under a namespaced key.
- There is no API-key setting and no credential in workspace files.
- The key input is masked and validated before storage.
- Logs pass every line through secret redaction. Request logs contain metadata
  such as provider type, model, message count, character count, duration, and
  error code, never message bodies or credentials.
- Redaction removes the exact stored credential plus masked forms such as
  `sk-…abcd`, so a provider that echoes a masked key cannot leak key material
  into the UI, an error card, or a log line.
- Provider responses are scanned for authorization headers and URL userinfo
  before text is surfaced.
- Provider settings are application-scoped. A workspace cannot redirect the
  stored key to a workspace-defined endpoint.
- Credentials are never written to conversation storage or change history.

### Workspace content and index

- The workspace index is local. Building it sends nothing to the provider.
- Context is collected only after an explicit user action: attach selection,
  attach active file, pick files, summarize workspace, or start an agent task.
- Nothing is sent until the user presses **Send** or starts a task.
- Built-in exclusions always remove environment files, private keys, credential
  files, SSH/AWS/GnuPG material, dependencies, and build output. `.gitignore`
  and `.git/info/exclude` are honoured for indexing and retrieval. User patterns
  can add exclusions but cannot remove the built-in set.
- Attached content is size-limited, binary-checked, de-duplicated, and redacted
  before it is included in a request.

### File changes

- A provider plan is untrusted input. It is parsed strictly, path-normalized,
  and validated before review.
- No file is written until the user approves the specific change IDs. There is
  no automatic apply path.
- Change paths must be relative and must resolve inside the workspace. Absolute
  paths, drive letters, Windows drive-relative paths (`C:file`), alternate data
  streams (`file:stream`), UNC paths, control characters, and `..` traversal are
  rejected.
- The file adapter re-checks containment through the VS Code URI API.
- Baseline SHA-256 hashes detect files that changed after the plan was created.
- Every applied file is backed up under extension global storage before it is
  written. Undo restores backups in reverse order and refuses to overwrite files
  edited after apply.
- Built-in and user exclusions also apply to change paths, so a plan cannot
  modify `.env`, credentials, dependencies, or build output.

### Commands and terminal

- No command runs automatically.
- Only an exact allowlist entry may run. The executable must be a bare command
  name; path-qualified executables are rejected.
- Commands containing shell metacharacters, control characters, or excessive
  length are rejected.
- Execution uses `spawn` with `shell: false`, a sanitized environment, and the
  workspace root as the working directory. Commands cannot escape the
  workspace.
- Output is capped, redacted, and truncated. Timeouts and cancellation terminate
  the process.
- Commands are displayed exactly before the user runs them.

### Endpoints and transport

- Remote endpoints must use HTTPS.
- Plain HTTP is limited to loopback hosts and only when
  `quantsmind.provider.allowInsecureLocalhost` is enabled.
- URLs containing embedded credentials, query strings, or fragments are
  rejected.
- Redirects are not followed intentionally by the extension. The request is
  sent with `fetch` to the configured chat completions URL.
- The endpoint host is shown in the chat status and status bar so the user can
  see where requests go.

### Output and UI

- Provider error bodies are bounded, parsed, redacted, and truncated. HTML
  error pages and oversized plain bodies are not surfaced.
- The webview uses a strict content security policy with `default-src 'none'`,
  a nonce for the local script, and no remote resources.
- Attachment metadata, diffs, and model output are rendered with DOM text APIs
  or an escaped markdown-lite renderer. Model output cannot inject executable
  HTML.
- Plan summaries and per-file reasons are escaped before rendering.

### Data handling

- No telemetry, analytics, crash upload, update service, or backend is used.
- Conversations and change history are stored locally in VS Code extension
  storage, capped at 30 conversations and 50 change sets.
- Only the configured provider receives attached content, and only after Send
  or task start.

## Dependency security

The packaged extension has one runtime dependency, `minimatch`, pinned to 11.0.4,
which is at or above the patched 11.0.1 release for GHSA-g3hv-75wg-m249.
`npm run verify:deps` fails the build if the shipped version regresses or if an
older copy stops being development-only.

Development-only tooling can still report transitive advisories. Those packages
are not included in the VSIX and are not loaded by the extension at runtime.
They should still be upgraded as fixed releases become available.

## Out of scope

- A compromised provider, network proxy, or local model server.
- Malicious code that the user manually copies into an attachment.
- A user who approves a plan they did not read. Review is a required part of
  the threat model.
- Workspace trust escalation: the extension declares support for untrusted
  workspaces and never executes workspace code until the user chooses an
  allowlisted command.
- Third-party extensions modifying the VS Code process.
