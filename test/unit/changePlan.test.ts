import { expect } from 'chai';
import { MAX_CHANGES_PER_PLAN } from '../../src/changes/model';
import {
  buildChangeSystemPrompt,
  buildPlanMessages,
  parseChangePlan,
} from '../../src/changes/plan';
import type { WorkspaceSummary } from '../../src/workspace/analyze';

const SUMMARY: WorkspaceSummary = {
  rootName: 'demo',
  fileCount: 3,
  technologies: [],
  topLevel: [],
  entryPoints: [],
  testFiles: 0,
  text: 'Workspace demo: 3 indexed files.',
};

suite('change plan parsing', () => {
  test('rejects empty, non-JSON, and invalid JSON responses', () => {
    expect(parseChangePlan('').errors).to.deep.equal(['The provider returned an empty plan.']);
    expect(parseChangePlan('I cannot help with that.').errors).to.deep.equal([
      'The provider response did not contain a JSON plan.',
    ]);
    expect(parseChangePlan('{ not json }').errors).to.deep.equal([
      'The provider response contained invalid JSON.',
    ]);
  });

  test('accepts an explicitly empty changes array as an actionable refusal', () => {
    const parsed = parseChangePlan(
      JSON.stringify({ summary: 'Which files should I change?', changes: [] }),
    );
    expect(parsed.errors).to.deep.equal([]);
    expect(parsed.plan?.changes).to.deep.equal([]);
    expect(parsed.plan?.summary).to.equal('Which files should I change?');
  });

  test('rejects a plan without a changes array', () => {
    expect(parseChangePlan('{"summary":"nothing"}').errors).to.deep.equal([
      'The plan did not include a changes array.',
    ]);
  });

  test('parses a fenced JSON plan and ignores surrounding prose', () => {
    const response = [
      'Here is the plan:',
      '```json',
      JSON.stringify({
        summary: 'Add a helper module.',
        notes: 'Run the unit tests afterwards.',
        changes: [
          { kind: 'create', path: 'src/helper.ts', summary: 'new helper', content: 'export {};\n' },
        ],
      }),
      '```',
      'Let me know if you need anything else.',
    ].join('\n');
    const parsed = parseChangePlan(response);
    expect(parsed.errors).to.deep.equal([]);
    expect(parsed.plan?.summary).to.equal('Add a helper module.');
    expect(parsed.plan?.notes).to.equal('Run the unit tests afterwards.');
    expect(parsed.plan?.changes).to.have.length(1);
    expect(parsed.plan?.changes[0].id).to.equal('change-1');
    expect(parsed.plan?.changes[0].content).to.equal('export {};\n');
  });

  test('accepts the edits and files aliases and alternate field names', () => {
    const viaEdits = parseChangePlan(
      JSON.stringify({
        summary: 'Edit one file',
        edits: [{ kind: 'modify', file: 'src/a.ts', text: 'next\n', rationale: 'why' }],
      }),
    );
    expect(viaEdits.errors).to.deep.equal([]);
    expect(viaEdits.plan?.changes[0].path).to.equal('src/a.ts');
    expect(viaEdits.plan?.changes[0].summary).to.equal('why');

    const viaFiles = parseChangePlan(
      JSON.stringify({
        summary: 'Rename one file',
        files: [{ kind: 'rename', from: 'src/a.ts', to: 'src/b.ts' }],
      }),
    );
    expect(viaFiles.errors).to.deep.equal([]);
    expect(viaFiles.plan?.changes[0].fromPath).to.equal('src/a.ts');
    expect(viaFiles.plan?.changes[0].path).to.equal('src/b.ts');
  });

  test('fails closed on malformed change entries', () => {
    expect(
      parseChangePlan(JSON.stringify({ summary: 'x', changes: [{ path: 'src/a.ts' }] })).errors,
    ).to.deep.equal(['One or more proposed changes were malformed.']);
    expect(
      parseChangePlan(JSON.stringify({ summary: 'x', changes: ['nope'] })).errors,
    ).to.deep.equal(['One or more proposed changes were malformed.']);
  });

  test('surfaces path validation errors from the change model', () => {
    const parsed = parseChangePlan(
      JSON.stringify({
        summary: 'escape',
        changes: [{ kind: 'create', path: '../outside.ts', content: 'x' }],
      }),
    );
    expect(parsed.plan).to.equal(undefined);
    expect(parsed.errors[0]).to.contain('invalid or unsafe path');
  });

  test('defaults the summary and trims length', () => {
    const parsed = parseChangePlan(
      JSON.stringify({
        changes: [{ kind: 'create', path: 'src/a.ts', content: 'x' }],
      }),
    );
    expect(parsed.plan?.summary).to.equal('Proposed workspace changes');
    expect(parsed.plan?.notes).to.equal(undefined);

    const long = parseChangePlan(
      JSON.stringify({
        summary: '   ',
        notes: ` ${'n'.repeat(5_000)} `,
        changes: [{ kind: 'create', path: 'src/a.ts', content: 'x' }],
      }),
    );
    expect(long.plan?.summary).to.equal('Proposed workspace changes');
    expect(long.plan?.notes).to.have.length(4_000);
  });

  test('fails when the plan exceeds the file limit', () => {
    const changes = Array.from({ length: MAX_CHANGES_PER_PLAN + 1 }, (_, index) => ({
      kind: 'create',
      path: `src/${index}.ts`,
      content: 'x',
    }));
    const parsed = parseChangePlan(JSON.stringify({ summary: 'big', changes }));
    expect(parsed.errors).to.contain(`The plan exceeds the ${MAX_CHANGES_PER_PLAN}-file limit.`);
  });
});

suite('change plan prompts', () => {
  test('documents the JSON schema and safety rules', () => {
    const prompt = buildChangeSystemPrompt();
    expect(prompt).to.contain('Return exactly one JSON object');
    expect(prompt).to.contain('Do not use tools');
    expect(prompt).to.contain('maximum 20');
    expect(prompt).to.contain('untrusted reference data');
    expect(prompt).to.contain('credentials');
  });

  test('includes the workspace summary, selected content, reasons, and request', () => {
    const messages = buildPlanMessages({
      request: '  Add a health check  ',
      summary: SUMMARY,
      items: [
        {
          path: 'src/server.ts',
          languageId: 'typescript',
          content: 'export const server = 1;',
          sizeBytes: 25,
          redactions: 0,
        },
      ],
      reasons: { 'src/server.ts': 'file name matches the request' },
    });

    expect(messages).to.have.length(2);
    expect(messages[0].role).to.equal('system');
    expect(messages[1].role).to.equal('user');
    const user = messages[1].content;
    expect(user).to.contain('Workspace demo: 3 indexed files.');
    expect(user).to.contain('<workspace_context>');
    expect(user).to.contain('selected because: file name matches the request');
    expect(user).to.contain('src/server.ts');
    expect(user).to.contain('export const server = 1;');
    expect(user).to.contain('User request:\nAdd a health check');
    expect(user).to.contain('Return the JSON plan now.');
  });

  test('states when no content was selected', () => {
    const messages = buildPlanMessages({
      request: 'Explain this workspace',
      summary: SUMMARY,
      items: [],
    });
    expect(messages[1].content).to.contain('(no file content was selected)');
  });
});
