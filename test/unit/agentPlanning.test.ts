import { expect } from 'chai';
import type { ProjectContext, Requirement } from '../../src/agent/models';
import {
  buildDevelopmentPlanMessages,
  parseDevelopmentPlan,
} from '../../src/agent/planning';

const OPTIONS = {
  requirementId: 'req-1',
  planId: 'plan-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  allowlist: ['npm test', 'npm run compile'],
};

const CONTEXT: ProjectContext = {
  rootName: 'demo',
  languages: [],
  packageManager: 'npm',
  scripts: { test: 'mocha' },
  configFiles: ['package.json'],
  modules: [],
  entryPoints: [],
  testFiles: 1,
  facts: [],
  summaryText: 'Workspace demo uses npm.',
};

const REQUIREMENT: Requirement = {
  id: 'req-1',
  text: 'Add a greeting helper',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function plan(tasks: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ summary: 'Plan', approach: 'Do it', tasks });
}

suite('development plan parser', () => {
  test('accepts a valid plan and keeps allowlisted validation commands', () => {
    const parsed = parseDevelopmentPlan(
      plan([
        {
          id: 'task-1',
          title: 'Add helper',
          description: 'Create the helper.',
          dependsOn: [],
          suggestedFiles: ['src/greet.ts'],
          validationCommand: 'npm test',
          criteria: [{ text: 'test passes', verification: 'command' }],
        },
      ]),
      OPTIONS,
    );
    expect(parsed.errors).to.deep.equal([]);
    expect(parsed.plan?.tasks).to.have.length(1);
    expect(parsed.plan?.tasks[0].validationCommand).to.equal('npm test');
    expect(parsed.plan?.requirementId).to.equal('req-1');
    expect(parsed.plan?.tasks[0].acceptanceCriteria[0].verification).to.equal('command');
  });

  test('drops unsafe paths and non-allowlisted commands with warnings', () => {
    const parsed = parseDevelopmentPlan(
      plan([
        {
          id: 'task-1',
          title: 'Sneaky',
          dependsOn: [],
          suggestedFiles: ['../outside.ts', '/etc/passwd'],
          validationCommand: 'npm publish',
        },
      ]),
      OPTIONS,
    );
    expect(parsed.plan?.tasks[0].suggestedFiles).to.deep.equal([]);
    expect(parsed.plan?.tasks[0].validationCommand).to.equal(undefined);
    expect(parsed.plan?.warnings.join(' ')).to.match(/unsafe file path/);
    expect(parsed.plan?.warnings.join(' ')).to.match(/not allowlisted/);
  });

  test('rejects duplicate ids, unknown dependencies and cycles', () => {
    expect(
      parseDevelopmentPlan(plan([{ id: 'task-1', title: 'A' }, { id: 'task-1', title: 'B' }]), OPTIONS)
        .errors.join(' '),
    ).to.match(/more than once/);
    expect(
      parseDevelopmentPlan(plan([{ id: 'task-1', title: 'A', dependsOn: ['nope'] }]), OPTIONS)
        .errors.join(' '),
    ).to.match(/unknown task/);
    expect(
      parseDevelopmentPlan(
        plan([
          { id: 'a', title: 'A', dependsOn: ['b'] },
          { id: 'b', title: 'B', dependsOn: ['a'] },
        ]),
        OPTIONS,
      ).errors.join(' '),
    ).to.match(/cycle/);
  });

  test('returns an empty but valid plan when no tasks are proposed', () => {
    const parsed = parseDevelopmentPlan(plan([]), OPTIONS);
    expect(parsed.errors).to.deep.equal([]);
    expect(parsed.plan?.tasks).to.deep.equal([]);
    expect(parsed.plan?.warnings.join(' ')).to.match(/no tasks/);
  });

  test('fails closed on malformed model output', () => {
    expect(parseDevelopmentPlan('not json', OPTIONS).errors).to.have.length(1);
    expect(parseDevelopmentPlan('{"summary":"x"}', OPTIONS).errors[0]).to.match(/tasks array/);
  });

  test('buildDevelopmentPlanMessages labels workspace content as untrusted data', () => {
    const messages = buildDevelopmentPlanMessages({
      requirement: REQUIREMENT,
      context: CONTEXT,
      items: [],
    });
    expect(messages[0].role).to.equal('system');
    expect(messages[0].content).to.match(/untrusted reference data/);
    expect(messages[1].content).to.contain('<workspace_context>');
    expect(messages[1].content).to.contain('Add a greeting helper');
  });
});
