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
   code --install-extension quantsmind-vscode-ai-coder-3.0.0.vsix --force
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

10. Verify default workspace immutability. In the scratch workspace, run
    `git status --porcelain` before and after a chat session. Nothing must change
    during chat: no files are created, edited, or deleted by the chat path.

11. Verify the plan-first workflow on a disposable file:
    - Run **QuantsMind: Start Agent Session** and ask for a small new file.
    - Confirm the session reaches plan approval and `git status` is still
      clean.
    - Approve the plan and confirm the task proceeds to per-file change review.
    - Confirm `git status` is still clean before you approve any file.
    - Approve the file and confirm it is written.
    - Run **Undo applied changes** and confirm the file is removed and the
      workspace returns to its previous state.
    - Confirm **Show Change History** lists the change set.

12. Verify the workspace summary and retrieval:
    - Run **QuantsMind: Summarize Workspace** and confirm the file count,
      detected scripts, and exclusions are plausible.
    - Run **QuantsMind: Attach Relevant Workspace Files** and confirm attachments
      are shown for review before any request.
    - Confirm `.env` and credential files are never listed or attached.

13. Verify validation and repair:
    - Approve a change that intentionally fails an allowlisted test command, or
      use a scratch project.
    - Confirm the command is displayed verbatim, runs only after you trigger it,
      and reports the exit code and bounded output.
    - Confirm a failing validation transitions to diagnosing, not completed, and
      offers a repair.
    - Approve a repair proposal only on a disposable file, then confirm that
      validation must be run again and the previous result is not reused.

14. Verify session lifecycle:
    - Pause a session in a resumable state and confirm the stage list shows it
      paused.
    - Reload the window, restore the session, and confirm the extension reports
      `needsReview` when it cannot verify applied files.
    - Confirm a session from another workspace root is not restored.
    - Cancel a running provider request and confirm pending work is skipped.
    - Delete the session and confirm it is gone after reload.

15. Verify cleanup. Run **QuantsMind: Clear API Key**, confirm the warning, and
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

### v3.0.0

The live gate has **not** been run for v3.0.0. No live provider request was made
while preparing this build, and no credential was requested, used, or exposed.

Evidence that exists for v3.0.0:

- Automated unit, extension-host, and packaged-host suites use a deterministic
  loopback mock provider and do not demonstrate third-party provider behavior.
- The plan-first approval, per-file change approval, command policy, diagnostics,
  repair approval, session restore, and completion-report paths are covered by
  deterministic tests.
- The repository contains no credential and no live-provider transcript.
- The two Pollinations live integration tests remain pending unless the
  anonymous endpoint is reachable; CI runs extension-host tests on
  ubuntu/windows/macOS against the mock provider.

Still open for v3.0.0:

- The full procedure above on the installed 3.0.0 VSIX with a disposable key.
- A manual UI pass of the control center (this build's automated tests validate
  the webview HTML and protocol structurally, not visually).
- Third-party live streaming observation.
- Apple-host and Linux-host execution of this artifact (historical CI lineage
  is green on those platforms for the pre-remediation branch; see
  `docs/audit/V3.0.0-FINAL-COMPREHENSIVE-QUALIFICATION.md`).
- Provider-side revocation evidence for any disposable key.

The 0.2.0/v0.1.1 records below are preserved as historical evidence, not as
current qualification status.

The gate remains open until the current v3.0.0 live procedure above is executed
and the Output-channel inspection passes. Do not describe any disposable key as
revoked at the provider without evidence.

### v0.2.0 (historical, unpublished)

The live gate has **not** been re-run for v0.2.0. No live provider request was
made while preparing this build, and no credential was requested or exposed.

Evidence that exists for v0.2.0 (historical):

- The provider-masked key exposure found in the v0.1.1 Output channel is
  addressed in `src/security/redact.ts` and covered by
  `test/unit/redact.test.ts` and `test/unit/errors.test.ts`.
- Automated suites use a loopback mock server and do not demonstrate
  third-party provider behavior.
- The v0.2.0 approval, undo, workspace summary, retrieval, and command flows are
  covered by extension-host tests against a fixture workspace.

Still open for v0.2.0:

- A fresh live session on the installed 0.2.0 VSIX, including an Output-channel
  inspection after a provider error.
- Third-party live streaming observation.
- Ubuntu and macOS CI execution. The jobs are configured but have not been run.
- Provider-side revocation evidence for any disposable key.

### Historical v0.1.1 observations

The following records the v0.1.1 gate and is preserved unchanged in substance:

**Partially validated on 2026-11-03** with a disposable credential and an
OpenAI-compatible provider displaying `openai/gpt-4o-mini`.

Passed manually at that time:

- Successful provider response.
- Model identification.
- Conversation context recall (`QM-2026`).
- Text generation (numbers 1 through 30).
- Cancellation through **Stop**.
- API-key removal with the `API key removed` confirmation.
- Missing-key rejection with error code `authentication` and guidance to use
  **QuantsMind: Set API Key**.
- Credential-free user settings and unchanged scratch-workspace files, verified
  post-session.

Open at that time:

- Streaming: incremental delivery verified locally with a controlled loopback
  SSE test (deltas at 326 ms and 1,514 ms; completion at 1,822 ms). A
  third-party live streaming observation remained unrecorded.
- Output-channel credential scan: **failed**. The persisted Output log from the
  2026-11-03 session contained a provider-masked key fragment in a 401 provider
  message. No full key was present, and no fragment is reproduced here. This is
  the defect remediated in v0.2.0.
- Ubuntu and macOS CI: configured, not executed. Windows local verification
  passed separately (2026-11-03, exit code 0) and is not evidence for the Ubuntu
  or macOS jobs.
- Provider-side revocation of the disposable key: unconfirmed. Extension-side
  removal was confirmed.

This status combines a manual live gate, one controlled local streaming check,
and separate automated Windows results. The local check and automated results do
not demonstrate third-party provider behavior.

Evidence: [V011 live provider validation report](reports/V011_LIVE_PROVIDER_VALIDATION_REPORT.md)
and [V0.2.0 completion report](reports/V020_COMPLETION_REPORT.md).

The gate remains open until the current v3.0.0 live procedure above is executed
and the Output-channel inspection passes. Do not describe any disposable key as
revoked at the provider without evidence.
