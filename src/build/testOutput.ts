/**
 * Conservative parsers for common test-runner output formats. Every parser
 * reports `undefined` counts when the output does not carry them clearly;
 * nothing is invented. Failure locations are extracted when the format
 * encodes them.
 */

export interface ParsedTestFailure {
  readonly name: string;
  readonly file?: string;
  readonly line?: number;
  readonly message?: string;
}

export interface ParsedTestResult {
  /** Counts as the runner reported them; undefined when the format is ambiguous. */
  readonly passed?: number;
  readonly failed?: number;
  readonly skipped?: number;
  readonly total?: number;
  readonly durationMs?: number;
  readonly failures: readonly ParsedTestFailure[];
  readonly summaryLine?: string;
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function failure(name: string, file?: string, line?: number, message?: string): ParsedTestFailure {
  return {
    name: name.trim().slice(0, 300),
    ...(file !== undefined ? { file } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(message !== undefined ? { message: message.trim().slice(0, 500) } : {}),
  };
}

function findLine(output: string, pattern: RegExp): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    if (pattern.test(line)) {
      return line;
    }
  }
  return undefined;
}

/** JUnit / Maven Surefire and Gradle test reports: "Tests run: A, Failures: B, Errors: C, Skipped: D". */
function parseJunit(output: string): ParsedTestResult {
  const match = /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(?:(\d+),\s*)?Skipped:\s*(\d+)/i.exec(output);
  if (match === null) {
    return { failures: [] };
  }
  const total = toInt(match[1]);
  const failed = (toInt(match[2]) ?? 0) + (toInt(match[3]) ?? 0);
  const skipped = toInt(match[4]) ?? 0;
  const passed = total === undefined ? undefined : Math.max(0, total - failed - skipped);
  const failures = extractFailureNames(output, /\[ERROR\]\s+(.+?)\(([^)]+)\)/g);
  return { passed, failed, skipped, total, failures, summaryLine: match[0] };
}

function extractFailureNames(output: string, pattern: RegExp): ParsedTestFailure[] {
  const failures: ParsedTestFailure[] = [];
  for (const match of output.matchAll(pattern)) {
    if (failures.length >= 40) {
      break;
    }
    const name = match[1]?.trim();
    if (name !== undefined && name.length > 0) {
      failures.push(failure(name));
    }
  }
  return failures;
}

