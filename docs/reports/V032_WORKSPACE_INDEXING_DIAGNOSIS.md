# V032 Workspace Indexing Diagnosis

## 1. Environment and workspace-root evidence
- Installed extension: `quantsmind.quantsmind-vscode-ai-coder@0.3.2`.
- Observed summary: "Workspace workspace: 2 indexed files" with top-level `README.md`, `sample.ts`.
- Verified from source: `WorkspaceIndexService.getRoot()` returns `vscode.workspace.workspaceFolders?.[0]`; `rootName` is set to that folder's `name`.
- Verified: if the first workspace folder is named "workspace", the summary will display "Workspace workspace", matching the observed output.
- Hypothesis: the extension is indexing a different/first workspace folder (or a folder named "workspace"), not the repository root the user believes is open, or the VS Code window has multiple workspace folders with the repository not first.

## 2. Indexing execution-path trace
- `src/extension.ts` creates one `WorkspaceIndexService`.
- `src/chat/chatViewProvider.ts` `summarizeWorkspace()` calls `workspaceIndex.summarize()`.
- `WorkspaceIndexService.getEntries()` builds index if `entries === undefined`.
- `buildIndex()`:
  - gets first workspace folder;
  - reads root `.gitignore` and `.git/info/exclude`;
  - calls `vscode.workspace.findFiles('**/*', undefined, maxIndexedFiles * 2)`;
  - skips non-`file` scheme URIs;
  - applies `isPathExcluded` and ignore matcher;
  - sorts and caps at `maxIndexedFiles`.

## 3. Root cause of two-file index
Verified: the index contains exactly the files returned by `findFiles` after filtering. The two-file result means either:
- the indexed root contains only two files, or
- filtering removed all other files.
Hypothesis (most likely): root mismatch / workspace folder selection, because the observed root name "workspace" and file set (`README.md`, `sample.ts`) match the test fixture workspace, not the repository.

## 4. File discovery and exclusion analysis
- `findFiles('**/*', undefined, ...)` relies on VS Code's default excludes when the exclude argument is undefined; unusual excludes could remove `src`.
- `isPathExcluded` applies user `context.excludeGlobs`.
- `createIgnoreMatcher` applies root `.gitignore` and `.git/info/exclude`; broad rules there could exclude `src/docs/package.json`.
- `uri.scheme !== 'file'` skips remote/virtual files; a remote workspace could yield zero or partial results.
- Cache: `entries` is cached until `invalidate()`; stale index possible if workspace changes without invalidation.

## 5. Project marker detection findings
- `ProjectIntelligenceService.inspect()` derives markers from file names and reads only `package.json`.
- If `package.json` is absent from the index, no markers are detected.
- Only one TypeScript file counted because only one `.ts` path survived indexing.

## 6. Agent integration findings
- Agent mode uses the same `WorkspaceIndexService` via `ProjectIntelligenceService`.
- A zero-task plan occurs when the model receives minimal/empty project context and determines no changes are needed.
- Agent mode does not receive a different index; it shares the same two-file index.

## 7. Security findings
- Workspace Trust: `WorkspaceIndexService` itself does not check `isTrusted`; Agent execution is gated separately. Indexing local files is read-only.
- Secret exclusions and `.gitignore` are applied.
- Workspace containment and symlink handling are enforced in `WorkspaceChangeFs`, not in indexing.
- No security weakening recommended.

## 8. Recommended v0.3.3 remediation
- Log and surface the resolved workspace root and indexed file count in Summarize Workspace output.
- Handle multi-root workspaces explicitly (allow selecting or indexing all roots, or clearly report first-root behavior).
- Invalidate index on workspace folder changes.
- Consider reporting exclusion reasons/counts.
- For remote schemes, either support indexing or clearly state local-only indexing.

## 9. Regression tests required
- Test `WorkspaceIndexService` against a multi-file fixture and assert `src`, `docs`, `package.json` are indexed.
- Test root-name reporting.
- Test ignore/exclusion filtering reasons.
- Test cache invalidation on workspace change.
- Integration test for Summarize Workspace output in a real multi-folder workspace.

## 10. Verified facts vs hypotheses
Verified:
- Source uses first workspace folder and caches entries.
- Observed summary indicates root named "workspace" with only `README.md` and `sample.ts`.
- Indexing filters non-file schemes, excluded globs, and gitignore rules.
Hypotheses:
- Root mismatch / workspace folder selection is the primary cause.
- `.git/info/exclude` or VS Code default excludes may contribute.
- Stale cache may contribute.