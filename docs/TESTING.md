# Testing guide

## Test layers

| Layer | Runner | Location | What it proves |
| --- | --- | --- | --- |
| Unit | Mocha TDD in plain Node | `test/unit` | Pure logic, provider HTTP behavior, security filters |
| Extension host | `@vscode/test-cli` | `test/integration` | Activation, commands, credentials, VS Code context access, full chat flow |
| Packaged | `@vscode/test-cli` with a VSIX | `test/packaged` | The installed archive activates and exposes commands |
| Install | VS Code CLI | `scripts/verify-install.mjs` | A clean extensions directory accepts the VSIX |

Run everything:

```bash
npm run lint
npm run test:unit
npm run test:integration
npm run package
npm run verify:vsix
npm run test:packaged
npm run verify:install
```

`npm run verify` runs every layer above: lint, unit and extension-host tests,
VSIX packaging, archive inspection, packaged-host tests, and clean-install
verification.

## Requirement coverage

### Extension activation and commands

- `test/integration/extension.test.ts`
- Activation API shape, all contributed command IDs, manifest view container,
  startup activation, capabilities, configuration scopes, and command execution.

### Provider configuration and request construction

- `test/unit/provider.test.ts`
- Endpoint acceptance and rejection, model/timeout/temperature/token validation,
  body construction, headers, JSON and SSE responses, content arrays, refusals,
  response size handling, redirect rejection, and provider registry behavior.
- `test/unit/endpoint.test.ts`
- HTTPS rules, loopback rules, embedded credentials, query/fragment rejection,
  URL normalization, and path appending.

### Credentials

- `test/unit/credential.test.ts`: credential validation and length limits.
- `test/unit/secretStore.test.ts`: SecretStorage wrapper behavior.
- `test/unit/logger.test.ts`: no credentials in log output.
- `test/integration/credentials.test.ts`: set-key command uses a masked input,
  stores the key, writes nothing to settings, honours cancellation, and requires
  confirmation to clear.

### API requests

- `test/unit/provider.test.ts` uses a local `node:http` mock server and asserts
  the method, path, authorization header, user agent, and JSON body.
- `test/unit/completionService.test.ts` asserts the service refuses remote
  requests without a credential, sends loopback requests without one, logs only
  metadata, and normalizes failures.
- `test/integration/chat.test.ts` asserts the full webview-to-provider request,
  including system prompt, user prompt, history, and attachment redaction.

### Error handling

- `test/unit/errors.test.ts` maps HTTP statuses, redacts provider messages,
  rejects HTML and oversized bodies, and normalizes abort/network errors.
- `test/unit/provider.test.ts` covers 401, 429, 5xx, invalid JSON, missing
  choices, missing text, malformed SSE, provider error payloads, and fetch
  failures.
- `test/integration/chat.test.ts` verifies the user-facing error card and that a
  credential in an upstream error message is redacted.

### Cancellation and timeout

- `test/unit/cancellation.test.ts`: pre-cancel, mid-flight cancel, timeout,
  cancellation precedence over timeout, listener cleanup, and invalid timeouts.
- `test/unit/provider.test.ts`: no request when pre-cancelled, in-flight abort,
  and request timeout.
- `test/integration/chat.test.ts`: the Stop control produces an
  `assistantCancelled` message.

### Context selection

- `test/unit/filters.test.ts`: path normalization, exclusions, duplicates,
  empty/binary/oversized rejection, file count, character budget, truncation,
  and redaction.
- `test/integration/context.test.ts`: editor selections with line numbers,
  active-file attachment, URI reads and failures, attachable file listing, and
  exclusion of `.env` and `secrets/`.
- `test/integration/chat.test.ts`: attachment is not sent until Send, only one
  request occurs after Send, and the workspace hash/list is unchanged.

### Secret redaction

- `test/unit/redact.test.ts`: exact credentials, OpenAI/GitHub/AWS/Slack/Google
  key shapes, private keys, bearer tokens, Basic authorization, assignments, and
  JSON secrets.
- `test/unit/filters.test.ts`: redaction integrated into context building.
- `test/unit/logger.test.ts`: redaction on every log line.
- `test/integration/chat.test.ts`: attached fixture key is absent from the
  outbound request body.

### Webview security

- `test/unit/webviewHtml.test.ts`: CSP, nonce script, no inline script, no
  remote resources, explicit-send messaging, and attribute escaping.
- `test/unit/protocol.test.ts`: strict message parsing and rejection of unknown
  or malformed messages.
- `test/integration/chat.test.ts`: rendered webview options and initial state.

### Settings

- `test/unit/resolve.test.ts`: defaults, wrong types, clamping, rounding,
  trimming, mandatory exclusions, merge behavior, pattern caps, and byte
  conversion.
- `test/integration/extension.test.ts`: manifest scopes and absence of a
  credential setting.

## Mock provider server

`test/unit/helpers.ts` starts a real `node:http` server on `127.0.0.1` with an
ephemeral port. It records each request and can:

- Return a JSON completion.
- Stream SSE events with a configurable chunk size.
- Return arbitrary status codes and bodies.
- Hold a response open to test cancellation and timeout.
- Redirect to prove redirects are rejected.

The integration chat suite reuses this helper. All provider traffic stays on
loopback.

## Test fixtures

`test/fixtures/workspace` is a tiny TypeScript workspace:

- `src/example.ts` contains a dummy `sk-demo-...` value used to prove redaction.
- `src/utils.ts` is a simple function.
- `.env` and `secrets/credentials.json` contain non-secret placeholders used to
  prove exclusion.
- `README.md` documents the fixture.

The dummy values are not credentials. No test connects to a real provider.

## What is not covered automatically

- A live request to a third-party AI provider. That requires a real credential
  and is intentionally excluded from CI. It must be performed manually with a
  disposable key when validating a release candidate.
- Marketplace publication, signing, or Open VSX installation.
- Operating-system-specific rendering inside the webview. The tests validate
  HTML, CSP, protocol, and message flow, not pixel appearance.
- Accessibility auditing beyond the labels and ARIA attributes in the markup.

## Reliability notes

- Unit tests run in under a second and have no external network dependency.
- Extension tests need a one-time VS Code download. Cache `.vscode-test` between
  local runs.
- The chat tests use deterministic loopback servers and explicit wait helpers
  rather than fixed sleeps.
- Test timeouts are 20 seconds for unit and 60 seconds for extension tests.
- CI runs lint and unit tests on Node 20, 22, and 24, then extension-host and
  packaged tests on Linux under `xvfb-run`.
