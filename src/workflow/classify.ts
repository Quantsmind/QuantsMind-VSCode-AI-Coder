/**
 * Task classification and structured-plan routing.
 *
 * Deliberately cheap and deterministic: these signals only decide whether a
 * task warrants a structured, reviewable plan and which category it belongs
 * to. They never block anything.
 */
import type { StructuredPlanRouting, TaskClassification, WorkflowCategory } from './model';

interface CategoryTable {
  readonly category: WorkflowCategory;
  /** Strong single-signal keywords; a match is 'confirmed'. */
  readonly strong: readonly string[];
  /** Supporting keywords; two or more matches also confirm. */
  readonly supporting: readonly string[];
}

const CATEGORIES: readonly CategoryTable[] = [
  { category: 'bugfix', strong: ['bug', 'fix', 'error', 'broken', 'crash', 'regression'], supporting: ['failing', 'incorrect', 'wrong', 'debug', 'hotfix'] },
  { category: 'feature', strong: ['feature', 'implement', 'add support', 'new capability', 'add '], supporting: ['make it', 'enable', 'support', 'allow', 'introduce'] },
  { category: 'refactor', strong: ['refactor', 'restructure', 'reorganize', 'rename', 'simplify'], supporting: ['cleanup', 'clean up', 'extract', 'move files', 'dedupe', 'deduplicate'] },
  { category: 'test', strong: ['unit test', 'integration test', 'test case', 'test suite', 'spec'], supporting: ['coverage', 'xunit', 'jest', 'pytest', 'test file'] },
  { category: 'docs', strong: ['documentation', 'readme', 'docs'], supporting: ['comment', 'api doc', 'changelog', 'guide'] },
  { category: 'dependency', strong: ['upgrade', 'bump', 'dependency', 'dependencies'], supporting: ['package', 'lockfile', 'npm', 'pnpm', 'yarn', 'update version'] },
  { category: 'cross-language', strong: ['openapi', 'graphql', 'grpc', 'protobuf', 'schema change', 'api contract'], supporting: ['across', 'both', 'frontend and backend', 'sql and', 'contract', 'migration'] },
];

function matches(task: string, keywords: readonly string[]): string[] {
  const lower = task.toLowerCase();
  return keywords.filter((keyword) => lower.includes(keyword));
}

/** Classifies the task into one of the supported categories. Defaults to 'other'. */
export function classifyTaskCategory(task: string): TaskClassification {
  const text = typeof task === 'string' ? task : '';
  let best: { category: WorkflowCategory; matched: string[]; confirmed: boolean } | undefined;

  for (const table of CATEGORIES) {
    const strongHits = matches(text, table.strong);
    const supportHits = matches(text, table.supporting);
    const confirmed = strongHits.length > 0 || supportHits.length >= 2;
    const matched = [...strongHits, ...supportHits];
    if (matched.length === 0) {
      continue;
    }
    const confirmedCount = strongHits.length * 2 + supportHits.length;
    if (best === undefined || confirmedCount > best.matched.length) {
      best = { category: table.category, matched, confirmed };
    }
  }

  if (best === undefined) {
    return { category: 'other', confidence: 'heuristic', matched: [] };
  }
  return {
    category: best.category,
    confidence: best.confirmed ? 'confirmed' : 'heuristic',
    matched: best.matched,
  };
}

// ---------------------------------------------------------------------------
// Simple vs structured routing
// ---------------------------------------------------------------------------

const MULTI_FILE_SIGNALS: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  { pattern: /\b(file|files|module|modules|component|components|package|packages)\b/i, reason: 'mentions files or modules' },
  { pattern: /\b(all|every|each|across|whole|entire)\b/i, reason: 'spans multiple targets' },
  { pattern: /\b(refactor|restructure|migrate|migration|reorganize|extract)\b/i, reason: 'restructuring the codebase' },
  { pattern: /\b(frontend|backend|api|schema|database|deploy|ci|pipeline|release)\b/i, reason: 'crosses architectural boundaries' },
  { pattern: /\b(multiple|several|various)\b/i, reason: 'explicitly plural scope' },
  { pattern: /\.(ts|tsx|js|py|java|go|rs|c|cpp|cs|kt|swift|php|rb|sql|yaml|yml|json|toml)\b/i, reason: 'names concrete file types' },
];

/**
 * Decides whether a task warrants a structured, reviewable plan. Short,
 * single-purpose questions never do; anything with multi-file, multi-language
 * or restructuring signals does. Deliberately conservative in both directions.
 */
export function shouldUseStructuredPlan(task: string): StructuredPlanRouting {
  const text = typeof task === 'string' ? task.trim() : '';
  const reasons: string[] = [];
  const multiFileSignals: string[] = [];

  if (text.length === 0) {
    return { required: false, reasons: ['empty task'], multiFileSignals: [] };
  }

  const pathMatches = text.match(/\b[\w./-]+\.(?:ts|tsx|js|jsx|py|java|go|rs|c|cc|cpp|cxx|cs|kt|kts|swift|php|rb|sql|yaml|yml|json|toml|md|sh)\b/gi) ?? [];
  const distinctExtensions = new Set(
    pathMatches.map((match) => match.split('.').pop()?.toLowerCase() ?? '').filter(Boolean),
  );

  for (const { pattern, reason } of MULTI_FILE_SIGNALS) {
    if (pattern.test(text)) {
      multiFileSignals.push(reason);
      reasons.push(reason);
    }
  }

  if (pathMatches.length >= 2) {
    reasons.push(`mentions ${pathMatches.length} file paths`);
  }
  if (distinctExtensions.size >= 2) {
    reasons.push(`spans multiple languages (${[...distinctExtensions].slice(0, 4).join(', ')})`);
  }
  const taskWords = text.split(/\s+/).filter((word) => word.length > 0);
  if (text.length > 240 || taskWords.length > 40) {
    reasons.push('substantial task (longer than 240 characters or 40 words)');
  }

  const classification = classifyTaskCategory(text);
  const planningCategories: readonly WorkflowCategory[] = ['test', 'dependency', 'cross-language'];
  if (planningCategories.includes(classification.category) && classification.matched.length > 0) {
    reasons.push(`matches the ${classification.category} category`);
  } else if (classification.category === 'refactor' && multiFileSignals.length > 0 && classification.matched.length > 0) {
    reasons.push('matches the refactor category with multi-file scope');
  }

  // Duplicates accumulate nothing; the first reason is enough to trigger.
  return {
    required: reasons.length > 0,
    reasons: [...new Set(reasons)].slice(0, 8),
    multiFileSignals: [...new Set(multiFileSignals)].slice(0, 6),
  };
}
