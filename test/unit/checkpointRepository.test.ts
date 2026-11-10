import { expect } from 'chai';
import { CheckpointRepository, sanitizeCheckpoint } from '../../src/sessions/checkpointRepository';
import type { CheckpointKeyValueStore } from '../../src/sessions/checkpointRepository';
import {
  CHECKPOINT_SCHEMA_VERSION,
  type ExecutionCheckpoint,
} from '../../src/agent/models';

function memoryStore(): { store: CheckpointKeyValueStore; raw(): unknown } {
  let stored: unknown;
  return {
    store: {
      get<T>(_key: string): T | undefined {
        return stored as T | undefined;
      },
      update(_key: string, value: unknown): PromiseLike<void> {
        stored = value;
        return Promise.resolve();
      },
    },
    raw() {
      return stored;
    },
  };
}

function checkpoint(overrides: Partial<ExecutionCheckpoint> = {}): ExecutionCheckpoint {
  return {
    id: 'checkpoint-1',
    sessionId: 'session-1',
    executionId: 'execution-1',
    sequence: 1,
    planId: 'plan-1',
    planVersion: 'version-1',
    currentTaskId: 'task-1',
    completedTaskIds: ['task-0'],
    pendingTaskIds: ['task-2'],
    failedTaskIds: [],
    blockedTaskIds: [],
    taskResults: [{ taskId: 'task-0', status: 'completed', summary: 'done' }],
    pendingApprovalIds: [],
    changeSetIds: ['changeset-1'],
    appliedChangeIds: ['change-1'],
    validationRunIds: ['validation-1'],
    repositoryStateRef: 'repo-state-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'valid',
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    integrity: 'integrity-1',
    ...overrides,
  };
}

