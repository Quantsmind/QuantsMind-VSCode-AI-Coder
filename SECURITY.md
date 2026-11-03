# Security policy

## Supported versions

| Version | Support |
| --- | --- |
| 0.1.x | Alpha preview; security fixes are applied to the latest 0.1.x build |
| Other | Not supported |

Version 0.1.0 is not a general availability release.

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
- Provider settings are application-scoped. A workspace cannot redirect the
  stored key to a workspace-defined endpoint.

### Workspace content

- v0.1.0 never writes to workspace files and has no file-write code path.
- There is no terminal or command execution path.
- Context is collected only after an explicit user action: attach selection,
  attach active file, or pick files in a dialog.
- Built-in exclusions always remove environment files, private keys, credential
  files, SSH/AWS/GnuPG material, dependencies, and build output. User patterns
  can add exclusions but cannot remove the built-in set.
- Attached content is size-limited, binary-checked, de-duplicated, and redacted
  before it is included in a request.
- Nothing is sent until the user presses **Send**.

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
- Attachment metadata and model output are rendered with DOM text APIs or an
  escaped markdown-lite renderer. Model output cannot inject executable HTML.

### Data handling

- No telemetry, analytics, crash upload, update service, or backend is used.
- Chat history is in memory only and is lost when the chat is cleared or the
  extension host restarts.
- Only the configured provider receives attached content, and only after Send.

## Dependency security

The packaged extension has one runtime dependency, `minimatch`, pinned to a
version that is not affected by the glob-part amplification advisory. Production
dependency audit (`npm audit --omit=dev`) is clean at the time of this baseline.

Development-only tooling currently reports transitive advisories in ESLint,
Mocha, `@vscode/test-cli`, and `@vscode/vsce` dependency trees. Those packages
are not included in the VSIX and are not loaded by the extension at runtime.
They should still be upgraded as fixed releases become available.

## Out of scope for v0.1.0

- A compromised provider, network proxy, or local model server.
- Malicious code that the user manually copies into an attachment.
- Workspace trust escalation: the extension declares support for untrusted
  workspaces and never executes workspace code.
- Third-party extensions modifying the VS Code process.
