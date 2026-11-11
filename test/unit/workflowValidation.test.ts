import { expect } from 'chai';
import { buildValidationPlan, summarizeValidation, type ValidationStepResult } from '../../src/workflow/validation';
import { detectBuildAdapters } from '../../src/build/adapters';

const npmWorkspace = [{ path: 'package.json' }, { path: 'src/a.ts' }];

suite('validation plan (grounded in detected tooling)', () => {
  test('detected npm tooling proposes npm build and test commands', () => {
    const detections = detectBuildAdapters(npmWorkspace);
    const plan = buildValidationPlan({ detections });

    const tools = plan.steps.map((step) => step.tool);
    expect(tools).to.contain('build');
    expect(tools).to.contain('test');
    expect(plan.steps.every((step) => step.evidence === 'detected')).to.equal(true);
    expect(plan.steps.find((step) => step.tool === 'test')?.command).to.equal('npm test');
    expect(plan.detection).to.equal('confirmed');
  });

  test('detected tooling marks its test command as required', () => {
    const plan = buildValidationPlan({ detections: detectBuildAdapters(npmWorkspace) });

    expect(plan.steps.find((step) => step.tool === 'test')?.required).to.equal(true);
  });

  test('no detections yields no steps and an honest note instead of invented commands', () => {
    const plan = buildValidationPlan({ detections: [] });

    expect(plan.steps).to.deep.equal([]);
    expect(plan.detection).to.equal('unknown');
    expect(plan.notes.some((note) => note.includes('Do not guess commands'))).to.equal(true);
  });

  test('eslint and tsconfig markers add heuristic notes, never commands', () => {
    const plan = buildValidationPlan({
      detections: [],
      hints: { eslintConfig: true, tsconfig: true },
    });

    expect(plan.steps).to.deep.equal([]);
    expect(plan.notes.some((note) => note.toLowerCase().includes('eslint'))).to.equal(true);
    expect(plan.notes.some((note) => note.includes('tsconfig'))).to.equal(true);
    expect(plan.detection).to.equal('heuristic');
  });

  test('the plan is bounded', () => {
    const plan = buildValidationPlan({ detections: detectBuildAdapters(npmWorkspace) });

    expect(plan.steps.length).to.be.lessThanOrEqual(12);
    expect(plan.notes.length).to.be.lessThanOrEqual(8);
  });
});

suite('validation outcome summarization', () => {
  const result = (outcome: ValidationStepResult['outcome']): ValidationStepResult => ({ outcome });

  test('no executions report not-run', () => {
    expect(summarizeValidation([])).to.equal('not-run');
    expect(summarizeValidation([result('not-run')])).to.equal('not-run');
  });

  test('all passed report passed', () => {
    expect(summarizeValidation([result('passed'), result('passed')])).to.equal('passed');
  });

  test('a failure always dominates', () => {
    expect(summarizeValidation([result('passed'), result('failed')])).to.equal('failed');
    expect(summarizeValidation([result('blocked'), result('failed')])).to.equal('failed');
  });

  test('blocked dominates passed and inconclusive', () => {
    expect(summarizeValidation([result('passed'), result('blocked')])).to.equal('blocked');
  });

  test('inconclusive reports mixed or unresolved executions', () => {
    expect(summarizeValidation([result('passed'), result('skipped')])).to.equal('inconclusive');
    expect(summarizeValidation([result('inconclusive'), result('passed')])).to.equal('inconclusive');
  });

  test('all skipped reports skipped', () => {
    expect(summarizeValidation([result('skipped'), result('skipped')])).to.equal('skipped');
  });
});
