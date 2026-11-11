/**
 * Planned vs actual change scope.
 *
 * "Expected file list vs the files the session actually changed" drives
 * partial completion, scope-expansion detection and honest reporting. No
 * silent out-of-scope edits are possible: out-of-scope applied files are
 * flagged, and files expected but never applied are reported as missing.
 */
import { normalizeChangePath } from '../changes/model';

export interface ScopeCheck {
  /** Files applied that the plan did not expect. */
  readonly unexpected: readonly string[];
  /** Files the plan expected but were never applied. */
  readonly missing: readonly string[];
  /** Files applied that were expected. */
  readonly matched: readonly string[];
  /** True when any applied file was out of scope. */
  readonly scopeExpanded: boolean;
  /** True when every expected file was applied and nothing unexpected was applied. */
  readonly complete: boolean;
}

function normalizeList(list: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const normalized = normalizeChangePath(raw);
    if (normalized === undefined) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export function checkChangeScope(
  expected: readonly string[],
  actual: readonly string[],
): ScopeCheck {
  const expectedPaths = normalizeList(expected);
  const actualPaths = normalizeList(actual);
  const expectedSet = new Set(expectedPaths.map((path) => path.toLowerCase()));
  const actualSet = new Set(actualPaths.map((path) => path.toLowerCase()));

  const unexpected = actualPaths.filter((path) => !expectedSet.has(path.toLowerCase()));
  const missing = expectedPaths.filter((path) => !actualSet.has(path.toLowerCase()));
  const matched = actualPaths.filter((path) => expectedSet.has(path.toLowerCase()));

  return {
    unexpected,
    missing,
    matched,
    scopeExpanded: unexpected.length > 0,
    complete: unexpected.length === 0 && missing.length === 0,
  };
}

/** Scope status for one task's report row: planned (0 applied), partial or complete. */
export type TaskCompletionStatus = 'planned-not-applied' | 'partial' | 'complete';

export function taskCompletionStatus(
  expected: readonly string[],
  applied: readonly string[],
): TaskCompletionStatus {
  const check = checkChangeScope(expected, applied);
  if (check.matched.length === 0 && check.missing.length > 0 && applied.length === 0) {
    return 'planned-not-applied';
  }
  return check.complete ? 'complete' : 'partial';
}
