import { expect } from 'chai';
import type { ChangePlan } from '../../src/changes/model';
import {
  bindValidation,
  changeSetVersion,
  deriveValidationSuggestions,
  describeValidationCoverage,
  isValidationBound,
  outcomeOf,
  summarizeValidations,
  unboundPassedCount,
} from '../../src/agent/validation';
import type {
  ChangeSet,
  RepairProposal,
  ValidationOutcome,
  ValidationRun,
} from '../../src/agent/models';

function run(id: string, outcome: ValidationOutcome): ValidationRun {
  return {
    id,
    taskId: 'task-1',
    command: outcome === 'skipped' ? '' : 'npm test',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    outcome,
  };
}

suite('validation command derivation', () => {
  test('offers only scripts the command allowlist already permits', () => {
    const suggestions = deriveValidationSuggestions(
      { test: 'mocha', lint: 'eslint .' },
      ['npm test'],
      'npm',
    );
    expect(suggestions).to.deep.equal(['npm test']);
  });

  test('offers both lifecycle forms when both are allowlisted', () => {
    const suggestions = deriveValidationSuggestions(
      { test: 'mocha' },
      ['npm run test', 'npm test'],
      'npm',
    );
    expect(suggestions).to.deep.equal(['npm test', 'npm run test']);
  });

  test('names non-lifecycle scripts with the run verb', () => {
    const suggestions = deriveValidationSuggestions({ check: 'tsc' }, ['npm run check'], 'npm');
    expect(suggestions).to.deep.equal(['npm run check']);
  });

  test('uses the detected package manager and falls back to npm', () => {
    expect(deriveValidationSuggestions({ test: 'vitest' }, ['pnpm test'], 'pnpm')).to.deep.equal([
      'pnpm test',
    ]);
    expect(deriveValidationSuggestions({ test: 'vitest' }, ['npm test'], 'gradle')).to.deep.equal([
      'npm test',
    ]);
  });

  test('never proposes a command for an unsafe script name', () => {
    const suggestions = deriveValidationSuggestions(
      { 'bad name;rm -rf src': 'echo', 'a;npm test': 'echo', ok: 'mocha' },
      ['npm run ok', 'npm test', 'rm -rf src', 'a;npm test'],
      'npm',
    );
    expect(suggestions).to.deep.equal(['npm run ok']);
  });

  test('caps the picker at eight commands', () => {
    const scripts: Record<string, string> = {};
    const allowlist: string[] = [];
    for (let index = 1; index <= 12; index += 1) {
      scripts[`check-${index}`] = 'echo';
      allowlist.push(`npm run check-${index}`);
    }
    expect(deriveValidationSuggestions(scripts, allowlist, 'npm')).to.have.lengthOf(8);
  });

  test('summarizes recorded checks by outcome instead of a single verdict', () => {
    expect(summarizeValidations([])).to.equal('No validation recorded.');
    const runs = [
      run('run-1', 'passed'),
      run('run-2', 'failed'),
      run('run-3', 'skipped'),
      run('run-4', 'skipped'),
      run('run-5', 'unavailable'),
    ];
    expect(summarizeValidations(runs)).to.equal('1 passed, 1 failed, 2 skipped, 1 unavailable');
    expect(outcomeOf(runs, 'skipped')).to.equal(2);
  });
});

function planWith(entries: ReadonlyArray<readonly [string, string]>): ChangePlan {
  return {
    id: 'plan-1',
    summary: 'Change',
    changes: entries.map(([path, content], index) => ({
      id: `change-${index + 1}`,
      kind: 'create' as const,
      path,
      summary: 'Apply the change.',
      content,
    })),
  };
}

function storedChangeSet(
  id: string,
  entries: ReadonlyArray<readonly [string, string]> = [['src/a.ts', 'export const a = 1;\n']],
): ChangeSet {
  const plan: ChangePlan = planWith(entries);
  const version = changeSetVersion({
    id,
    taskId: 'task-1',
    summary: 'Change',
    plan,
    diffs: [],
    warnings: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    version: '',
    status: 'pending',
  });
  return {
    id,
    taskId: 'task-1',
    summary: 'Change',
    plan: plan,
    diffs: [],
    warnings: [],
    version,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'pending',
  };
}

