# Workspace intelligence

The workspace index is local. It gives the assistant structure and relevant
files without uploading the workspace in the background.

## What is indexed

For the first workspace folder, the extension enumerates files with
`vscode.workspace.findFiles` and records:

- Workspace-relative path.
- Language identifier from the file extension.
- Size in bytes.
- Entry-point status (for example `src/index.ts`, `src/main.ts`, `src/extension.ts`,
  `package.json`, `pyproject.toml`, and common `main`/`index` variants).
- Test-path status (`test`, `tests`, `spec`, `__tests__`, `*.test.*`, `*.spec.*`).

The index is held in memory, bounded by `quantsmind.workspace.maxIndexedFiles`
(default 5000), and invalidated when workspace folders or files change.

## Exclusions

A file is excluded if any of these apply:

1. Built-in security patterns: `.env`, private keys, credential files,
   SSH/AWS/GnuPG material, dependencies, and build output.
2. User `quantsmind.context.excludeGlobs`.
3. `.gitignore` rules from the workspace root.
4. `.git/info/exclude`.
5. Empty, binary, or oversized content when the file is read.

Gitignore parsing supports comments, blank lines, negated rules (`!`), anchored
rules (`/build/`), directory rules (`node_modules/`), escaped literals
(`\#file`), and last-match-wins ordering. Windows path separators are normalized.

Built-in exclusions cannot be removed. User patterns add to them.

## Summary

**QuantsMind: Summarize Workspace** produces a plain-text summary containing:

- Workspace name.
- Indexed file count and a truncation note when the cap applies.
- Detected technologies and tooling markers.
- Entry points.
- Top-level directories and their file counts.
- Test-file count.

The summary is displayed in the chat view. It is not sent to the provider
unless you include it in a message.

## Retrieval

**QuantsMind: Attach Relevant Workspace Files** takes a task description and:

1. Tokenizes the query.
2. Scores each indexed path by name/path matches, language markers, entry-point
   status, test-path status, and size penalties.
3. Selects up to `quantsmind.workspace.maxRetrievedFiles` (default 8).
4. Reads the files and applies the normal context filters and redaction.
5. Attaches them to the composer for review with the reason each was selected.

Nothing is transmitted until you press **Send**. During an agent task, retrieval
runs as the first stage and the selected files are shown as part of the task.

The effective character budget is the smaller of
`quantsmind.workspace.retrievalMaxChars` and
`quantsmind.context.maxTotalChars`.

## Limits and settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `quantsmind.workspace.maxIndexedFiles` | 5000 | Index size cap |
| `quantsmind.workspace.maxRetrievedFiles` | 8 | Files per retrieval |
| `quantsmind.workspace.retrievalMaxChars` | 40000 | Retrieved-context budget |
| `quantsmind.context.maxTotalChars` | 48000 | Request attachment budget |
| `quantsmind.context.maxFileSizeKb` | 256 | Per-file size cap |
| `quantsmind.context.maxFiles` | 20 | Total attachments per request |

## Privacy

- Indexing performs no network request.
- Retrieval performs no network request until a chat request or agent task is
  started.
- Attached retrieval content passes through the same redaction rules as manual
  attachments, including exact credentials and masked key fragments.
- Skipped files and the reasons are available in the retrieval result.
