# Execution, build and test integration (v2.3.0)

Build and test tooling is integrated with the existing agent workflow. Nothing
in this document requires a second execution engine or bypasses the command
approval model: every command the agent runs flows through the existing
allowlist validation, explicit approval and the no-shell runner.

## Execution service

`src/execution/service.ts` records a bounded, in-memory history of executions
started through the approved path, including long-running ones:

- every record carries `kind` (`command` | `build` | `test`), `taskId`,
  `startedAt`/`finishedAt`, `durationMs`, `exitCode`, `status`
  (`running`/`succeeded`/`failed`/`cancelled`/`timed-out`), bounded output,
  truncation, diagnostics and parsed test counts;
- identical invocations in the same directory are refused while one is
  in flight (duplicate-execution protection);
- cancellation is available per execution (`cancel(id)`) or globally
  (`cancelAll()`), plus per-run timeouts;
- the webview streams these records as `execution` messages and renders
  execution cards with status badges, output, duration and test counts.

## Build adapters

`src/build/adapters.ts` provides a common adapter interface implemented by
every registered build system (Maven, Gradle, npm/pnpm/yarn, pip/Poetry/uv/
Hatch, Go, Cargo, CMake, Make, Ninja, dotnet, MSBuild, Composer, Bundler,
Dart, Flutter, Swift and Karkain). Detection is local and path-based with
manifest-content confirmation; nothing executes during detection.

- `detect_build_system` reports detected adapters, their commands and
  toolchain availability.
- `get_toolchain` probes the detected adapters' executables and reports
  versions (or honest unavailability).
- `run_build` and `run_tests` execute the adapter's commands **through the
  shared command tools** (allowlist + approval + runner), stop at the first
  failing step, and return structured diagnostics and parsed test counts.
- Toolchain probes use the same no-shell, fail-closed rules as the command
  runner; a missing executable is reported unavailable, never guessed.

## Test output parsing

`src/build/testOutput.ts` parses the canonical output of each supported
runner into pass/fail/skipped counts plus failure locations when the format
encodes them. Unrecognized output yields `undefined` counts instead of
invented numbers.

## Diagnostics and repair

`src/diagnostics/sourceDiagnostics.ts` extracts `file:line:column` diagnostics
from compiler/build/test output (TypeScript, Java, C/C++, Go, Rust, Python,
Karkain, JUnit failures). These are attached to the execution record and
returned to the agent, feeding the existing diagnose → propose → approve →
apply → revalidate repair loop. The agent stops after its configured bounded
attempts and reports unresolved failures honestly.

## Karkain compiler integration

`karkain.toml` or `.kark` sources activate the Karkain adapter. Toolchain
probing uses the real `karkain` executable (`karkain --version` works on
this machine). Karkain build/check/test commands are generated from the
detected entry point. **The real Karkain compiler cannot execute on this
machine** (verified: `karkain.exe check` on known-good conformance files
exits with code 3 and no diagnostics output; `kcc.exe` fails to launch with
a missing-DLL error). Tests therefore use a controllable fixture compiler
(`test/fixtures/karkain-toolkit/karkain.bat`) with the documented CLI
contract and exit codes (0/2/3/4), and the demonstration scripts clearly
distinguish fixture-based evidence from real compiler execution.

## Agent integration

`detect_build_system`, `get_toolchain`, `run_build` and `run_tests` are
registered alongside the existing agent tools; the agent system prompt directs
it to inspect the build system before planning changes. Builds and tests
require per-command approval exactly like any other command.
