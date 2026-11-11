/**
 * Execution budgets for prepared change sets (WP7).
 *
 * Enforced before an approval request is ever made: an oversized change set
 * never reaches the user's desk as an approvable artifact. This mirrors the
 * engine's refuse-before-dispatch behavior for the chat-agent path.
 */
import { normalizeChangePath } from '../changes/model';

export interface ExecutionBudgetLimits {
  readonly maxChangedFiles: number;
  readonly maxPatchSizeChars: number;
}

export type ChangeSetBudgetResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'changed-files' | 'patch-size'; readonly detail: string; readonly files: number; readonly patchBytes: number };

function kindOf(change: { kind?: unknown }): string {
  return typeof change.kind === 'string' ? change.kind : 'unknown';
}

function contentOf(change: { content?: unknown }): number {
  return typeof change.content === 'string' ? change.content.length : 0;
}

/**
 * Counts distinct workspace-relative paths (rename sources included) and the
 * cumulative content bytes of a proposed change set, and fails over-budget
 * plans outright. Paths that fail normalization are ignored for counting but
 * reported as zero files when they are the only entry.
 */
export function checkChangeSetBudgets(
  changes: readonly { path?: unknown; fromPath?: unknown; kind?: unknown; content?: unknown }[],
  limits: ExecutionBudgetLimits,
): ChangeSetBudgetResult {
  const files = new Set<string>();
  let patchBytes = 0;
  for (const change of changes) {
    const normalized = normalizeChangePath(change.path);
    if (normalized !== undefined) {
      files.add(normalized.toLowerCase());
    }
    if (kindOf(change) === 'rename') {
      const from = normalizeChangePath(change.fromPath);
      if (from !== undefined) {
        files.add(from.toLowerCase());
      }
    }
    patchBytes += contentOf(change);
  }
  if (files.size > limits.maxChangedFiles) {
    return {
      ok: false,
      reason: 'changed-files',
      detail: `${files.size} distinct file(s) exceed the maxChangedFiles limit of ${limits.maxChangedFiles}`,
      files: files.size,
      patchBytes,
    };
  }
  if (patchBytes > limits.maxPatchSizeChars) {
    return {
      ok: false,
      reason: 'patch-size',
      detail: `${patchBytes} characters of content exceed the cumulative patch budget of ${limits.maxPatchSizeChars}`,
      files: files.size,
      patchBytes,
    };
  }
  return { ok: true };
}
