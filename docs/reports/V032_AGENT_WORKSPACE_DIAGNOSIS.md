# V032 Agent Workspace Diagnosis

## Environment and installed-version evidence
- Installed extension: `quantsmind.quantsmind-vscode-ai-coder@0.3.2` (verified via `code --list-extensions --show-versions`).
- Repository baseline: `feature/v0.3.2` at `227d4ff1d92618fe257bd1d7f9fc3cf3d461535a`.
- This diagnosis is read-only; no source, workspace, Git, build, or package changes were made.

## Execution-path trace
1. UI mode selection: `media/chat.js` sends `{ type: 'send', prompt, mode }`.
2. Host: `src/chat/chatViewProvider.ts` `handleMessage` → `handleSend(rawPrompt, mode)`.
3. Agent branch: `handleSend` calls `startSession(rawPrompt)` when `isAgentMode(mode)` is true.
4. `startSession` checks `workspaceRoot()` (`vscode.workspace.workspaceFolders?.[0]`); if undefined, posts “Open a workspace folder before using agent mode.”
5. It calls `controller.start(requirement, token)` (`src/agent/orchestrator.ts`).
6. `start()` transitions to `inspecting`, then calls `this.deps.inspect(token)`.
7. `deps.inspect` is `ProjectIntelligenceService.inspect()` (`src/project/intelligence.ts`), backed by `WorkspaceIndexService.getEntries()` (`src/workspace/indexService.ts`) using `vscode.workspace.findFiles`.
8. Retrieved context is passed to `buildDevelopmentPlanMessages` (`src/agent/planning.ts`) as project summary + relevant files.
9. Provider request is constructed and sent via `CompletionService`.

## Findings with file paths/lines
- `src/chat/chatViewProvider.ts:108` `workspaceRoot()` returns first workspace folder.
- `src/chat/chatViewProvider.ts:1033` blocks Agent mode when no workspace folder.
- `src/agent/orchestrator.ts:418` invokes `this.deps.inspect(token)`.
- `src/agent/runtime.ts:85` wires `inspect: (token) => intelligence.inspect(token)`.
- `src/project/intelligence.ts:325` `inspect()` reads entries and package.json.
- `src/workspace/indexService.ts` `buildIndex()` uses `vscode.workspace.findFiles('**/*', ...)` and reads `.gitignore`.
- Errors during `inspect` are caught by `runBusy` and reported via `failSession` with the error message.

## Test results
- Unit tests: 339 passing (includes agent orchestrator tests).
- Integration tests: 28 passing, including “plans, approves, writes, validates state, and undoes a workspace change end to end,” which exercises Agent mode workspace inspection.
- No failing tests observed.

## Root cause
Verified: the Agent-mode inspection path is implemented and tested. No defect was found in the local inspection/retrieval code path. The reported message is not produced by the extension; it is consistent with model-generated text or a user/mode mismatch (e.g., using Ask mode, which intentionally has no automatic workspace context). If Agent mode truly failed to inspect, `failSession` would surface the underlying error rather than a generic capability statement.

Hypothesis: the user may have used Ask mode or a workspace with no opened folder/trust; verify workspace folder and mode selection.

## Recommended minimal remediation for v0.3.3
- Add explicit UI confirmation of detected workspace root and mode in Agent sessions.
- Surface inspection errors prominently (already partially done).
- Add “workspace detected” diagnostic in Output channel.
- Improve documentation clarifying Ask vs Agent capabilities.
- Optional: allow Ask mode to include a compact workspace summary with explicit consent.

## Regression tests required
- Integration test verifying Agent mode session records `Inspected <rootName>` and includes project summary.
- Integration test for no-workspace Agent mode error.
- Integration test for Restricted Mode Agent mode error.
- Unit tests for `ProjectIntelligenceService.inspect` with empty and populated entries.