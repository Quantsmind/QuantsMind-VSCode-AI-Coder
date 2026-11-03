# Upgrading from 0.2.0

v0.3.0 is a feature release on the same extension identity. Settings, the API
key storage key, and the provider contract remain compatible.

## Install

```bash
code --install-extension quantsmind-vscode-ai-coder-0.3.0.vsix
```

Reload the window if VS Code requests it. The extension ID remains
`quantsmind.quantsmind-vscode-ai-coder`.

## What changes for you

- **Start Agent Task (Plan Changes)** is now **Start Agent Session**. The command
  id (`quantsmind.startAgentTask`) is unchanged.
- An agent session is plan-first: the provider proposes a typed development
  plan, you approve the plan, and only then does task execution begin.
- Each task produces its own change set and per-file approval. Approval is still
  per file and never automatic.
- The control center shows stages, task status, evidence, diagnostics, repair
  proposals, and a completion report.
- Sessions persist across window reloads and can be paused, resumed, restored,
  or deleted. Restore re-hashes applied files and refuses sessions from another
  workspace root.
- Validation commands are classified as `validation`, `read-only`,
  `destructive`, or `unknown`. Destructive commands are refused even if added to
  the allowlist.
- Repairs are bounded by `quantsmind.agent.maxRepairIterations` and are reviewed
  and approved like any other change set.

Everything from v0.2.0 remains: workspace index and retrieval, approval-first
changes, diffs, backups, undo, change history, conversation persistence, and
redaction.

## Compatibility

| Item | Status |
| --- | --- |
| Extension ID | Unchanged |
| API key storage key | Unchanged; no need to re-enter the key |
| Provider settings | Unchanged; still application-scoped |
| Endpoint rules | Unchanged; HTTPS remote, loopback HTTP opt-in |
| Context exclusions | Unchanged; built-ins still mandatory |
| Command allowlist | Unchanged defaults; risk classification is new |
| v0.2.0 conversations | Unchanged; stored separately from agent sessions |
| v0.2.0 change history | Unchanged; backups remain valid |
| Agent sessions | New `quantsmind.agent.sessions.v1` store; no v0.2.0 equivalent |
| Existing workspace files | Untouched until you approve a change |

## Recommended first run

1. Confirm the provider status shows a configured endpoint and key.
2. Run **QuantsMind: Summarize Workspace** and check that unexpected files are
   excluded.
3. Run **QuantsMind: Start Agent Session** on a disposable file, approve the
   plan, then review and approve one file change.
4. Run an allowlisted validation command and review the evidence.
5. Use **Show Change History** or undo to restore the disposable file.
6. Review `quantsmind.commands.allowlist` and keep only commands you trust.

## Rollback

Installing the 0.2.0 VSIX again restores the previous single-task workflow.
Agent-session records remain in extension global storage but are ignored by
0.2.0; remove them manually if you want a clean rollback. Files and backups
created by 0.3.0 are not removed automatically.

## Breaking changes

There are no settings migrations. The behavioral changes are:

- the agent workflow requires plan approval before any task runs;
- validation commands become `awaiting` until you explicitly run them;
- destructive commands are refused regardless of the allowlist;
- restoring a session may fail it when applied files no longer match their
  recorded hashes.

If your policy requires a read-only assistant, do not approve plans or change
sets, and do not configure validation commands.