/** pytest: "1 failed, 2 passed, 1 skipped" style summary or "FAILED path::test" lines. */
function parsePytest(output: string): ParsedTestResult {
  const summaryLine =
    findLine(output, /(?:^|\b)\d+\s+(?:failed|passed|skipped|error)[^\n]*/i) ??
    findLine(output, /no tests ran/i);
  const summary = summaryLine ?? '';
  const passed = toInt(/(\d+)\s+passed/i.exec(summary)?.[1]);
  const failed = toInt(/(\d+)\s+failed/i.exec(summary)?.[1]);
  const skipped = toInt(/(\d+)\s+skipped/i.exec(summary)?.[1]);
  const errors = toInt(/(\d+)\s+errors?/i.exec(summary)?.[1]);
  const failures: ParsedTestFailure[] = [];
  for (const matchFailure of output.matchAll(/FAILED\s+([^\s(]+)/g)) {
    if (failures.length >= 40) {
      break;
    }
    const name = matchFailure[1];
    const location = /:(\d+)(?::|\b)/.exec(name);
    failures.push(
      failure(
        name,
        name.replace(/::[^:]+$/, ''),
        location === null ? undefined : Number.parseInt(location[1] ?? '0', 10),
      ),
    );
  }
  const total = [passed, failed, skipped, errors].every((value) => value === undefined)
    ? undefined
    : (passed ?? 0) + ((failed ?? 0) + (errors ?? 0)) + (skipped ?? 0);
  return { passed, failed: (failed ?? 0) + (errors ?? 0) || failed, skipped, total, failures, summaryLine };
}

/** Mocha/Jest/Vitest: "N passing" / "N failing" or "Tests: N passed, M failed". */
function parseNodeRunner(output: string): ParsedTestResult {
  const passing = /(\d+)\s+passing/i.exec(output);
  const failing = /(\d+)\s+failing/i.exec(output);
  const testsLine = findLine(output, /Tests?:/i);
  let passed = toInt(passing?.[1]);
  let failed = toInt(failing?.[1]);
  let skipped = toInt(/(\d+)\s+skipped/i.exec(output)?.[1]);
  if (passed === undefined && testsLine !== undefined) {
    passed = toInt(/(\d+)\s+passed/i.exec(testsLine)?.[1]);
    failed = toInt(/(\d+)\s+failed/i.exec(testsLine)?.[1]) ?? failed;
    skipped = toInt(/(\d+)\s+skipped/i.exec(testsLine)?.[1]) ?? skipped;
  }
  const failures: ParsedTestFailure[] = [];
  for (const matchFailure of output.matchAll(/✕\s+(.+)|✗\s+(.+)|×\s+(.+)/g)) {
    if (failures.length >= 40) {
      break;
    }
    const name = matchFailure[1] ?? matchFailure[2] ?? matchFailure[3] ?? '';
    if (name.trim().length > 0) {
      failures.push(failure(name));
    }
  }
  const total = [passed, failed, skipped].every((value) => value === undefined)
    ? undefined
    : (passed ?? 0) + (failed ?? 0) + (skipped ?? 0);
  return { passed, failed, skipped, total, failures, summaryLine: testsLine ?? passing?.[0] };
}

/** `go test`: counts of "--- FAIL" / "--- PASS" / "=== SKIP" markers. */
function parseGoTest(output: string): ParsedTestResult {
  const fail = (output.match(/^--- FAIL:/gm) ?? []).length;
  const pass = (output.match(/^--- PASS:/gm) ?? []).length;
  const skip = (output.match(/^--- SKIP:/gm) ?? []).length;
  const noTestsBadges = [pass, fail, skip].every((value) => value === 0);
  const ok = findLine(output, /^ok\s/m);
  const failures: ParsedTestFailure[] = [];
  for (const matchFailure of output.matchAll(/^--- FAIL:\s+(\S+)/gm)) {
    const name = matchFailure[1];
    if (name !== undefined) {
      failures.push(failure(name));
    }
  }
  if (noTestsBadges) {
    return { failures: [], summaryLine: ok };
  }
  const total = pass + fail + skip;
  return { passed: pass, failed: fail, skipped: skip, total, failures, summaryLine: ok ?? `--- FAIL markers: ${fail}` };
}

/** `cargo test`: "test result: ok. 5 passed; 0 failed". */
function parseCargo(output: string): ParsedTestResult {
  const match = /test result:\s*\w+\.\s*(\d+)\s+passed;\s*(\d+)\s+failed/i.exec(output);
  if (match === null) {
    return { failures: [] };
  }
  const passed = toInt(match[1]);
  const failed = toInt(match[2]);
  const failures: ParsedTestFailure[] = [];
  for (const matchFailure of output.matchAll(/^test\s+(\S+)\s+\.\.\.\s+FAILED/gm)) {
    if (failures.length >= 40) {
      break;
    }
    failures.push(failure(matchFailure[1] ?? 'unknown'));
  }
  return { passed, failed, total: (passed ?? 0) + (failed ?? 0), failures, summaryLine: match[0] };
}

/** `dotnet test`: "Passed! - Failed: 0, Passed: 3, Skipped: 0". */
function parseDotnet(output: string): ParsedTestResult {
  const match = /(?:Passed|Failed)!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+)/i.exec(output);
  if (match === null) {
    return { failures: [] };
  }
  const failed = toInt(match[1]);
  const passed = toInt(match[2]);
  const skipped = toInt(match[3]);
  return { passed, failed, skipped, total: (passed ?? 0) + (failed ?? 0) + (skipped ?? 0), failures: [], summaryLine: match[0] };
}

/** CTest: "80% tests passed, 2 tests failed out of 10". */
function parseCtest(output: string): ParsedTestResult {
  const match = /(\d+)%\s*tests passed,\s*(\d+)\s*tests? failed out of\s*(\d+)/i.exec(output);
  if (match === null) {
    return { failures: [] };
  }
  const failed = toInt(match[2]);
  const total = toInt(match[3]);
  const passed = total === undefined ? undefined : Math.max(0, total - (failed ?? 0));
  return { passed, failed, total, failures: [], summaryLine: match[0] };
}

/** RSpec: "10 examples, 0 failures". */
function parseRspec(output: string): ParsedTestResult {
  const match = /(\d+)\s+examples?,\s*(\d+)\s+failures?/i.exec(output);
  if (match === null) {
    return { failures: [] };
  }
  const total = toInt(match[1]);
  const failed = toInt(match[2]);
  const passed = total === undefined ? undefined : Math.max(0, total - (failed ?? 0));
  return { passed, failed, total, failures: [], summaryLine: match[0] };
}

