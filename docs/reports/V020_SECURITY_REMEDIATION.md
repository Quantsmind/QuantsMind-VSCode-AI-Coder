# v0.2.0 Security Remediation Report

Date: 2026-11-03

Scope: the v0.2.0 campaign workstream A, plus the security-relevant behavior added
by workspace retrieval, change application, and command execution.

No real credential was requested, printed, logged, committed, or written to a
report, fixture, or diagnostic file during this work.

## 1. Provider-masked API-key redaction defect

### Defect

The v0.1.x redactor removed the exact stored credential and complete,
well-known key shapes. It did not remove **masked** forms that providers
commonly echo in error responses, for example:

- `sk-abc***wxyz`
- `sk-...1234`
- `Bearer sk-***`
- `api_key=sk-…abcd`
- `"secret": "sk-****"`

A provider error or log that contained only a masked fragment could therefore
reach the chat error card or the Output channel. The fragment is not a usable
credential, but it is still key material that should not be displayed.

### Fix

`src/security/redact.ts` now applies masked-form rules before the full-key
rules:

- Bearer tokens containing `**`, `…`, `...`, or `•`.
- `sk-` values containing mask characters, with up to 60 characters on each
  side.
- Assignment forms for `api_key`, `apikey`, `access_token`, `auth_token`,
  `client_secret`, `password`, `passwd`, `secret`, and `x-api-key`.
- JSON string forms of the same names.
- A generic `prefix**suffix` credential shape.

Exact configured credentials are still replaced first, so a stored key is
removed even if it does not match any well-known pattern.

### Verification

- `test/unit/redact.test.ts`: "redacts provider-masked key fragments" and
  "redacts masked credentials in headers, assignments and JSON".
- `test/unit/errors.test.ts`: "redacts provider-masked key fragments echoed in
  failure bodies" and "scrubs credentials from every constructed provider
  error".
- `test/unit/provider.test.ts` and `test/integration/chat.test.ts` continue to
  assert that a fixture key never appears in an outbound request, an error card,
  or an attachment preview.

The fixtures use obviously fake values such as `sk-demo-not-a-real-key` and
`this-is-a-fixture-not-a-real-secret`. They are not credentials.

## 2. Credential and sensitive-data protection

| Control | Implementation |
| --- | --- |
| Storage | VS Code SecretStorage only; no API-key setting |
| Input | Masked `showInputBox`, trimmed, length-validated |
| Logging | Every line passes through `redactSecrets` |
| Error bodies | Bounded, sanitized, redacted, truncated |
| Authorization headers | `Authorization:` values removed unless already a redacted bearer |
| URL credentials | `scheme://user:password@host` userinfo replaced |
| JWTs | Three-part `eyJ...` tokens replaced |
| Provider keys | OpenAI, GitHub, AWS, Slack, Google, and generic bearer shapes |
| Private keys | PEM blocks replaced |
| Persistence | No credential in conversation or change-history storage |
| Command output | Redacted before display |
| Provider settings | Application-scoped so a workspace cannot redirect a key |

The redactor is shared by context building, provider errors, logging, and
command output, so a rule only has to be added once.

## 3. Error sanitization and actionable messages

`src/providers/errors.ts` normalizes failures to stable codes
(`configuration`, `authentication`, `rate_limit`, `timeout`, `cancelled`,
`network`, `server`, `http`, `invalid_response`). Each code has a short,
actionable hint.

- Control characters are removed.
- Whitespace is collapsed.
- Messages are truncated to a fixed length.
- Provider-provided detail is redacted before it is appended.
- HTML error pages and oversized plain bodies are not surfaced.
- An authentication failure explains that a masked key is not a valid
  credential and points to **Set API Key**, without echoing the value.

The chat error card offers **Set API key**, **Open provider settings**, and
**Show log** actions where relevant.

## 4. Change-application security

- Provider plans are untrusted input and are parsed strictly.
- Paths are rejected if they are absolute, drive-qualified, drive-relative
  (`C:file`), alternate data streams (`file:stream`), UNC, contain control
  characters, exceed 500 characters, or traverse with `..`.
- Paths excluded by built-in or user security rules cannot be changed.
- `WorkspaceChangeFs` re-checks containment with a workspace-relative path
  comparison before any read, write, delete, or move.
- Baseline SHA-256 hashes prevent applying over a file that changed after
  review.
- Backups are written before mutation and stored outside the workspace.
- Undo refuses to overwrite files edited after apply.

`test/unit/changeModel.test.ts`, `test/unit/changeApply.test.ts`, and
`test/unit/changeHistory.test.ts` cover these rules, including the Windows
drive-relative and alternate-data-stream regressions.

## 5. Command-execution security

- Exact allowlist membership required.
- Bare executable name required; path-qualified executables rejected.
- Shell metacharacters and control characters rejected.
- `spawn` with `shell: false`.
- Environment rebuilt from a fixed allowlist.
- Working directory must be inside the workspace root.
- Output capped and redacted.
- Timeout and cancellation terminate the process.

`test/unit/commandRunner.test.ts` covers allowlist rejection, metacharacters,
path-qualified executables, containment, environment isolation, output caps,
redaction, timeout, and cancellation.

## 6. Dependency advisory status

- Runtime dependency: `minimatch` 11.0.4.
- GHSA-g3hv-75wg-m249 affects releases below 11.0.1; the shipped version is
  patched.
- Nested 9.0.9 and 10.2.6 copies are development-only and are not included in
  the VSIX.
- `npm run verify:deps` enforces the floor and the dev-only status offline.
- `scripts/verify-vsix.mjs` verifies the packaged minimatch version and that no
  dev dependency is shipped.

Development-only advisories in the build/test toolchain are documented in
[SECURITY.md](../../SECURITY.md) and are outside the shipped runtime.

## 7. Residual risk

- A compromised provider, proxy, or local model server is outside the trust
  boundary.
- A user who approves a plan without reading it can apply an unwanted change.
- Allowlisted commands are trusted project tooling and are not sandboxed.
- Redaction is pattern-based. An arbitrary secret shape that matches no rule and
  is not the configured credential can still appear in model output; it is not
  sent by the extension unless it is present in attached content.
- No live Provider request was performed for this report, so provider-side
  behavior was not re-observed. Automated coverage uses a loopback mock server.