function storedRepair(
  id: string,
  entries: ReadonlyArray<readonly [string, string]>,
): RepairProposal {
  return {
    id,
    taskId: 'task-1',
    attempt: 1,
    diagnosis: 'The check failed.',
    summary: 'Repair',
    plan: planWith(entries),
    diffs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function boundRun(changeSet: ChangeSet, outcome: ValidationOutcome = 'passed'): ValidationRun {
  return {
    ...run(`run-${changeSet.id}-${outcome}`, outcome),
    changeSetId: changeSet.id,
    changeSetVersion: changeSetVersion(changeSet),
  };
}

suite('validation change-set binding', () => {
  test('versions the written content, not the labels around it', () => {
    const a = storedChangeSet('cs-1');
    const sameContentOtherId = { ...a, id: 'cs-2', summary: 'Renamed summary' };
    const edited = storedChangeSet('cs-3', [['src/a.ts', 'export const a = 2;\n']]);

    expect(changeSetVersion(a)).to.equal(changeSetVersion(sameContentOtherId));
    expect(changeSetVersion(a)).to.not.equal(changeSetVersion(edited));
    expect(changeSetVersion(a)).to.match(/^[0-9a-f]{64}$/);
  });

  test('is order-sensitive so a re-planned change set never inherits an old result', () => {
    const first = storedChangeSet('cs-1', [
      ['src/a.ts', 'export const a = 1;\n'],
      ['src/b.ts', 'export const b = 1;\n'],
    ]);
    const second = storedChangeSet('cs-1', [
      ['src/b.ts', 'export const b = 1;\n'],
      ['src/a.ts', 'export const a = 1;\n'],
    ]);
    expect(changeSetVersion(first)).to.not.equal(changeSetVersion(second));
  });

  test('folds an applied repair into the version it verifies', () => {
    const changeSet = storedChangeSet('cs-1');
    const repair = storedRepair('repair-1', [['src/a.ts', 'export const a = 2;\n']]);
    const withRepair = changeSetVersion(changeSet, repair);

    expect(withRepair).to.not.equal(changeSetVersion(changeSet));
    expect(bindValidation([changeSet], [repair], 'cs-1', 'repair-1')).to.deep.equal({
      changeSetId: 'cs-1',
      changeSetVersion: withRepair,
    });
  });

  test('resolves nothing when the change set or repair is no longer retained', () => {
    const changeSet = storedChangeSet('cs-1');
    const repair = storedRepair('repair-1', [['src/a.ts', 'export const a = 2;\n']]);

    expect(bindValidation([changeSet], [], undefined, undefined)).to.equal(undefined);
    expect(bindValidation([], [], 'cs-1', undefined)).to.equal(undefined);
    expect(bindValidation([changeSet], [], 'cs-1', 'repair-1')).to.equal(undefined);
    expect(bindValidation([changeSet], [repair], 'cs-1', undefined)).to.deep.equal({
      changeSetId: 'cs-1',
      changeSetVersion: changeSetVersion(changeSet),
    });
  });

  test('reads a stale, foreign or unbound result as not verified', () => {
    const tested = storedChangeSet('cs-1');
    const run = boundRun(tested);

    expect(isValidationBound(run, [tested], [])).to.equal(true);
    expect(
      isValidationBound(run, [storedChangeSet('cs-1', [['src/a.ts', 'export const a = 2;\n']])], []),
    ).to.equal(false);
    expect(isValidationBound(run, [storedChangeSet('cs-other')], [])).to.equal(false);
    expect(isValidationBound(run, [], [])).to.equal(false);
    expect(isValidationBound({ ...run, changeSetVersion: undefined }, [tested], [])).to.equal(false);

    const repaired = storedRepair('repair-1', [['src/a.ts', 'export const a = 2;\n']]);
    const repairRun = {
      ...boundRun(tested),
      repairProposalId: 'repair-1',
      changeSetVersion: changeSetVersion(tested, repaired),
    };
    expect(isValidationBound(repairRun, [tested], [repaired])).to.equal(true);
    expect(
      isValidationBound(repairRun, [tested], [storedRepair('repair-1', [['src/a.ts', 'x']])]),
    ).to.equal(false);
    expect(isValidationBound(repairRun, [tested], [])).to.equal(false);
  });

  test('counts and names unbound passes instead of presenting them as verification', () => {
    const tested = storedChangeSet('cs-1');
    const drifted = storedChangeSet('cs-1', [['src/a.ts', 'export const a = 2;\n']]);
    const runs = [boundRun(tested), boundRun(tested, 'failed'), run('run-3', 'skipped')];

    expect(unboundPassedCount(runs, [tested], [])).to.equal(0);
    expect(describeValidationCoverage(runs, [tested], [])).to.equal('1 passed, 1 failed, 1 skipped');

    expect(unboundPassedCount(runs, [drifted], [])).to.equal(1);
    expect(describeValidationCoverage(runs, [drifted], [])).to.equal(
      '1 passed, 1 failed, 1 skipped; 1 passed result(s) no longer bound to a change set',
    );
    expect(describeValidationCoverage([], [], [])).to.equal('No validation recorded.');
  });
});
