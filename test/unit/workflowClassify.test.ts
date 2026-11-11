import { expect } from 'chai';
import { classifyTaskCategory, shouldUseStructuredPlan } from '../../src/workflow/classify';

suite('workflow task category classification', () => {
  const cases: readonly [string, string][] = [
    ['Fix the null pointer crash in the parser', 'bugfix'],
    ['The login flow is broken; fix it', 'bugfix'],
    ['Add support for SAML login', 'feature'],
    ['Implement the webhook retry queue', 'feature'],
    ['Refactor the payment module into smaller helpers', 'refactor'],
    ['Rename the user service across the codebase', 'refactor'],
    ['Write unit tests for the scheduler', 'test'],
    ['Raise test coverage for the registry', 'test'],
    ['Update the README with the new settings', 'docs'],
    ['Add API documentation for the websocket channel', 'docs'],
    ['Bump the lockfile and upgrade vitest', 'dependency'],
    ['Upgrade npm dependencies to latest', 'dependency'],
    ['Change the GraphQL schema for the accounts service', 'cross-language'],
    ['Update the OpenAPI contract and the frontend client', 'cross-language'],
    ['Reformat this file', 'other'],
  ];

  for (const [task, expected] of cases) {
    test(`maps "${task.slice(0, 48)}" to ${expected}`, () => {
      expect(classifyTaskCategory(task).category).to.equal(expected);
    });
  }

  test('ambiguous tasks degrade to other with heuristic confidence', () => {
    const classification = classifyTaskCategory('tinker with stuff');

    expect(classification.category).to.equal('other');
    expect(classification.confidence).to.equal('heuristic');
  });

  test('strong keywords confirm the category', () => {
    expect(classifyTaskCategory('Fix the crash').confidence).to.equal('confirmed');
  });
});

suite('structured vs simple task routing', () => {
  test('simple, single-purpose questions bypass structured planning', () => {
    for (const task of ['What does this function do?', 'Explain the undo flow', 'Rename this local variable x to count']) {
      const routing = shouldUseStructuredPlan(task);
      expect(routing.required, task).to.equal(false);
    }
  });

  test('empty tasks are not structured work', () => {
    expect(shouldUseStructuredPlan('').required).to.equal(false);
  });

  test('multi-file signals route to structured planning', () => {
    const routing = shouldUseStructuredPlan('Refactor the authentication module across all files');

    expect(routing.required).to.equal(true);
    expect(routing.multiFileSignals.length).to.be.greaterThan(0);
  });

  test('naming multiple paths routes to structured planning', () => {
    const routing = shouldUseStructuredPlan('Align src/types/user.ts and src/schema/user.sql with the new contract');

    expect(routing.required).to.equal(true);
    expect(routing.reasons.some((reason) => reason.includes('file paths'))).to.equal(true);
  });

  test('multi-language tasks route to structured planning', () => {
    const routing = shouldUseStructuredPlan('Translate the helpers from worker.py to worker.ts');

    expect(routing.required).to.equal(true);
    expect(routing.reasons.some((reason) => reason.includes('multiple languages'))).to.equal(true);
  });

  test('long tasks route to structured planning', () => {
    const long = 'Please carefully review the entire build pipeline configuration in this repository and then '.repeat(6) + 'report on the fragility of each step and propose a plan.';
    expect(shouldUseStructuredPlan(long).required).to.equal(true);
  });

  test('refactor/dependency/cross-language categories route to structured planning', () => {
    expect(shouldUseStructuredPlan('Rename all occurrences of the legacyHelper export').required).to.equal(true);
    expect(shouldUseStructuredPlan('Bump axios to the latest version').required).to.equal(true);
    expect(shouldUseStructuredPlan('Change the graphql schema and clients').required).to.equal(true);
  });

  test('docs-only one-offs stay simple', () => {
    expect(shouldUseStructuredPlan('Fix a typo in the readme').required).to.equal(false);
  });

  test('cross-language category is detected for schema/contract tasks', () => {
    expect(classifyTaskCategory('Update the GraphQL schema for accounts').category).to.equal('cross-language');
  });
});
