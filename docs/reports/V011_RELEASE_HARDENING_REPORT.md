# v0.1.1 Release Hardening Report

Date: 2026-11-03
Product: QuantsMind AI Coder (`quantsmind.quantsmind-vscode-ai-coder`)
Status: Release-candidate hardening complete; incremental streaming verified
locally; Output-channel scan failed; release blocked

## 1. Initial baseline

| Item | Value |
| --- | --- |
| Repository | `F:\Codes\Git\Quantsmind-Products\QuantsMind-VSCode-AI-Coder` |
| Working branch | `develop` |
| Baseline commit | `713f5a1` (docs: describe the full verify pipeline) |
| Main baseline | `aaa59d2` (chore: establish v0.1.0 baseline) |
| Remotes | None |
| Working tree at start | Clean |
| Extension version | `0.1.0` |
| Local environment | Windows 10.0.26300 x64, Node 24.18.1, npm 11.11.1 |
| Test VS Code | 1.95.0 (isolated `.vscode-test` archive) |

No reset, rewrite, remote creation, push, merge, tag, or publication was
performed.

## 2. Security advisory investigation

### Advisory

- Identifier: `GHSA-g3hv-75wg-m249`
- Package: `minimatch`
- Title: "minimatch has potential denial of service via globparts amplification"
- Classification: CWE-405, moderate (advisory page reports CVSS 6.9)
- Affected range: `<11.0.1`
- Patched version: `11.0.1`
- Description: attacker-controlled glob patterns can amplify parsing work and
  exhaust CPU/memory.

### Installed minimatch instances

`npm ls minimatch --all` after `npm ci` reported:

| Version | Count | Scope | Introduced by |
| --- | --- | --- | --- |
| 11.0.4 | 1 | runtime (direct) | This extension's `dependencies` |
| 10.2.6 | 7 | development | `@vscode/test-cli` (direct, via `glob@13.0.6`, via `c8 → test-exclude`), `@vscode/vsce`, `eslint` (direct, via `@eslint/config-array`), `typescript-eslint → @typescript-eslint/typescript-estree` |
| 9.0.9 | 1 | development | `mocha` (direct and via `mocha → glob@10.5.0`, deduped) |

`package-lock.json` contains exactly nine minimatch entries:

- `node_modules/minimatch` — `11.0.4`, `dev: false`.
- Eight nested entries — `dev: true` (seven at `10.2.6`, one at `9.0.9`).

### Exposure determination

- The shipped runtime dependency is `minimatch@11.0.4`, which is **above the
  patched 11.0.1 floor and is not affected** by the advisory.
- The discussion's reference to a "minimatch 9 DoS" is explained by mocha's
  development dependency on `9.0.9`. It is build/test tooling only.
- All affected copies (`9.0.9`, `10.2.6`) are marked development-only in the
  lockfile and are excluded from the VSIX. `extension/node_modules/minimatch`
  is the only minimatch tree in the archive, at `11.0.4`.
- `npm audit --omit=dev` reports **0 vulnerabilities**.
- The full development tree reports 19 advisories (1 low, 17 moderate, 1 high);
  the minimatch advisory is one of the moderate entries and is not reachable
  from shipped code. Development glob patterns come from repository scripts and
  configuration, not from extension users.

### Remediation decision

No dependency version was changed.

- No patched `9.x` or `10.x` release exists; the fix landed only in the
  minimatch 11 rewrite, which is not backported.
- The latest upstream releases checked (`@vscode/test-cli@0.0.15`,
  `@vscode/vsce@4.1.0`, `eslint@10.14.0`, `mocha@12.0.3`) still resolve to
  minimatch `10.2.6` or `9.0.9`; upgrading mocha to 12 would not clear the
  advisory.
- `npm audit`'s suggested non-forced fix is a semver-major downgrade to
  `eslint@4.0.0`, which is unsafe and would remove current lint coverage.
- Forcing `overrides` to `minimatch@11.0.4` across the toolchain would replace
  a semver-major dependency with a deeply rewritten matcher inside build tools;
  this is not a "safest compatible remediation".
- `npm audit fix --force` was not used.

### Regression guard

