import { hashContent, type ChangePlan } from '../changes/model';
import { evaluateCommand } from '../commands/policy';
import {
  clampText,
  type ChangeSet,
  type RepairProposal,
  type ValidationOutcome,
  type ValidationRun,
} from './models';

const MAX_SUGGESTIONS = 8;
const KNOWN_MANAGERS: readonly string[] = ['npm', 'pnpm', 'yarn', 'bun'];
/** Scripts the package manager runs without an explicit `run` argument. */
const LIFECYCLE_SCRIPTS: readonly string[] = ['test', 'start'];

function managerOf(packageManager: string | undefined): string {
  return packageManager !== undefined && KNOWN_MANAGERS.includes(packageManager)
    ? packageManager
    : 'npm';
}

/**
 * Turns the project's own scripts into candidate validation commands. Every
 * candidate still has to clear the command policy, so a script name can never
 * smuggle a command that the user has not allowlisted.
 */
export function deriveValidationSuggestions(
  scripts: Readonly<Record<string, string>>,
  allowlist: readonly string[],
  packageManager?: string,
): string[] {
  const manager = managerOf(packageManager);
  const seen = new Set<string>();
  const suggestions: string[] = [];

  for (const name of Object.keys(scripts).slice(0, 30)) {
    if (!/^[A-Za-z0-9:._-]{1,100}$/.test(name)) {
      continue;
    }
    const candidates =
      LIFECYCLE_SCRIPTS.includes(name) ? [`${manager} ${name}`, `${manager} run ${name}`] : [`${manager} run ${name}`];
    for (const candidate of candidates) {
      const policy = evaluateCommand(candidate, allowlist);
      if (!policy.allowed || policy.normalized === undefined || seen.has(policy.normalized)) {
        continue;
      }
      seen.add(policy.normalized);
      suggestions.push(clampText(policy.normalized, 200));
      if (suggestions.length >= MAX_SUGGESTIONS) {
        return suggestions;
      }
    }
  }
  return suggestions;
}

function planLines(plan: ChangePlan): string[] {
  return plan.changes.map(
    (change) =>
      `${change.kind}|${change.path}|${change.fromPath ?? ''}|${change.expectedHash ?? ''}|${hashContent(
        change.content ?? '',
      )}`,
  );
}

/**
 * The version of what a validation result speaks for: the bytes an approved
 * change set writes, plus the bytes of the repair that was applied on top of it.
 * Re-planning, re-approving or editing any file produces a different version,
 * and it is recomputed from stored data so a restored session proves the same
 * binding rather than inheriting a label.
 */
export function changeSetVersion(changeSet: ChangeSet, repair?: RepairProposal): string {
  const lines = ['change-set', ...planLines(changeSet.plan)];
  if (repair !== undefined) {
    lines.push('repair', ...planLines(repair.plan));
  }
  return hashContent(lines.join('\n'));
}

export interface ValidationBinding {
  readonly changeSetId: string;
  readonly changeSetVersion: string;
}

/**
 * Resolves what a validation result covers. Undefined means the session holds no
 * retained change set (or no retained repair) for the run to speak for, so the
 * result verifies nothing.
 */
export function bindValidation(
  changeSets: readonly ChangeSet[],
  repairProposals: readonly RepairProposal[],
  changeSetId: string | undefined,
  repairProposalId: string | undefined,
): ValidationBinding | undefined {
  if (changeSetId === undefined) {
    return undefined;
  }
  const changeSet = changeSets.find((candidate) => candidate.id === changeSetId);
  if (changeSet === undefined) {
    return undefined;
  }
  if (repairProposalId === undefined) {
    return { changeSetId, changeSetVersion: changeSetVersion(changeSet) };
  }
  const repair = repairProposals.find((candidate) => candidate.id === repairProposalId);
  if (repair === undefined) {
    return undefined;
  }
  return { changeSetId, changeSetVersion: changeSetVersion(changeSet, repair) };
}

/**
 * A recorded result authorizes work only while its binding still resolves to the
 * content it tested. Missing, foreign and re-versioned bindings read as
 * unverified instead of being reused.
 */
export function isValidationBound(
  run: ValidationRun,
  changeSets: readonly ChangeSet[],
  repairProposals: readonly RepairProposal[],
): boolean {
  if (run.changeSetId === undefined || run.changeSetVersion === undefined) {
    return false;
  }
  const bound = bindValidation(
    changeSets,
    repairProposals,
    run.changeSetId,
    run.repairProposalId,
  );
  return bound !== undefined && bound.changeSetVersion === run.changeSetVersion;
}

/** Passed results that no longer resolve to the content they claim to verify. */
export function unboundPassedCount(
  runs: readonly ValidationRun[],
  changeSets: readonly ChangeSet[],
  repairProposals: readonly RepairProposal[],
): number {
  return runs.filter(
    (run) =>
      run.outcome === 'passed' && !isValidationBound(run, changeSets, repairProposals),
  ).length;
}

/** Coverage line that never presents an unbound pass as verification. */
export function describeValidationCoverage(
  runs: readonly ValidationRun[],
  changeSets: readonly ChangeSet[],
  repairProposals: readonly RepairProposal[],
): string {
  if (runs.length === 0) {
    return 'No validation recorded.';
  }
  const summary = summarizeValidations(runs);
  const unbound = unboundPassedCount(runs, changeSets, repairProposals);
  if (unbound === 0) {
    return summary;
  }
  return `${summary}; ${unbound} passed result(s) no longer bound to a change set`;
}

export function outcomeOf(runs: readonly ValidationRun[], outcome: ValidationOutcome): number {
  return runs.filter((run) => run.outcome === outcome).length;
}

/** One-line coverage summary; distinguishes run, skipped and unavailable checks. */
export function summarizeValidations(runs: readonly ValidationRun[]): string {
  if (runs.length === 0) {
    return 'No validation recorded.';
  }
  const passed = outcomeOf(runs, 'passed');
  const failed = outcomeOf(runs, 'failed');
  const skipped = outcomeOf(runs, 'skipped');
  const unavailable = outcomeOf(runs, 'unavailable');
  const parts: string[] = [];
  if (passed > 0) {
    parts.push(`${passed} passed`);
  }
  if (failed > 0) {
    parts.push(`${failed} failed`);
  }
  if (skipped > 0) {
    parts.push(`${skipped} skipped`);
  }
  if (unavailable > 0) {
    parts.push(`${unavailable} unavailable`);
  }
  return parts.join(', ');
}
