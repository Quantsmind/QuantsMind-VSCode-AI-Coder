# v0.3.1 Provider Reliability Report

## Root cause
- `media/chat.js` referenced `els.workspaceName` and `els.privacyNote`, which were not defined in the `els` map. Startup threw before `post({ type: 'ready' })`, so the host never sent `init`, leaving "Loading provider...".

## Fix
- Added missing `els` entries mapping to `workspace-name` and `privacy-note` DOM ids.
- Webview now posts `ready`; host sends `init` including provider status; `refreshStatus` works after ready.
- Missing API key, invalid endpoint, and unsupported provider remain distinguishable via `ProviderStatus.configurationError`, `credentialRequired`, `hasCredential`.

## Live-provider validation
- Status: NOT TESTED (requires user-operated OpenRouter key in SecretStorage).
- Operator instructions: set base URL `https://openrouter.ai/api/v1`, model `openai/gpt-4o-mini`, store key via QuantsMind: Set API Key, then run chat and agent flows. Do not include key in reports.