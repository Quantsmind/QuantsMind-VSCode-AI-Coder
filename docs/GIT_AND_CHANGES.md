# Git, GitHub and change management (v2.4.0)

Integrated Git + change-management capabilities are implemented in
`src/git/`, `src/github/` and `src/agent/gitTools.ts`, and exposed
through the agent's existing tool registry, approval system and webview.

## Git service

`src/git/gitService.ts` runs the Git CLI through the same fail-closed,
no-shell execution plan used by validation commands. Available operations:

- Repository detection, branch and HEAD, dirty state
- Staged, modified, untracked, deleted and conflicted files
- Diff (worktree / cached), numstat, binary file detection
- Remote listing (credentials stripped)
- Branch list, create, switch, delete (approval required for switches/deletions)
- Staging and unstaging (explicit file lists; `-a` / `.` / `*` refused)
- Commit (approval required, staged files only, SHA reported)
- Recent history
- Rename detection in porcelain status parsing
- Merge/rebase conflict state detection

## Checkpoint service

`src/git/checkpointService.ts` captures file contents and metadata into
named checkpoints bound to a task. Restore never overwrites diverging user
edits; conflicting files are preserved and reported.

## GitHub service

`src/github/githubService.ts` is a thin REST client over `/repos/...`:
list/create issues and list/create pull requests. The token is taken from
the active VS Code GitHub session (`vscode.authentication`), never logged,
and rejected requests are mapped to `unauthenticated` / `forbidden` /
`rate-limited` / `validation` / `network` kinds.

## Agent tools

- `git_status`, `git_diff`, `git_log`, `git_branch_list`, `git_remotes` — read-only
- `git_stage`, `git_unstage`, `git_commit` — approval required
- `git_create_branch`, `git_switch_branch`, `git_delete_branch` — approval required
- `create_checkpoint`, `restore_checkpoint`, `list_checkpoints` — checkpoint approval for restore
- `github_list_issues`, `github_create_issue`, `github_list_pull_requests`, `github_create_pull_request` — approval for writes

## Webview integration

The repository inspector now includes a Git status card showing:
- current branch, HEAD short, remote
- changed/staged/untracked file counts and the file list
- in-progress merge/rebase/conflict flags
- GitHub issue and pull-request count (only when the account is authenticated)
- checkpoint history
