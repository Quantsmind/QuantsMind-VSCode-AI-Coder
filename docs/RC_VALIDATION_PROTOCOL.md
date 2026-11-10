# Release-candidate validation protocol (GA Phase 7)

This is the procedure that turns the branch build into a *qualified* release candidate.
Automated tests run against a mock provider in a disposable profile, so they cannot prove
the two things GA actually depends on: a real provider under real load, and a real upgrade
touching real conversation data. Everything below is run by you on a real VS Code; the
scripts in §2 make each claim measurable instead of remembered.

Nothing here installs, uninstalls or clears anything by itself, and no step asks for your
API key. `scripts/seed-test-profile.mjs` refuses to write to a directory that already holds
a state DB, so it cannot be pointed at your real profile by mistake.

## 1. Prerequisites

| Item | Requirement |
| --- | --- |
| RC build | `npm run release -- --bump minor` then `npm run verify` (exit 0), `npm run package`, `node scripts/sha256.mjs quantsmind-vscode-ai-coder-*.vsix`. Record the SHA-256; every run below names the artefact by checksum, not by version string. |
| Log capture | **Every** launch must pass `--logsPath`. Without it the Output channel is not on disk and the run produces no reviewable evidence. |
| Isolated profile | Runs A–D use `--user-data-dir` + `--extensions-dir` pairs so your daily profile is never the test subject. |
| Rollback artefact | The previous VSIX kept outside the repo (currently `C:\Users\Lenovo\QuantsMind-Backups\v034-20261104T115340\`). Do not delete it until GA is accepted. |

## 2. Instrumentation

| Command | What it gives you |
| --- | --- |
| `node scripts/inspect-conversation-store.mjs [--user-data-dir <dir>] [--label before\|after]` | Read-only (`node:sqlite` `readOnly: true`) fingerprint of the persisted conversation store: record ids, message and character counts, schema stamp, `updatedAt` rank, `salvagedUnreadableRows`, the active-id flag, a `rawValueSha256` and a `recordFingerprint`. It prints no message text, no titles, no credential values. A locked DB is reported as `BLOCKED` (exit 2), never forced — close the window that owns the profile first. |
| `node scripts/seed-test-profile.mjs --profile <fresh-dir>` | Builds a throwaway profile holding two readable records (one legacy v1 with path-label attachments, one schema-v2 record with captured attachment context whose checksum matches `test/fixtures/workspace/src/utils.ts`) plus two deliberately unreadable rows, then prints the exact launch, probe and cleanup commands for Run C. |

`recordFingerprint` is order-insensitive and content-free: same records with the same
message counts and timestamps produce the same hash, so one line tells you whether an
upgrade rewrote or dropped anything.

## 3. Run A — cold install

Fresh profile, no QuantsMind ever installed there.

1. `mkdir` a new profile dir; `code --user-data-dir <p> --extensions-dir <p>/extensions --logsPath <p>/logs --install-extension <rc>.vsix`
2. Launch the same way with a real folder opened; configure provider; run the manual tests
   from [V0.3.4_MANUAL_QUALIFICATION_REPORT.md](./reports/V0.3.4_MANUAL_QUALIFICATION_REPORT.md) §7:
   1 (New Chat), 3 (history/reload/restore), 4 (attachment persistence), 5 (attachment
   freshness), 6 (New/Clear/Restore/Delete), 7 (isolation), 8 (Stop mid-stream), 9a/9c/9d.
3. Close the window, then `node scripts/inspect-conversation-store.mjs --user-data-dir <p> --extensions-dir <p>/extensions --label cold`.

Expected on a clean profile: records exist, every parsable record carries `schema=2`,
`salvagedUnreadableRows=0`, `installedBuilds … versions=` shows exactly one build.

## 4. Run B — upgrade with real pre-0.3.4 conversations (the one that matters)

This is the run your daily profile has already partly produced, but it must be observed
against the RC build, which contains two shipped-behaviour changes since (`delete`
promotion and the activation-supplied User-Agent).

1. Back up first: copy `<AppData>/Code/User/globalStorage/state.vscdb` and
   `User/settings.json` to a dated folder outside the repo.
2. `node scripts/inspect-conversation-store.mjs --label before` (default install) → save the
   output verbatim, including `recordFingerprint` and `rawValueSha256`.
3. Install the RC over the installed build (`code --install-extension <rc>.vsix --force`),
   restart, then re-run the probe with `--label after`.
4. Compare the two outputs. **Qualifies if:** the same record ids appear in both,
   `storedConversations` and `parsable` are unchanged, and `recordFingerprint` is identical.
   A changed `rawValueSha256` alone is not a defect — the store rewrites on save — but a
   fingerprint change means content or counts moved, and that is a defect.
5. In the UI: Restore the longest pre-0.3.4 conversation, confirm the message count matches
   the probe line for that record, and confirm legacy attachment chips read `legacy` /
   `unavailable` rather than implying the model still has the file.
6. Provider readiness is evidenced *functionally*: one live request that returns the
   expected text proves the stored credential survived the upgrade. Do not read or copy the
   secret itself; a `sk-…` value must not appear in any evidence file.

## 5. Run C — corrupted store on disk

Automated coverage proves the parse path; this proves it against real storage.

1. `node scripts/seed-test-profile.mjs --profile <fresh-dir>` (prints the rest).
2. Probe with `--label before`: expect `storedConversations=4 parsable=2 schemaV2=1 salvagedUnreadableRows=0`.
3. Launch that profile, open `test/fixtures/workspace`, activate QuantsMind, Restore.
4. Close, probe with `--label after`. The store rewrites itself on the first save, so expect
   `storedConversations=2 parsable=2 salvagedUnreadableRows=2` — the two unreadable rows move
   to their own key, the two readable ones keep the same `recordFingerprint`, and
   `logs/<window>/` contains the history-ready line with counts only. If the readable records
   lost their captured attachment context (`attachmentContextTurns` back to 0 on the v2 row),
   that is a defect, not a cosmetic change.
5. Delete the profile folder by hand once the output is recorded.

If VS Code reports the profile's state DB as unusable, stop and record that instead — the
seeded schema mirrors VS Code's own `CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE
ON CONFLICT REPLACE, value BLOB)` statement, taken from the 1.95.0 host bundle, but this
script has only been exercised by the probe, not yet by a live host.

## 6. Run D — rollback executed, once

The rollback path has never been run end to end; it has only been described. After Run B:

1. `code --install-extension <previous>.vsix --force` using the backup VSIX, restart.
2. Probe with `--label rolledback`: the store must still hold the same records as `before`
   (v0.3.4 reads v2 records; the extra `schema` field is ignored, not destructive).
3. Re-install the RC and confirm readiness again with one live request.

Qualifies only if the record ids and counts survive both directions.

## 7. Three-host extension-host evidence

CI already runs the integration suite on Windows, macOS and Linux. For the RC:

1. Push `release/v0.4.0` (needs your authorisation) and run the workflow via `workflow_dispatch`.
2. Attach the `quantsmind-vscode-ai-coder-*.vsix` artefact and its `checksum.txt` to the release notes.
3. Record the run URL per OS. A rerun after a stall must be reported as a rerun, not silently.

Note: `.vscode-test.mjs` and `.vscode-test.packaged.mjs` both launch with
`--disable-workspace-trust`, so **trust behaviour can never be observed from the automated
suite** — restricted-mode rows (9b) are live-UI observations only.

## 8. Evidence table

Fill one row per run with PASS / FAIL / BLOCKED / NOT TESTED, the VSIX SHA-256 prefix, the
probe output and the log folder. No row may be left blank in the RC report; an unobserved
row stays NOT TESTED and blocks sign-off rather than being inferred from a unit test.

| Run | Assertion | Result | Evidence |
| --- | --- | --- | --- |
| A | Cold install, tests 1/3/4/5/6/7/8/9a/9c/9d | | |
| B | `recordFingerprint` identical across the upgrade | | |
| B | Legacy conversation restores with matching count; chips read `legacy` | | |
| B | Live request succeeds with the pre-existing stored key | | |
| C | `salvagedUnreadableRows=2`, readable records intact | | |
| D | Records survive RC → previous → RC | | |
| 7 | Windows / macOS / Linux green on the RC commit | | |