Added `scripts/verify-dependencies.mjs` and `npm run verify:deps`. The check is
offline and lockfile-based. It fails when:

- the root runtime minimatch entry is missing or marked development-only;
- any non-development minimatch is below `11.0.1`;
- `package.json` does not pin the exact lockfile runtime version.

It prints the development-only instances so the accepted exposure stays
visible. The guard was exercised against a deliberately downgraded copy and
failed as expected. It is part of `npm run verify` and the CI release job.

## 3. Dependency changes

- Runtime dependencies: none changed (`minimatch@11.0.4` remains the only one).
- Development dependencies: none changed.
- Added build-time script: `scripts/verify-dependencies.mjs`.
- No `overrides`, no `npm audit fix`, no lockfile version drift.

## 4. Cross-platform verification

### Executed locally

| Check | Environment | Result |
| --- | --- | --- |
| Lint, compile, unit tests | Windows, Node 24.18.1 | Pass |
| Extension-host tests | Windows, VS Code 1.95.0, Node 24.18.1 | Pass |
| Packaged-VSIX tests | Windows, VS Code 1.95.0 | Pass |
| Clean install via VS Code CLI | Windows, isolated extensions dir | Pass |

These Windows results were reconfirmed by a full `npm run verify` run on
2026-11-03 (Node 24.18.1, exit code 0): 136 unit tests, 22 extension-host
tests, 4 packaged-VSIX tests, VSIX archive inspection, and clean install. The
rebuilt archive had the same size and entry count as the documented artifact,
with an identical normalized content digest.

### Configured in CI, not executed in this campaign

| Job | Runner | Node | Coverage |
| --- | --- | --- | --- |
| `quality` | `ubuntu-latest` | 20, 22, 24 | Lint, compile, unit tests |
| `extension` | `ubuntu-latest`, `windows-latest`, `macos-latest` | 22 | Extension-host tests (Linux under `xvfb-run`) |
| `release` | `ubuntu-latest` | 22 | Full `npm run verify`, VSIX artifact upload |

The workflow YAML parses successfully with `js-yaml@4.1.0`. All referenced npm
scripts exist and were executed locally on Windows. GitHub Actions itself was
not run because no remote is authorized; Ubuntu, macOS, Node 20, and Node 22
execution is unverified until CI runs. No cross-platform pass is claimed beyond
the Windows results above.

## 5. Test and verification results

Command: `npm ci` then `npm run verify`.

| Stage | Result |
| --- | --- |
| `eslint .` | Pass, no findings |
| `npm run verify:deps` | Pass; runtime `11.0.4`, 8 dev-only older copies documented |
| `tsc -p tsconfig.json` | Pass |
| Unit tests | **136 passing** (~0.6 s) |
| Extension-host tests | **22 passing** (~11 s) |
| Packaged-VSIX tests | **4 passing** (~0.4 s) |
| `verify:vsix` | All required, forbidden, manifest, and secret checks passed |
| Clean install | Installed and listed as `quantsmind.quantsmind-vscode-ai-coder@0.1.0` |
| `npm audit --omit=dev` | **0 vulnerabilities** |
| Full `npm audit` | 19 advisories, development-only (1 low, 17 moderate, 1 high) |

Security regression coverage remains green: SecretStorage-only credentials,
endpoint/HTTPS/loopback validation, redirect rejection, sensitive-path
exclusion, context redaction, webview CSP/nonce, no command execution, no
workspace writes, and no telemetry.

The automated logger-redaction tests pass, but they do not cover provider-masked
key fragments. The live Output-channel finding in §7 is a gap outside the
current test coverage.

## 6. Packaging evidence

| Item | Value |
| --- | --- |
| Artifact | `quantsmind-vscode-ai-coder-0.1.0.vsix` |
| Size | 155,203 bytes (151.57 KiB) |
| Entries | 72 |
| SHA-256 | `44896183956757ca28dee1e62ebb12d7ff40e629ef48f97baf85bc77d5441a7a` |
| Manifest version | `0.1.0` |
| Installed identity | `quantsmind.quantsmind-vscode-ai-coder@0.1.0` |
| Runtime dependency | `minimatch@11.0.4` only |
| Forbidden content | No source, tests, docs, scripts, CI, maps, TS, logs, or secrets |

