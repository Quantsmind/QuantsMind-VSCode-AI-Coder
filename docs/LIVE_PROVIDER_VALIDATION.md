# Live provider validation

This procedure is the manual release-candidate gate that automated tests cannot
replace. Automated suites use a loopback mock server; they do not prove that a
real provider accepts the request shape, streams deltas, or honours
cancellation.

Never request, print, paste, log, commit, or screenshot an actual credential.
Use a disposable key with the smallest scope the provider offers, and revoke it
afterward.

## Preconditions

- A scratch workspace that is not the product repository.
- A disposable API key for an OpenAI-compatible provider.
- The provider base URL and model identifier.
- VS Code 1.95.0 or newer.
- A locally built VSIX and its SHA-256, recorded for the evidence log.

## Procedure

1. Build and install the candidate.

   ```bash
   npm ci
   npm run verify
   code --install-extension quantsmind-vscode-ai-coder-0.1.0.vsix --force
   ```

   Record the VSIX size and SHA-256, the VS Code version, and the operating
   system.

2. Confirm the credential is absent before starting. Open
   **Preferences: Open User Settings (JSON)** and the workspace settings file.
   Search both for `quantsmind` and confirm there is no API-key entry.

3. Run **QuantsMind: Set API Key** from the Command Palette. Confirm the input
   is masked. Paste the disposable key only into that input. Do not paste it
   into chat, the Output panel, a terminal, or this document.

4. Run **QuantsMind: Configure Provider** and set the base URL and model.
   Remote endpoints must use HTTPS. For a local model server, use a loopback
   URL and leave `quantsmind.provider.allowInsecureLocalhost` enabled. Keep
   `quantsmind.provider.stream` enabled.

5. Open the QuantsMind view. Confirm the status bar and chat header report the
   provider as ready.

6. Send a minimal prompt: `Reply with exactly: READY`. Verify that:
   - The response arrives as a streaming message rather than a single blocking
     result.
   - The final text is coherent and the request completes without an error.
   - The Output channel contains lifecycle metadata but no credential.

7. Send a follow-up: `What did you just reply?`. Verify the assistant recalls
   the previous turn, proving conversation history is sent.

8. Verify cancellation. Send a prompt that requests a long response, for
   example: `Count from 1 to 500, one number per line.` Click **Stop** while
   deltas are arriving. Verify that:
   - Streaming stops promptly.
   - Any partial text already rendered remains visible.
   - No late deltas appear after cancellation.
   - The UI is no longer busy and a new request can start.

9. Verify credential storage. Open the user settings JSON again and confirm no
   key was written. Inspect the QuantsMind Output channel text for the key's
   first and last few characters; it must not appear. Do not copy the full key
   anywhere.

10. Verify workspace immutability. In the scratch workspace, run
    `git status --porcelain` before and after the session. Nothing must change.
    Also confirm no files were created, edited, or deleted by QuantsMind.

11. Verify cleanup. Run **QuantsMind: Clear API Key**, confirm the warning, and
    verify the next send reports that a key is required. Revoke the disposable
    key at the provider. Remove the scratch workspace if it is no longer needed.

## Evidence to record

Record only non-sensitive facts:

- Date and operator.
- OS and VS Code version.
- Extension version, VSIX size, and SHA-256.
- Provider family and model identifier.
- Pass or fail for: ready state, streaming, multi-turn history, cancellation,
  partial-response retention, credential absence from settings and logs,
  workspace immutability, and cleanup.
- Screenshots or log excerpts with all credentials and account identifiers
  redacted.

## Pass criteria

The live gate passes only if every step above succeeds. If any check fails,
record the failing step and stop; do not publish the candidate. A live test is
never inferred from the automated mock-server suites.

## Current status

**Pending user execution.** No credential was available during the hardening
campaign. This gate remains open until a disposable key is used and the
evidence above is recorded.
