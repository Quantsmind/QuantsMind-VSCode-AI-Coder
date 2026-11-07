import { rankRelevantFiles, type WorkspaceEntry } from '../workspace/analyze';
import {
  directDependencies,
  directDependents,
  type DependencyGraph,
} from './graph';
import type { Confidence, FileAnalysis } from './symbols';

export interface ContextSelectionOptions {
  readonly maxFiles: number;
  readonly maxChars: number;
}

export interface SelectedContextFile {
  readonly path: string;
  readonly score: number;
  readonly reason: string;
  readonly relationship:
    | 'query'
    | 'symbol'
    | 'dependent'
    | 'dependency'
    | 'test'
    | 'entry-point'
    | 'public-api';
  readonly confidence: Confidence;
}

export interface RepositoryContextSelection {
  readonly selections: readonly SelectedContextFile[];
  readonly truncated: boolean;
  readonly budgetChars: number;
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'into',
  'please',
  'make',
  'add',
  'fix',
  'update',
  'change',
  'code',
  'file',
  'files',
  'workspace',
  'project',
  'can',
  'you',
  'use',
  'using',
  'what',
  'where',
  'when',
  'how',
  'does',
  'should',
]);

function tokensOf(query: string): string[] {
  const values = query.match(/[A-Za-z0-9_$.-]{2,}/g) ?? [];
  const tokens = new Set<string>();
  for (const value of values) {
    const lower = value.toLowerCase();
    if (!STOP_WORDS.has(lower)) {
      tokens.add(lower);
    }
    const parts = value.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? [];
    for (const part of parts) {
      const normalized = part.toLowerCase();
      if (normalized.length >= 3 && !STOP_WORDS.has(normalized)) {
        tokens.add(normalized);
      }
    }
  }
  return [...tokens].slice(0, 24);
}

function estimatedChars(path: string, analysis: FileAnalysis | undefined, entry: WorkspaceEntry | undefined): number {
  if (analysis !== undefined && analysis.contentChars > 0) {
    return analysis.contentChars;
  }
  if (entry?.size !== undefined && entry.size > 0) {
    return entry.size;
  }
  return path.endsWith('.md') ? 4_000 : 2_000;
}

interface Candidate {
  readonly path: string;
  score: number;
  reasons: string[];
  relationship: SelectedContextFile['relationship'];
  confidence: Confidence;
}

/**
 * Ranks files for provider context using path relevance plus symbol and
 * dependency evidence. Dependency additions are explicitly labelled and never
 * outrank a direct path or symbol match.
 */
export function selectRepositoryContext(
  query: string,
  entries: readonly WorkspaceEntry[],
  analyses: readonly FileAnalysis[],
  graph: DependencyGraph,
  options: ContextSelectionOptions,
): RepositoryContextSelection {
  const maxFiles = Math.max(1, options.maxFiles);
  const maxChars = Math.max(500, options.maxChars);
  const tokens = tokensOf(query);
  const entriesByPath = new Map(entries.map((entry) => [entry.path.replace(/\\/g, '/'), entry]));
  const analysesByPath = new Map(analyses.map((analysis) => [analysis.path, analysis]));
  const candidates = new Map<string, Candidate>();
  let truncated = false;

  const add = (
    path: string,
    score: number,
    reason: string,
    relationship: SelectedContextFile['relationship'],
    confidence: Confidence,
  ): void => {
    const normalized = path.replace(/\\/g, '/');
    if (normalized.length === 0) {
      return;
    }
    const existing = candidates.get(normalized);
    if (existing === undefined) {
      candidates.set(normalized, {
        path: normalized,
        score,
        reasons: [reason],
        relationship,
        confidence,
      });
      return;
    }
    existing.score = Math.max(existing.score, score);
    if (!existing.reasons.includes(reason)) {
      existing.reasons.push(reason);
    }
    if (relationship !== 'query' && existing.relationship === 'query') {
      existing.relationship = relationship;
    }
    if (confidence === 'heuristic') {
      existing.confidence = 'heuristic';
    }
  };

  const base = rankRelevantFiles(query, entries, { maxFiles: Math.max(maxFiles * 2, 8) });
  for (const item of base) {
    add(item.path, item.score, item.reason, 'query', 'heuristic');
  }

  for (const analysis of analyses) {
    let score = 0;
    const reasons: string[] = [];
    for (const token of tokens) {
      const symbol = analysis.symbols.find((candidate) => candidate.name.toLowerCase().includes(token));
      if (symbol !== undefined) {
        score += symbol.exported ? 9 : 7;
        reasons.push(`symbol ${symbol.name} matches the request (${symbol.confidence})`);
        break;
      }
    }
    if (score > 0 && analysis.publicApi) {
      score += 2;
      reasons.push('public API surface');
    }
    if (score > 0) {
      add(
        analysis.path,
        score,
        reasons.join('; '),
        analysis.publicApi ? 'public-api' : 'symbol',
        'heuristic',
      );
    } else if (analysis.publicApi && tokens.length === 0) {
      add(analysis.path, 1, 'public API surface', 'public-api', 'heuristic');
    }
  }

  const ranked = [...candidates.values()]
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, maxFiles);
  for (const candidate of ranked.slice(0, Math.min(6, ranked.length))) {
    for (const edge of directDependencies(graph, candidate.path)) {
      add(
        edge.to,
        2,
        `imported by ${candidate.path} (${edge.confidence})`,
        'dependency',
        edge.confidence,
      );
    }
    for (const edge of directDependents(graph, candidate.path)) {
      add(
        edge.from,
        2,
        `imports ${candidate.path} (${edge.confidence})`,
        'dependent',
        edge.confidence,
      );
    }
  }

  const all = [...candidates.values()]
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const selections: SelectedContextFile[] = [];
  let usedChars = 0;
  for (const candidate of all) {
    if (selections.length >= maxFiles) {
      truncated = true;
      break;
    }
    const size = estimatedChars(
      candidate.path,
      analysesByPath.get(candidate.path),
      entriesByPath.get(candidate.path),
    );
    if (usedChars + size > maxChars) {
      truncated = true;
      continue;
    }
    usedChars += Math.min(size, maxChars);
    selections.push({
      path: candidate.path,
      score: candidate.score,
      reason: candidate.reasons.join('; '),
      relationship: candidate.relationship,
      confidence: candidate.confidence,
    });
  }

  if (selections.length < all.length) {
    truncated = true;
  }

  return {
    selections,
    truncated,
    budgetChars: maxChars,
  };
}

export function explainContextSelection(selection: RepositoryContextSelection): string {
  return selection.selections
    .map(
      (item) =>
        `${item.path}: ${item.reason} (${item.relationship}, ${item.confidence})`,
    )
    .join('\n');
}
