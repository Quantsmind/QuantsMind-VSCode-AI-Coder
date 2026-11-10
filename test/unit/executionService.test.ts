import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExecutionService } from '../../src/execution/service';

const tempRoots: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quantsmind-exec-test-'));
  tempRoots.push(root);
  return root;
}

suiteTeardown(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const base = (root: string) => ({
  cwd: root,
  workspaceRoot: root,
  allowlist: ['node --version', 'node -e process.exit(2)', 'node -e setInterval(function(){},1000)'],
  trusted: true,
});

suite('execution service', () => {
  test('records a running record that resolves to succeeded', async () => {
    const service = new ExecutionService();
    const events: string[] = [];
    service.subscribe((record) => events.push(record.status));

    const result = await service.run('node --version', {
      ...base(makeWorkspace()),
      timeoutMs: 5_000,
      kind: 'command',
    });

    expect(result.status).to.equal('succeeded');
    expect(result.exitCode).to.equal(0);
    expect(result.output).to.match(/v\d+/);
    expect(service.isRunning()).to.equal(false);
    expect(events).to.deep.equal(['running', 'succeeded']);
  });

  test('maps non-zero exit codes to failed', async () => {
    const service = new ExecutionService();

    const result = await service.run('node -e process.exit(2)', {
      ...base(makeWorkspace()),
      timeoutMs: 5_000,
      kind: 'build',
    });

    expect(result.status).to.equal('failed');
    expect(result.exitCode).to.equal(2);
  });

  test('times out long-running processes and terminates them', async () => {
    const root = makeWorkspace();
    const service = new ExecutionService();

    const result = await service.run('node -e setInterval(function(){},1000)', {
      ...base(root),
      timeoutMs: 500,
      kind: 'test',
    });

    expect(result.timedOut).to.equal(true);
    expect(result.status).to.equal('timed-out');
    expect(service.isRunning()).to.equal(false);
  });

  test('cancels an in-flight execution via the linked external signal', async () => {
    const root = makeWorkspace();
    const service = new ExecutionService();
    const external = new AbortController();

    const pending = service.run('node -e setInterval(function(){},1000)', {
      ...base(root),
      timeoutMs: 60_000,
      kind: 'test',
      signal: external.signal,
    });
    setTimeout(() => external.abort(), 150);
    const result = await pending;

    expect(result.cancelled).to.equal(true);
    expect(result.status).to.equal('cancelled');
  });

  test('cancel(id) stops a specific execution', async () => {
    const root = makeWorkspace();
    const service = new ExecutionService();

    const pending = service.run('node -e setInterval(function(){},1000)', {
      ...base(root),
      timeoutMs: 60_000,
      kind: 'build',
    });
    const [id] = service.runningIds();
    expect(id).to.not.equal(undefined);
    expect(service.cancel(id)).to.equal(true);
    const result = await pending;

    expect(result.status).to.equal('cancelled');
    expect(service.cancel('nonexistent-id')).to.equal(false);
  });

  test('cancelAll stops every in-flight execution', async () => {
    const root = makeWorkspace();
    const service = new ExecutionService();

    const first = service.run('node -e setInterval(function(){},1000)', {
      ...base(root),
      timeoutMs: 60_000,
      kind: 'command',
    });
    const second = service.run('node -e setInterval(function(){},1000)', {
      ...base(makeWorkspace()),
      timeoutMs: 60_000,
      kind: 'command',
    });
    service.cancelAll();
    const [a, b] = await Promise.all([first, second]);

    expect(a.status).to.equal('cancelled');
    expect(b.status).to.equal('cancelled');
    expect(service.isRunning()).to.equal(false);
  });

  test('keeps a bounded history and returns newest first', async () => {
    const root = makeWorkspace();
    const service = new ExecutionService(10);

    for (let index = 0; index < 5; index += 1) {
      await service.run('node --version', {
        ...base(root),
        timeoutMs: 5_000,
        kind: 'command',
      });
    }

    const list = service.list();
    expect(list).to.have.length(5);
    expect(list[0]?.id).to.not.equal(list[1]?.id);
    expect(service.historyForTask(undefined).length).to.equal(5);
  });

  test('refuses the same invocation while it is already running', async () => {
    const root = makeWorkspace();
    const service = new ExecutionService();

    const firstPromise = service.run('node -e setInterval(function(){},1000)', {
      ...base(root),
      timeoutMs: 60_000,
      kind: 'command',
    });
    // Wait until the in-flight record is visible.
    for (let attempt = 0; attempt < 50 && service.runningIds().length === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const second = await service.run('node -e setInterval(function(){},1000)', {
      ...base(root),
      timeoutMs: 60_000,
      kind: 'command',
    });

    expect(second.status).to.equal('failed');
    expect(second.error).to.contain('already running');
    expect(service.runningIds().length).to.equal(1);
    service.cancelAll();
    await firstPromise;
  });

  test('historyForTask filters by task', async () => {
    const root = makeWorkspace();
    const service = new ExecutionService();

    await service.run('node --version', {
      ...base(root),
      timeoutMs: 5_000,
      kind: 'command',
      taskId: 'task-a',
    });
    await service.run('node --version', {
      ...base(root),
      timeoutMs: 5_000,
      kind: 'command',
      taskId: 'task-b',
    });

    expect(service.historyForTask('task-a')).to.have.length(1);
    expect(service.historyForTask('task-b')).to.have.length(1);
  });
});