/** PHPUnit: "OK (3 tests, 5 assertions)" or "Tests: 3, Assertions: 5, Failures: 1.". */
function parsePhpunit(output: string): ParsedTestResult {
  const ok = /OK\s*\((\d+)\s*tests?,\s*(\d+)\s*assertions?\)/i.exec(output);
  if (ok) {
    const total = toInt(ok[1]);
    return { passed: total, failed: 0, total, failures: [], summaryLine: ok[0] };
  }
  const match = /Tests:\s*(\d+),\s*Assertions:\s*(\d+),\s*Failures:\s*(\d+)/i.exec(output);
  if (match === null) {
    return { failures: [] };
  }
  const total = toInt(match[1]);
  const failed = toInt(match[3]);
  const passed = total === undefined ? undefined : Math.max(0, total - (failed ?? 0));
  return { passed, failed, total, failures: [], summaryLine: match[0] };
}

/** Dart/Flutter: "All tests passed!" or "Some tests failed". */
function parseDart(output: string): ParsedTestResult {
  if (/All tests passed!/i.test(output)) {
    return { passed: undefined, failed: 0, failures: [], summaryLine: 'All tests passed!' };
  }
  const match = /Some tests failed/i.exec(output);
  if (match !== null) {
    return { passed: undefined, failed: undefined, failures: [], summaryLine: match[0] };
  }
  return { failures: [] };
}

/** Swift: "Executed 10 tests, with 0 failures". */
function parseSwift(output: string): ParsedTestResult {
  const match = /Executed\s+(\d+)\s+tests?,\s*with\s*(\d+)\s*failures?/i.exec(output);
  if (match === null) {
    return { failures: [] };
  }
  const total = toInt(match[1]);
  const failed = toInt(match[2]);
  const passed = total === undefined ? undefined : Math.max(0, total - (failed ?? 0));
  return { passed, failed, total, failures: [], summaryLine: match[0] };
}

/**
 * Karkain test output has no stable machine format yet (the conformance
 * corpus reports via `PASS`/`FAIL` markers); parse those conservatively.
 */
function parseKarkain(output: string): ParsedTestResult {
  const failCount = (output.match(/^FAIL\b/gm) ?? []).length;
  const passCount = (output.match(/^PASS\b/gm) ?? []).length;
  if (failCount === 0 && passCount === 0) {
    return { failures: [] };
  }
  const failures: ParsedTestFailure[] = [];
  for (const matchFailure of output.matchAll(/^FAIL\s+(\S+)/gm)) {
    if (failures.length >= 40) {
      break;
    }
    failures.push(failure(matchFailure[1] ?? 'unknown'));
  }
  return {
    passed: passCount,
    failed: failCount,
    total: passCount + failCount,
    failures,
    summaryLine: `${passCount} PASS, ${failCount} FAIL`,
  };
}

export type TestOutputFormat =
  | 'junit'
  | 'pytest'
  | 'node'
  | 'go'
  | 'cargo'
  | 'dotnet'
  | 'ctest'
  | 'rspec'
  | 'phpunit'
  | 'dart'
  | 'swift'
  | 'karkain'
  | 'unknown';

const PARSERS: Readonly<Record<Exclude<TestOutputFormat, 'unknown'>, (output: string) => ParsedTestResult>> = {
  junit: parseJunit,
  pytest: parsePytest,
  node: parseNodeRunner,
  go: parseGoTest,
  cargo: parseCargo,
  dotnet: parseDotnet,
  ctest: parseCtest,
  rspec: parseRspec,
  phpunit: parsePhpunit,
  dart: parseDart,
  swift: parseSwift,
  karkain: parseKarkain,
};

export function parseTestOutput(output: string, format: TestOutputFormat): ParsedTestResult {
  if (format === 'unknown') {
    return { failures: [] };
  }
  return PARSERS[format](output.slice(-120_000));
}

export const TEST_OUTPUT_FORMATS: readonly TestOutputFormat[] = [
  'junit',
  'pytest',
  'node',
  'go',
  'cargo',
  'dotnet',
  'ctest',
  'rspec',
  'phpunit',
  'dart',
  'swift',
  'karkain',
  'unknown',
];
