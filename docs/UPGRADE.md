# Upgrading from 0.1.x

v0.2.0 is a feature release on the same extension identity. Settings, the API key
storage key, and the provider contract remain compatible.

## Install

```bash
code --install-extension quantsmind-vscode-ai-coder-0.2.0.vsix
```

Reload the window if VS Code requests it. The extension ID remains
`quantsmind.quantsmind-vscode-ai-coder`.

## What changes for you

- The extension can now write workspace files **after you approve a plan**. The
  v0.1.x promise of "never writes files" no longer applies.
- Allowlisted validation commands can run **after you approve them**. The
  v0.1.x promise of "never runs commands" no longer applies.
- Conversations persist across window reloads in local extension storage.
- Four new commands are available: **Summarize Workspace**, **Attach Relevant
  Workspace Files**, **Start Agent Task (Plan Changes)**, and **Show Change
  History**.
- New settings cover workspace indexing, retrieval, agent limits, and command
  execution. Defaults are conservative.

## Compatibility

| Item | Status |
| --- | --- |
| Extension ID | Unchanged |
| API key storage key | Unchanged; no need to re-enter the key |
| Provider settings | Unchanged; still application-scoped |
| Endpoint rules | Unchanged; HTTPS remote, loopback HTTP opt-in |
| Context exclusions | Unchanged; built-ins still mandatory |
| v0.1.x conversation history | Not migrated; v0.1.x did not persist it |
| Existing workspace files | Untouched until you approve a change |

## Recommended first run

1. Confirm the provider status shows a configured endpoint and key.
2. Run **QuantsMind: Summarize Workspace** and check that unexpected files are
   excluded.
3. Run **QuantsMind: Attach Relevant Workspace Files** with a small task and
   review the selected files before pressing Send.
4. Run **QuantsMind: Start Agent Task** on a disposable file to see the review
   and undo flow.
5. Review `quantsmind.commands.allowlist` and keep only commands you trust.

## Rollback

Installing the 0.1.x VSIX again restores the previous behavior. Files and
backups created by 0.2.0 are not removed automatically. Backups live in the
extension's global storage directory; remove them only after you no longer need
undo history.

## Breaking changes

There are no settings migrations. The main breaking change is behavioral: the
extension is no longer read-only. If your policy requires a read-only assistant,
do not approve plans or start agent tasks, and do not configure validation
commands.