Reproducibility: two consecutive builds produced different ZIP container
hashes because of archive timestamps, but identical normalized content
(72 entries, content digest
`2f1388a333753f4c96f9bf8d025236511792c3a9e86e1f53fbaf0d75ede78512`). The packaged
file set and file bytes are reproducible; the container hash is not expected to
be stable.

Version consistency is preserved: `package.json`, `extension.vsixmanifest`, the
verification scripts, and the installed extension all report `0.1.0`.

## 7. Live provider validation status

Partially validated manually on 2026-11-03 with a disposable credential and a
third-party OpenAI-compatible provider. The chat displayed
`openai/gpt-4o-mini`.

Passed: successful provider response, model identification, conversation
context recall (`QM-2026`), text generation (numbers 1 through 30), cancellation
through **Stop**, API-key removal (`API key removed`), and missing-key rejection
(`No API key is configured for this provider.`, error code `authentication`,
guidance to use `QuantsMind: Set API Key`). Post-session inspection also found
no credential-like QuantsMind setting and no workspace file changes.

Streaming incremental delivery is **verified locally** with a controlled
loopback test on 2026-11-03 (deltas at 326 ms and 1,514 ms; completion at
1,822 ms). A third-party live streaming observation remains unrecorded.

The Output-channel credential scan **failed**. The persisted Output log from
the live session contains a provider-masked key fragment in a 401 provider
message recorded during setup, before the successful requests. No full key was
present, and no fragment is reproduced here. The redaction rules match full key
shapes, so the provider's masked form passes through. Remediation and a re-scan
are required.

Cross-platform CI remains unexecuted on Ubuntu and macOS; Windows local
verification passed. Extension-side key removal is confirmed. Provider-side
revocation of the disposable key is **unconfirmed** and must not be described as
complete. No full key was requested in chat or a terminal, printed, logged, or
committed.

Details:
[`V011_LIVE_PROVIDER_VALIDATION_REPORT.md`](V011_LIVE_PROVIDER_VALIDATION_REPORT.md).

## 8. Remaining limitations

- Live provider validation is partially complete: provider response, model
  display, context retention, generation, cancellation, key removal, and
  missing-key rejection passed. Incremental streaming is verified locally via a
  loopback test; third-party live streaming remains unobserved.
- The Output-channel scan failed: a persisted 401 log line exposed a
  provider-masked key fragment. Full-key redaction does not remove the masked
  form; remediation and a re-scan are outstanding.
- CI runs on Ubuntu, Windows, and macOS are configured but not yet observed.
  Only Windows was executed locally, and its full verification passed.
- Extension-side API-key removal is confirmed, but provider-side revocation of
  the disposable key is unconfirmed.
- The development tree retains 19 tooling advisories, including the minimatch
  `9.0.9`/`10.2.6` instances, with no compatible patched release available.
- v0.1.0 behavior is unchanged: read-only chat, one OpenAI-compatible adapter,
  in-memory history, and a markdown-lite renderer.
- Webview visual and accessibility behavior is validated structurally, not
  pixel-by-pixel.
- The extension remains an unpublished alpha preview; no tag, Marketplace
  release, Open VSX release, or GA claim exists.

## 9. Release-candidate recommendation

Do not tag or publish yet. The candidate is technically ready once:

1. The Output-channel credential exposure is remediated and a re-scan passes,
2. The CI matrix passes on Ubuntu, Windows, and macOS, and
3. A third-party live streaming observation is recorded under the validation
   procedure (incremental delivery is already verified locally).

The manual provider response, model display, context retention, generation,
cancellation, key-removal, and missing-key rejection checks already pass.

Separately, confirm provider-side revocation of the disposable key before
publication. Extension-side removal is confirmed, but revocation is not
evidenced.

On approval, bump the version to **0.1.1**, update the version references in
`package.json`, `scripts/verify-install.mjs`, `package.json`'s package script
output name, and `CHANGELOG.md`, rerun `npm run verify`, then tag only with
explicit release authorization.

After the live gate, the recommended v0.1.x direction is provider compatibility
hardening and observability polish. v0.2.0 feature work, including any
approval-first edit application, must not start without a separate mandate.
