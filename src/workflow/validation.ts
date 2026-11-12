/**
 * Validation planning and outcome summarization.
 *
 * Proposes which commands *could* validate the change — grounded strictly in
 * what was detected in the workspace (detected adapters, tsconfig/eslint
 * markers, language inventory). Nothing is invented, nothing is executed:
 * execution stays behind the existing approval-gated command runner with its
 * allowlist, workspace trust, cancellation and output limits.
 */
import type { BuildAdapterDetection } from '../build/types';
import type { LanguageInventory } from '../languages/inventory';

export type ValidationOutcome =
  | 'not-run'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'blocked'
  | 'inconclusive';

export type ValidationToolKind = 'build' | 'test' | 'typecheck' | 'lint' | 'manual';

export interface ValidationPlanStep {
  readonly id: string;
  readonly tool: ValidationToolKind;
  /** Proposed command, only when an adapter provided one exactly; otherwise undefined. */
  readonly command?: string;
  readonly reason: string;
  readonly evidence: 'detected' | 'heuristic' | 'unknown';
  readonly required: boolean;
}

export interface ValidationPlan {
  readonly steps: readonly ValidationPlanStep[];
  readonly notes: readonly string[];
  /** 'unknown' when no tooling was detected at all. */
  readonly detection: 'confirmed' | 'heuristic' | 'unknown';
}

export interface ValidationPlanInput {
  readonly detections: readonly BuildAdapterDetection[];
  readonly inventory?: LanguageInventory;
  readonly hints?: { readonly eslintConfig?: boolean; readonly tsconfig?: boolean };
}

export function buildValidationPlan(input: ValidationPlanInput): ValidationPlan {
  const steps: ValidationPlanStep[] = [];
  const notes: string[] = [];
  let id = 0;
  const push = (step: Omit<ValidationPlanStep, 'id'>): void => {
    id += 1;
    steps.push({ ...step, id: `validation-${id}` });
  };

  for (const detection of input.detections) {
    const buildCommands = detection.adapter.buildCommands();
    const testCommands = detection.adapter.testCommands();
    for (const command of buildCommands.slice(0, 2)) {
      push({
        tool: 'build',
        command,
        reason: `Builds ${detection.adapter.ecosystem} (detected from ${detection.configFile}).`,
        evidence: 'detected',
        required: false,
      });
    }
    for (const command of testCommands.slice(0, 2)) {
      push({
        tool: 'test',
        command,
        reason: `Runs the project's own test suite (detected from ${detection.configFile}).`,
        evidence: 'detected',
        required: true,
      });
    }
  }

  if (input.hints?.eslintConfig === true) {
    notes.push('An ESLint configuration is present; if an approved lint script exists (for example in package.json), running it is a reasonable focused check. The command itself must come from the user or the repository tooling — none is assumed here.');
  }
  if (input.hints?.tsconfig === true) {
    notes.push('A tsconfig.json is present; `npx tsc --noEmit` is the conventional type-check, but it is only proposed, never run automatically and only valid when TypeScript is installed.');
  }

  const languageTestHints = (input.inventory?.languages ?? [])
    .map((language) => language.id)
    .filter(Boolean);
  if (steps.length === 0) {
    if (languageTestHints.length === 0) {
      notes.push('No build system, test runner or language tooling was detected. Do not guess commands; inspect the project or ask the user how verification is expected to be performed.');
    } else {
      notes.push(`Tooling for ${languageTestHints.slice(0, 6).join(', ')} is not directly detected; the commands above are absent rather than guessed. Focused checks depend on the repository's own tooling.`);
    }
  }

  const detection = steps.length > 0 ? 'confirmed' : input.hints?.tsconfig === true || input.hints?.eslintConfig === true ? 'heuristic' : 'unknown';
  return { steps: steps.slice(0, 12), notes: notes.slice(0, 8), detection };
}

// ---------------------------------------------------------------------------
// Outcome summarization
// ---------------------------------------------------------------------------

export interface ValidationStepResult {
  readonly outcome: ValidationOutcome;
  readonly detail?: string;
}

/**
 * Rolls step results into one status. Rules (first match wins):
 * - all results are `not-run` (or there are none) -> `not-run`
 * - any `failed` -> `failed`
 * - any `blocked` (approval/trust/runner refused) -> `blocked`
 * - any `inconclusive` (e.g. timeout mid-run without a verdict) -> `inconclusive`
 * - all `skipped` -> `skipped`
 * - at least one `passed`, nothing failing/blocked/inconclusive -> `passed`
 */
export function summarizeValidation(results: readonly ValidationStepResult[]): ValidationOutcome {
  if (results.length === 0 || results.every((result) => result.outcome === 'not-run')) {
    return 'not-run';
  }
  if (results.some((result) => result.outcome === 'failed')) {
    return 'failed';
  }
  if (results.some((result) => result.outcome === 'blocked')) {
    return 'blocked';
  }
  if (results.some((result) => result.outcome === 'inconclusive')) {
    return 'inconclusive';
  }
  if (results.every((result) => result.outcome === 'skipped')) {
    return 'skipped';
  }
  if (results.every((result) => result.outcome === 'passed')) {
    return 'passed';
  }
  // Mixed skipped/passed with nothing failing: the essential checks may have
  // been skipped by the user — report inconclusive rather than claim success.
  return 'inconclusive';
}
