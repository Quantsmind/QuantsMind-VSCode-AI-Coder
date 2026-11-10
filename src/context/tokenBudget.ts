/**
 * Deterministic budget allocator for prompt context. Candidates are selected
 * by pinned status, density (score per token) and score; excluded candidates
 * carry a reason so the user can see what was cut and why.
 */
export interface BudgetCandidate {
  readonly id: string;
  readonly score: number;
  readonly estimatedTokens: number;
  readonly pinned?: boolean;
}

export interface BudgetAllocation {
  readonly id: string;
  readonly estimatedTokens: number;
  readonly reason: 'pinned' | 'selected';
}

export interface ExcludedCandidate {
  readonly id: string;
  readonly estimatedTokens: number;
  readonly reason: 'excluded' | 'exceeds-budget';
}

export interface BudgetReport {
  readonly budgetTokens: number;
  readonly usedTokens: number;
  readonly remainingTokens: number;
  readonly included: readonly BudgetAllocation[];
  readonly excluded: readonly ExcludedCandidate[];
}

export const ESTIMATED_CHARS_PER_TOKEN = 4;

/** Rough, deterministic tokenizer-free estimate (chars/4); providers are exact when they report usage. */
export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN));
}

function clampCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(Math.floor(value), 1e12);
}

function sanitizeCandidate(candidate: BudgetCandidate): BudgetCandidate {
  return {
    id: String(candidate.id).slice(0, 256),
    score: Number.isFinite(candidate.score) ? candidate.score : 0,
    estimatedTokens: clampCount(candidate.estimatedTokens),
    ...(candidate.pinned === true ? { pinned: true } : {}),
  };
}

/**
 * Pinned candidates are always included (in input order) and never cut.
 * The remainder is filled greedily by score-per-token, breaking ties by id,
 * then by descending raw score. Candidates that do not fit are excluded with
 * a reason; pinned candidates that overflow the budget alone are reported as
 * exceeding the budget.
 */
export function allocateBudget(
  candidates: readonly BudgetCandidate[],
  budgetTokens: number,
): BudgetReport {
  const budget = clampCount(budgetTokens);
  const included: BudgetAllocation[] = [];
  const excluded: ExcludedCandidate[] = [];
  let remaining = budget;

  const sanitized = candidates.map(sanitizeCandidate);
  const seen = new Set<string>();
  const unique = sanitized.filter((candidate) => {
    if (seen.has(candidate.id)) {
      return false;
    }
    seen.add(candidate.id);
    return true;
  });

  const pinned = unique.filter((candidate) => candidate.pinned === true);
  const rest = unique
    .filter((candidate) => candidate.pinned !== true)
    .slice()
    .sort((left, right) => {
      const leftDensity = left.estimatedTokens === 0 ? 0 : left.score / left.estimatedTokens;
      const rightDensity = right.estimatedTokens === 0 ? 0 : right.score / right.estimatedTokens;
      if (leftDensity !== rightDensity) {
        return rightDensity - leftDensity;
      }
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });

  for (const candidate of pinned) {
    included.push({ id: candidate.id, estimatedTokens: candidate.estimatedTokens, reason: 'pinned' });
    remaining -= candidate.estimatedTokens;
  }

  for (const candidate of rest) {
    if (candidate.estimatedTokens <= remaining) {
      included.push({ id: candidate.id, estimatedTokens: candidate.estimatedTokens, reason: 'selected' });
      remaining -= candidate.estimatedTokens;
    } else {
      excluded.push({ id: candidate.id, estimatedTokens: candidate.estimatedTokens, reason: 'exceeds-budget' });
    }
  }

  const usedTokens = budget - remaining;
  return {
    budgetTokens: budget,
    usedTokens: Math.max(0, usedTokens),
    remainingTokens: remaining,
    included,
    excluded,
  };
}

/** Renders the report for display; never includes candidate contents. */
export function describeAllocation(report: BudgetReport, label = 'context'): string {
  const includedIds = report.included.map((entry) => entry.id);
  const excludedCount = report.excluded.length;
  return (
    `${label}: ${report.included.length} item(s), ~${report.usedTokens}/${report.budgetTokens} tokens` +
    (excludedCount > 0 ? `, ${excludedCount} excluded` : '') +
    (includedIds.length > 0 ? `\nincluded: ${includedIds.slice(0, 20).join(', ')}${includedIds.length > 20 ? ', …' : ''}` : '')
  );
}
