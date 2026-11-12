import { expect } from 'chai';
import { buildCodingTaskPlan, expectedFilesOf, formatCodingTaskPlan } from '../../src/workflow/plan';
import { buildLanguageInventory } from '../../src/languages/inventory';
import type { DevelopmentPlan } from '../../src/agent/models';

const planOf = (overrides: Partial<DevelopmentPlan> = {}): DevelopmentPlan => ({
  id: 'plan-1',
  requirementId: 'req-1',
  summary: 'Add a retry policy to the webhook sender',
  approach: 'Wrap the sender in an exponential backoff helper and cover it with tests',
  tasks: [
    {
      id: 'task-1',
      title: 'Add backoff helper',
      description: 'New helper module',
      dependsOn: [],
      acceptanceCriteria: [
        { id: 'criterion-1', text: 'Helper is covered by unit tests', verification: 'command' },
        { id: 'criterion-2', text: 'No behavior change for existing callers', verification: 'review' },
      ],
      suggestedFiles: ['src/webhook/backoff.ts', 'Src/Webhook/Backoff.ts'],
      status: 'pending',
      attempts: 0,
      repairAttempts: 0,
    },
    {
      id: 'task-2',
      title: 'Use the helper in the sender',
      description: 'Wire it in',
      dependsOn: ['task-1'],
      acceptanceCriteria: [
        { id: 'criterion-1', text: 'Webhook sends retry on 5xx', verification: 'command' },
      ],
      suggestedFiles: ['src/webhook/sender.ts'],
      status: 'pending',
      attempts: 0,
      repairAttempts: 0,
    },
  ],
  risks: ['Backoff may interact with timeouts'],
  warnings: [],
  createdAt: '2026-11-11T00:00:00.000Z',
  ...overrides,
});

const inventoryOf = (paths: readonly string[]) => buildLanguageInventory(paths.map((path) => ({ path })));

suite('structured coding task plans', () => {
  test('builds a bounded envelope grounded in the requirement', () => {
    const inventory = inventoryOf([...Array.from({ length: 6 }, (_, index) => `src/w${index}.ts`), 'src/w/deep/file.ts']);
    const plan = buildCodingTaskPlan({
      plan: planOf(),
      requirementText: 'Add a retry policy to the webhook sender module',
      inventory,
      detections: [],
    });

    expect(plan.objective).to.contain('retry policy');
    expect(plan.category).to.equal('feature');
    expect(plan.scope).to.deep.equal(['Add backoff helper', 'Use the helper in the sender']);
    expect(plan.expectedFiles.map((file) => file.toLowerCase())).to.deep.equal([
      'src/webhook/backoff.ts',
      'src/webhook/sender.ts',
    ]);
    expect(plan.completionCriteria).to.have.length(3);
    expect(plan.createdAt.length).to.be.greaterThan(0);
  });

  test('local evidence is generated from the inventory, never invented', () => {
    const inventory = inventoryOf([...Array.from({ length: 5 }, (_, index) => `src/a${index}.ts`), 'docs/b.yaml']);
    const plan = buildCodingTaskPlan({
      plan: planOf(),
      requirementText: 'Fix the retry bug in the sender',
      inventory,
    });

    const evidence = plan.evidence.map((item) => item.text).join('\n');
    expect(evidence).to.contain('Primary language: TypeScript');
    expect(evidence).to.contain('Requirement: Fix the retry bug');
    expect(plan.evidence.every((item) => item.kind !== undefined)).to.equal(true);
  });

  test('partial detection adds an explicit assumption', () => {
    const inventory = inventoryOf(['solo/x.ts']);
    const plan = buildCodingTaskPlan({ plan: planOf(), requirementText: 'Fix the bug', inventory });

    expect(plan.assumptions.some((assumption) => assumption.includes('partial'))).to.equal(true);
  });

  test('model-proposed risks and file suggestions are labelled as assumptions', () => {
    const plan = buildCodingTaskPlan({ plan: planOf(), requirementText: 'Add the retry policy' });

    expect(plan.assumptions[0]).to.contain('treat every step');
    expect(plan.assumptions.some((assumption) => assumption.includes('suggested file'))).to.equal(true);
    expect(plan.risks).to.deep.equal(['Backoff may interact with timeouts']);
  });

  test('detections flow into the validation strategy; missing detections point at the tool', () => {
    const withDetection = buildCodingTaskPlan({
      plan: planOf(),
      requirementText: 'Add retry',
      detections: [
        {
          adapter: {
            id: 'npm',
            ecosystem: 'Node.js (npm)',
            languages: ['typescript'],
            configFiles: ['package.json'],
            detect: () => true,
            buildCommands: () => ['npm run build'],
            testCommands: () => ['npm test'],
            testOutputFormat: 'node',
          },
          configFile: 'package.json',
        },
      ],
    });
    expect(withDetection.validationStrategy).to.contain('Node.js (npm)');
    expect(withDetection.validationStrategy).to.not.contain('detect_build_system');

    const without = buildCodingTaskPlan({ plan: planOf(), requirementText: 'Add retry' });
    expect(without.validationStrategy).to.contain('detect_build_system');
  });

  test('expected file list normalizes, dedupes and drops unsafe paths', () => {
    const plan = planOf({
      tasks: [
        {
          id: 'task-1',
          title: 'One',
          description: 'd',
          dependsOn: [],
          acceptanceCriteria: [],
          suggestedFiles: ['src/a.ts', 'src/a.ts', '../escape.ts', 'C:/abs/file.ts', 'src\\b.ts'],
          status: 'pending',
          attempts: 0,
          repairAttempts: 0,
        },
      ],
    });

    expect(expectedFilesOf(plan)).to.deep.equal(['src/a.ts', 'src/b.ts']);
  });

  test('completion criteria are deduplicated and bounded', () => {
    const task = (id: string) => ({
      id,
      title: `T ${id}`,
      description: 'd',
      dependsOn: [],
      acceptanceCriteria: [
        { id: `c-${id}`, text: 'Same outcome', verification: 'review' as const },
        { id: `c2-${id}`, text: `Unique outcome ${id}`, verification: 'manual' as const },
      ],
      suggestedFiles: [],
      status: 'pending' as const,
      attempts: 0,
      repairAttempts: 0,
    });
    const plan = planOf({ tasks: Array.from({ length: 12 }, (_, index) => task(`t${index}`)) });
    const built = buildCodingTaskPlan({ plan, requirementText: 'x' });

    const sameCount = built.completionCriteria.filter((criterion) => criterion === 'Same outcome').length;
    expect(sameCount).to.equal(1);
    expect(built.completionCriteria.length).to.be.lessThanOrEqual(10);
  });

  test('formatCodingTaskPlan stays bounded and includes the sections', () => {
    const built = buildCodingTaskPlan({ plan: planOf(), requirementText: 'Add a retry policy' });
    const text = formatCodingTaskPlan(built);

    expect(text.length).to.be.lessThanOrEqual(2_000);
    expect(text).to.contain('Category:');
    expect(text).to.contain('Evidence (local):');
    expect(text).to.contain('Assumptions (verify):');
    expect(text).to.contain('Validation:');
    expect(text).to.contain('Completion criteria:');
  });
});