suite('execution checkpoint repository', () => {
  test('creates and serializes a valid checkpoint', () => {
    const value = checkpoint();
    const sanitized = sanitizeCheckpoint(value);
    expect(sanitized).to.not.equal(undefined);
    expect(sanitized?.id).to.equal('checkpoint-1');
    expect(sanitized?.sequence).to.equal(1);
    expect(sanitized?.appliedChangeIds).to.deep.equal(['change-1']);
  });

  test('round-trips a checkpoint through storage', async () => {
    const { store } = memoryStore();
    const repository = new CheckpointRepository(store, { warn: () => undefined });
    const original = checkpoint();
    await repository.save(original);

    const loaded = await repository.get('checkpoint-1');
    expect(loaded).to.not.equal(undefined);
    expect(loaded?.executionId).to.equal('execution-1');
    expect(loaded?.taskResults[0]?.taskId).to.equal('task-0');
    expect(loaded?.appliedChangeIds).to.deep.equal(['change-1']);
  });

  test('selects the latest valid checkpoint by sequence', async () => {
    const { store } = memoryStore();
    const repository = new CheckpointRepository(store, { warn: () => undefined });
    await repository.save(checkpoint({ id: 'checkpoint-1', sequence: 1, status: 'valid' }));
    await repository.save(checkpoint({ id: 'checkpoint-3', sequence: 2, status: 'invalid' }));
    await repository.save(checkpoint({ id: 'checkpoint-2', sequence: 3, status: 'created' }));

    const latest = await repository.latest('execution-1');
    expect(latest?.id).to.equal('checkpoint-2');
  });

  test('lists checkpoint history in sequence order', async () => {
    const { store } = memoryStore();
    const repository = new CheckpointRepository(store, { warn: () => undefined });
    await repository.save(checkpoint({ id: 'checkpoint-1', sequence: 1 }));
    await repository.save(checkpoint({ id: 'checkpoint-2', sequence: 2 }));

    const history = await repository.list('execution-1');
    expect(history.map((item) => item.sequence)).to.deep.equal([1, 2]);
  });

  test('keeps multiple execution histories separate', async () => {
    const { store } = memoryStore();
    const repository = new CheckpointRepository(store, { warn: () => undefined });
    await repository.save(checkpoint({ id: 'checkpoint-a', executionId: 'execution-a', sequence: 1 }));
    await repository.save(checkpoint({ id: 'checkpoint-b', executionId: 'execution-b', sequence: 1 }));

    expect((await repository.list('execution-a')).map((item) => item.id)).to.deep.equal([
      'checkpoint-a',
    ]);
    expect((await repository.list('execution-b')).map((item) => item.id)).to.deep.equal([
      'checkpoint-b',
    ]);
  });

  test('rejects malformed records during sanitization', () => {
    expect(sanitizeCheckpoint(undefined)).to.equal(undefined);
    expect(sanitizeCheckpoint({ id: 'x' })).to.equal(undefined);
    expect(
      sanitizeCheckpoint({
        ...checkpoint(),
        status: 'not-a-status',
      }),
    ).to.equal(undefined);
    expect(
      sanitizeCheckpoint({
        ...checkpoint(),
        schemaVersion: 99,
      }),
    ).to.equal(undefined);
    expect(
      sanitizeCheckpoint({
        ...checkpoint(),
        sequence: 0,
      }),
    ).to.equal(undefined);
  });

  test('rejects non-increasing sequences on save', async () => {
    const { store } = memoryStore();
    const repository = new CheckpointRepository(store, { warn: () => undefined });
    await repository.save(checkpoint({ id: 'checkpoint-1', sequence: 2 }));

    let thrown = false;
    try {
      await repository.save(checkpoint({ id: 'checkpoint-2', sequence: 1 }));
    } catch {
      thrown = true;
    }
    expect(thrown).to.equal(true);
    expect((await repository.list('execution-1')).map((item) => item.id)).to.deep.equal([
      'checkpoint-1',
    ]);
  });

  test('preserves missing optional fields', () => {
    const raw = { ...checkpoint() };
    delete (raw as Record<string, unknown>).currentTaskId;
    delete (raw as Record<string, unknown>).repositoryStateRef;
    delete (raw as Record<string, unknown>).integrity;
    const sanitized = sanitizeCheckpoint(raw);
    expect(sanitized?.currentTaskId).to.equal(undefined);
    expect(sanitized?.repositoryStateRef).to.equal(undefined);
    expect(sanitized?.integrity).to.equal(undefined);
  });

  test('updates an existing checkpoint by id', async () => {
    const { store } = memoryStore();
    const repository = new CheckpointRepository(store, { warn: () => undefined });
    await repository.save(checkpoint({ id: 'checkpoint-1', sequence: 1, status: 'created' }));
    await repository.save(checkpoint({ id: 'checkpoint-1', sequence: 1, status: 'valid' }));

    const loaded = await repository.get('checkpoint-1');
    expect(loaded?.status).to.equal('valid');
    expect((await repository.list('execution-1'))).to.have.length(1);
  });

  test('round-trips multiple task results with attempts and statuses', async () => {
    const { store } = memoryStore();
    const repository = new CheckpointRepository(store, { warn: () => undefined });
    await repository.save(
      checkpoint({
        taskResults: [
          { taskId: 'task-0', status: 'completed', attempts: 1 },
          { taskId: 'task-1', status: 'failed', attempts: 3, error: 'boom' },
          { taskId: 'task-2', status: 'pending', attempts: 0 },
        ],
        completedTaskIds: ['task-0'],
        failedTaskIds: ['task-1'],
        pendingTaskIds: ['task-2'],
      }),
    );

    const loaded = await repository.get('checkpoint-1');
    expect(loaded?.taskResults.map((result) => result.taskId)).to.deep.equal(['task-0', 'task-1', 'task-2']);
    expect(loaded?.taskResults.map((result) => result.status)).to.deep.equal(['completed', 'failed', 'pending']);
    expect(loaded?.taskResults[1]?.attempts).to.equal(3);
    expect(loaded?.taskResults[1]?.error).to.equal('boom');
  });

  test('sanitizes attempts from legacy checkpoints that omit them', () => {
    const sanitized = sanitizeCheckpoint({
      ...checkpoint(),
      taskResults: [{ taskId: 'task-1', status: 'completed' }],
    });
    expect(sanitized?.taskResults[0]?.attempts).to.equal(undefined);
  });

  test('preserves validation and change-set references across round-trips', async () => {
    const { store } = memoryStore();
    const repository = new CheckpointRepository(store, { warn: () => undefined });
    await repository.save(
      checkpoint({
        changeSetIds: ['changeset-1', 'changeset-2'],
        appliedChangeIds: ['change-a', 'change-b'],
        validationRunIds: ['validation-a'],
      }),
    );

    const loaded = await repository.get('checkpoint-1');
    expect(loaded?.changeSetIds).to.deep.equal(['changeset-1', 'changeset-2']);
    expect(loaded?.appliedChangeIds).to.deep.equal(['change-a', 'change-b']);
    expect(loaded?.validationRunIds).to.deep.equal(['validation-a']);
  });

  test('bounds checkpoint history per execution', async () => {
    const { store } = memoryStore();
    const repository = new CheckpointRepository(store, { warn: () => undefined });
    for (let index = 1; index <= 55; index += 1) {
      await repository.save(
        checkpoint({
          id: `checkpoint-${index}`,
          sequence: index,
        }),
      );
    }
    const history = await repository.list('execution-1');
    expect(history.length).to.equal(50);
    expect(history[0]?.sequence).to.equal(6);
  });
});
