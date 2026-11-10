import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Single workspace-root policy for the whole extension.
 *
 * Indexing, retrieval, repository intelligence, summaries, agent file reads and
 * edits, change containment and command working directories must all resolve the
 * SAME folder. Selecting per call site is what let the extension index one root
 * and edit another.
 *
 * Rule: with no folder open there is no root; with one folder that folder is the
 * root; with several folders the one with the most project markers wins. Scores
 * are compared strictly, so a tie is won by the earliest folder in VS Code's
 * workspace order. The marker probe is injectable to keep the rule unit-testable
 * without a real multi-root workspace on disk.
 */
export interface WorkspaceRootCandidate {
  readonly name: string;
  readonly index: number;
  readonly uri: { readonly fsPath: string; toString(): string };
}

export const ROOT_MARKERS: readonly { readonly marker: string; readonly weight: number }[] = [
  { marker: 'package.json', weight: 5 },
  { marker: 'src', weight: 3 },
  { marker: 'docs', weight: 2 },
  { marker: '.git', weight: 2 },
  { marker: 'README.md', weight: 1 },
];

export type RootMarkerProbe = (fsPath: string, marker: string) => boolean;

export const defaultRootMarkerProbe: RootMarkerProbe = (fsPath, marker) => {
  try {
    return fs.existsSync(path.join(fsPath, marker));
  } catch {
    return false;
  }
};

export function scoreWorkspaceRoot(
  folder: WorkspaceRootCandidate,
  probe: RootMarkerProbe = defaultRootMarkerProbe,
): number {
  let score = 0;
  for (const { marker, weight } of ROOT_MARKERS) {
    if (probe(folder.uri.fsPath, marker)) {
      score += weight;
    }
  }
  return score;
}

export function selectWorkspaceRoot<T extends WorkspaceRootCandidate>(
  folders: readonly T[] | undefined,
  probe: RootMarkerProbe = defaultRootMarkerProbe,
): T | undefined {
  if (folders === undefined || folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  const ordered = [...folders].sort((left, right) => left.index - right.index);
  let best = ordered[0];
  let bestScore = scoreWorkspaceRoot(best, probe);
  for (const candidate of ordered.slice(1)) {
    const score = scoreWorkspaceRoot(candidate, probe);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}