# v0.1.1 Live Provider Validation Report

Date: 2026-11-03
Product: QuantsMind AI Coder (`quantsmind.quantsmind-vscode-ai-coder`)
Validation type: Manual live provider, plus a controlled local streaming check
Status: Partially validated; incremental streaming verified locally;
Output-channel scan failed; CI, third-party streaming, and provider-side
revocation pending

## 1. Environment

| Item | Value |
| --- | --- |
| Operating system | Windows 10.0.26300 x64 |
| VS Code | 1.144.0 (x64) |
| Extension version | `0.1.0` |
| Extension identity | `quantsmind.quantsmind-vscode-ai-coder@0.1.0` |
| VSIX size | 155,203 bytes (151.57 KiB) |
| VSIX SHA-256 | `44896183956757ca28dee1e62ebb12d7ff40e629ef48f97baf85bc77d5441a7a` |
| Provider type | OpenAI-compatible third-party provider |
| Model observed in chat | `openai/gpt-4o-mini` |
| Credential | Disposable, entered only in the masked Set API Key input; not recorded |

No full API key was requested in chat or a terminal, printed, logged, or
committed. The persisted Output log did record a provider-masked key fragment
from a 401 response (item 11); the fragment is not reproduced here. Removal
through the extension is confirmed. Provider-side revocation of the disposable
key is **unconfirmed**: no revocation record or provider confirmation was
supplied.

## 2. Results

Items 1–7 and 9–10 are manual live-provider evidence. Item 8 is a controlled
local check. Items 12–13 are statuses, not test results.

| # | Check | Result | Observed evidence |
| --- | --- | --- | --- |
| 1 | Provider response | **Pass** | The configured provider returned a successful response. |
| 2 | Model identification | **Pass** | The chat displayed `openai/gpt-4o-mini`. |
| 3 | Conversation context retention | **Pass** | The model correctly recalled `QM-2026` from a previous message. |
| 4 | Text generation | **Pass** | The model generated the numbers 1 through 30. |
| 5 | Cancellation | **Pass** | Clicking **Stop** interrupted an ongoing response. |
| 6 | API-key removal | **Pass** | The extension displayed `API key removed`. |
| 7 | Missing-key rejection | **Pass** | A subsequent request returned `No API key is configured for this provider.` with error code `authentication` and guidance to use `QuantsMind: Set API Key`. |
| 8 | Streaming response | **Verified locally** | A controlled loopback SSE test through the shipped provider code delivered deltas at 326 ms and 1,514 ms and completed at 1,822 ms, so content arrived incrementally. Third-party live streaming was not independently observed. |
| 9 | Credential absent from user settings | **Pass** | Post-session inspection found only `quantsmind.provider.baseUrl` and `quantsmind.provider.model`; no key, password, or secret setting. No workspace settings file was created. |
| 10 | Workspace immutability | **Pass** | The pre-session SHA-256 baseline for `README.md` and `sample.ts` matched after the session; no files were added or removed and no `.vscode` directory was created. |
| 11 | Credential absent from Output channel | **Failed** | The persisted Output log from the live session (15 lines) contains one 401 provider error whose message includes a provider-masked key fragment. The full key was absent, and the fragment is not reproduced here. |
| 12 | Cross-platform CI execution | **Not executed** | Ubuntu, Windows, and macOS CI jobs are configured but have not run on GitHub. |
| 13 | Provider-side key revocation | **Unconfirmed** | Extension-side removal is confirmed (`API key removed`). Revocation at the provider was not evidenced or supplied. |

Manual checks 1–7, 9, and 10 passed. Item 11 failed. Items 8, 12, and 13 are
not recorded as passed; item 8 is verified only for local incremental delivery.

## 3. Evidence boundaries

- Items 1–7 are the manual results supplied for this report.
- Items 9–10 are read-only post-session checks performed while finalizing this
  evidence; they did not rerun the extension or modify the workspace.
- Item 8 was verified on 2026-11-03 by a controlled local test: delayed SSE
  events were served over loopback to the compiled shipped provider, and both
  deltas arrived before completion. No credential was used. The webview was not
  visually observed; existing extension-host tests assert that delta messages
  precede completion.
- Item 11 was inspected and failed. VS Code persisted this extension's Output
  channel for the live session; one 401 provider message contained a
  provider-masked key fragment. No full key was present, and no fragment is
  reproduced here. The redaction rules match full key shapes, so a masked form
  passes through.
- Item 12 is a CI status, not a manual live-provider result: the jobs are
  configured but have not run.
- Item 13 is unconfirmed. Extension-side removal is confirmed, but provider-side
  revocation was not evidenced.
- The model identifier is non-sensitive. No endpoint, account identifier, full
  key, or credential value is included; the provider-masked fragment is
  described but not reproduced.

## 4. Automated versus manual evidence

This report covers the manual live gate, one controlled local streaming check,
and separate automated evidence. The v0.1.0/v0.1.1 automated pipeline remains a
separate evidence set: 136 unit tests, 22 extension-host tests, 4 packaged-VSIX
tests, archive inspection, dependency guard, and clean install. Those suites use a loopback mock server and do not contact a
third-party provider.

Streaming was checked independently of the live session: a temporary local SSE
server sent `Hel`, held for 1,200 ms, sent `lo`, held 300 ms, then sent
`[DONE]`. The compiled provider invoked the delta callback at 326 ms and
1,514 ms and resolved at 1,822 ms. This demonstrates incremental forwarding
rather than end-of-response buffering for the shipped code path; it is not a
third-party live streaming observation.

Windows local verification passed on 2026-11-03 (Node 24.18.1, exit code 0):
lint, dependency guard, 136 unit tests, 22 extension-host tests, VSIX archive
inspection, 4 packaged-VSIX tests, and clean install. These are automated
results and do not demonstrate live provider behavior.

GitHub Actions is configured for Ubuntu, Windows, and macOS but remains
unexecuted because no remote repository is authorized. Ubuntu and macOS CI have
not run. No CI pass is claimed, and Windows local verification is not a
substitute for the CI matrix.

## 5. Remaining limitations

- Third-party live streaming was not independently observed. Incremental
  delivery through the shipped provider path was verified locally.
- The Output-channel credential scan failed: the persisted log contains a
  provider-masked key fragment from a 401 message. Full-key redaction does not
  cover the provider's masked form. Remediation and a re-scan are required.
- The same provider message is posted to the chat error path, so the masked
  fragment may also have been displayed in the error card; the UI was not
  observed in this check.
- Cross-platform CI has not executed. Windows local verification passed;
  Ubuntu and macOS remain unverified.
- Provider-side revocation of the disposable key is unconfirmed; only
  extension-side removal is confirmed.
- Validation covered one provider family and one model.
- Timeout, rate-limit, and provider-outage behavior were not exercised live;
  automated tests cover the normalized error paths.
- The extension remains an unpublished alpha preview with no tag, Marketplace
  release, Open VSX release, or GA claim.

## 6. Release gate

The live provider gate is **not complete**. Do not tag or publish until:

1. The Output-channel credential exposure is remediated and a re-scan passes,
2. The Ubuntu, Windows, and macOS CI matrix passes, and
3. A third-party live streaming observation is recorded under this procedure
   (incremental delivery is already verified locally).

Separately, confirm provider-side revocation of the disposable key before
publication. Extension-side removal is confirmed, but revocation is not
evidenced.

The executed manual checks confirm provider acceptance, model display,
multi-turn context, generation, cancellation, SecretStorage removal behavior,
missing-key rejection, credential-free settings, and workspace immutability.
