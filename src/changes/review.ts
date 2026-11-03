import { createUnifiedDiff } from './diff';
import type { FileChange } from './model';

export interface ReviewChange {
  readonly id: string;
  readonly kind: FileChange['kind'];
  readonly path: string;
  readonly fromPath?: string;
  readonly summary: string;
  readonly diff: string;
  readonly additions: number;
  readonly deletions: number;
  readonly diffTruncated: boolean;
  readonly warning?: string;
}

export function buildReviewChanges(
  changes: readonly FileChange[],
  beforeByPath: ReadonlyMap<string, string | undefined>,
): ReviewChange[] {
  return changes.map((change) => {
    const before =
      change.kind === 'rename'
        ? beforeByPath.get(change.fromPath ?? '')
        : beforeByPath.get(change.path);
    const after =
      change.kind === 'create' || change.kind === 'modify'
        ? change.content
        : change.kind === 'delete'
          ? undefined
          : before;
    const diff = createUnifiedDiff(
      change.path,
      before,
      after,
      change.fromPath ?? change.path,
    );

    return {
      id: change.id,
      kind: change.kind,
      path: change.path,
      fromPath: change.fromPath,
      summary: change.summary,
      diff: diff.text,
      additions: diff.additions,
      deletions: diff.deletions,
      diffTruncated: diff.truncated,
      warning:
        change.kind === 'create'
          ? before !== undefined
            ? 'A file already exists at this path; apply will refuse to overwrite it.'
            : undefined
          : before === undefined
            ? 'The file does not currently exist in the workspace.'
            : undefined,
    };
  });
}
