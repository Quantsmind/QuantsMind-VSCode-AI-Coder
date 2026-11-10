import { expect } from 'chai';
import {
  AgentToolRegistry,
  DEFAULT_AGENT_TOOL_TIMEOUT_MS,
  runCodingAgent,
  type AgentTool,
  type AgentToolResult,
} from '../../src/agent/codingAgent';
import { delay } from './helpers';

function okResult(tool: string, output = 'done'): AgentToolResult {
  return { ok: true, tool, output, durationMs: 1 };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tool(
  name: string,
  execute: AgentTool['execute'],
  timeoutMs?: number,
): AgentTool {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', properties: {} },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    execute,
  };
}

suite('agent tool timeout and cancellation (D2)', () => {
  test('a normally completing tool returns its result and receives a signal', async () => {
    const registry = new AgentToolRegistry();
    let received: AbortSignal | undefined;
    registry.register(
      tool('fast', async (_args, context) => {
        received = context?.signal;
        return okResult('fast', 'payload');
      }),
    );

    const result = await registry.execute({ id: 'c1', name: 'fast', arguments: {} });
    expect(result.ok).to.equal(true);
    expect(result.output).to.equal('payload');
    expect(received).to.not.equal(undefined);
    expect(received?.aborted).to.equal(false);
  });

  test('a never-resolving tool times out with a normalized failure', async () => {
    const registry = new AgentToolRegistry();
    let toolSignal: AbortSignal | undefined;
    const never = deferred<AgentToolResult>();
    registry.register(
      tool('stuck', async (_args, context) => {
        toolSignal = context?.signal;
        return never.promise;
      }),
    );

    const startedAt = Date.now();
    const result = await registry.execute(
      { id: 'c1', name: 'stuck', arguments: {} },
      { timeoutMs: 1_000 },
    );
    const elapsed = Date.now() - startedAt;

    expect(result.ok).to.equal(false);
    expect(result.tool).to.equal('stuck');
    expect(result.error).to.contain('timed out after 1000 ms');
    expect(result.error).to.contain('any later result is ignored');
    expect(elapsed).to.be.at.least(950);
    expect(elapsed).to.be.lessThan(5_000);
    expect(toolSignal?.aborted).to.equal(true);
    never.resolve(okResult('stuck'));
  });

  test('a tool that succeeds after the deadline cannot report success', async () => {
    const registry = new AgentToolRegistry();
    const late = deferred<AgentToolResult>();
    registry.register(tool('late', async () => late.promise));

    const result = await registry.execute(
      { id: 'c1', name: 'late', arguments: {} },
      { timeoutMs: 1_000 },
    );
    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('timed out');

    late.resolve(okResult('late', 'too late'));
    await delay(20);
    expect(result.ok).to.equal(false);
    expect(result.output).to.equal(undefined);
  });

  test('a tool that rejects after the deadline raises no unhandled rejection', async () => {
    const registry = new AgentToolRegistry();
    const late = deferred<AgentToolResult>();
    registry.register(tool('late-failure', async () => late.promise));

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = await registry.execute(
        { id: 'c1', name: 'late-failure', arguments: {} },
        { timeoutMs: 1_000 },
      );
      expect(result.error).to.contain('timed out');
      late.reject(new Error('settled after the deadline'));
      await delay(30);
      expect(unhandled).to.have.length(0);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  test('cancellation during execution settles promptly and aborts the tool', async () => {
    const registry = new AgentToolRegistry();
    const controller = new AbortController();
    let toolSignal: AbortSignal | undefined;
    const started = deferred<void>();
    registry.register(
      tool('slow', async (_args, context) => {
        toolSignal = context?.signal;
        started.resolve();
        return new Promise<AgentToolResult>(() => undefined);
      }),
    );

    const pending = registry.execute(
      { id: 'c1', name: 'slow', arguments: {} },
      { signal: controller.signal, timeoutMs: 60_000 },
    );
    await started.promise;
    const startedAt = Date.now();
    controller.abort();
    const result = await pending;

    expect(result.ok).to.equal(false);
    expect(result.error).to.equal('Tool "slow" was cancelled.');
    expect(Date.now() - startedAt).to.be.lessThan(2_000);
    expect(toolSignal?.aborted).to.equal(true);
  });

  test('an already aborted run never starts the tool', async () => {
    const registry = new AgentToolRegistry();
    const controller = new AbortController();
    let executions = 0;
    registry.register(
      tool('never-started', async () => {
        executions += 1;
        return okResult('never-started');
      }),
    );
    controller.abort();

    const result = await registry.execute(
      { id: 'c1', name: 'never-started', arguments: {} },
      { signal: controller.signal },
    );
    expect(executions).to.equal(0);
    expect(result.ok).to.equal(false);
    expect(result.error).to.equal('Tool "never-started" was cancelled before it started.');
  });

  test('the run listener is removed once the tool completes', async () => {
    const registry = new AgentToolRegistry();
    const controller = new AbortController();
    let toolSignal: AbortSignal | undefined;
    registry.register(
      tool('clean', async (_args, context) => {
        toolSignal = context?.signal;
        return okResult('clean');
      }),
    );

    const result = await registry.execute(
      { id: 'c1', name: 'clean', arguments: {} },
      { signal: controller.signal },
    );
    expect(result.ok).to.equal(true);
    controller.abort();
    await delay(10);
    expect(toolSignal?.aborted).to.equal(false);
  });

  test('a tool deadline is extended by a grace margin so its own timeout wins', async () => {
    const registry = new AgentToolRegistry();
    registry.register(
      tool('self-timed', async () => {
        await delay(1_100);
        return okResult('self-timed', 'finished inside its own budget');
      }, 1_000),
    );

    const result = await registry.execute({ id: 'c1', name: 'self-timed', arguments: {} });
    expect(result.ok).to.equal(true);
    expect(result.output).to.equal('finished inside its own budget');
  });

  test('a tool that enforces its own timeout keeps its own diagnostics', async () => {
    const registry = new AgentToolRegistry();
    registry.register(
      tool('command-like', async () => {
        await delay(20);
        return {
          ok: false,
          tool: 'command-like',
          error: 'Command timed out after 1000 ms.',
          durationMs: 20,
        };
      }, 1_000),
    );

    const result = await registry.execute({ id: 'c1', name: 'command-like', arguments: {} });
    expect(result.ok).to.equal(false);
    expect(result.error).to.equal('Command timed out after 1000 ms.');
  });

  test('an explicit run deadline overrides the tool budget', async () => {
    const registry = new AgentToolRegistry();
    registry.register(
      tool('overridden', async () => new Promise<AgentToolResult>(() => undefined), 600_000),
    );

    const result = await registry.execute(
      { id: 'c1', name: 'overridden', arguments: {} },
      { timeoutMs: 1_000 },
    );
    expect(result.error).to.contain('timed out after 1000 ms');
  });

  test('an unreasonably small deadline is clamped to the documented minimum', async () => {
    const registry = new AgentToolRegistry();
    registry.register(tool('clamped', async () => new Promise<AgentToolResult>(() => undefined)));

    const result = await registry.execute(
      { id: 'c1', name: 'clamped', arguments: {} },
      { timeoutMs: 1 },
    );
    expect(result.error).to.contain('timed out after 1000 ms');
  });

  test('the default deadline is bounded and exported', () => {
    expect(DEFAULT_AGENT_TOOL_TIMEOUT_MS).to.equal(120_000);
    expect(DEFAULT_AGENT_TOOL_TIMEOUT_MS).to.be.at.most(900_000);
  });

  test('a thrown tool error is normalized instead of escaping the registry', async () => {
    const registry = new AgentToolRegistry();
    registry.register(
      tool('throws', async () => {
        throw new Error('tool exploded');
      }),
    );
    const result = await registry.execute({ id: 'c1', name: 'throws', arguments: {} });
    expect(result.ok).to.equal(false);
    expect(result.error).to.equal('tool exploded');
  });
});

suite('coding agent tool deadline propagation (D2)', () => {
  test('the run signal reaches in-flight tool execution and cancels the loop', async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    let modelCalls = 0;
    let toolSignal: AbortSignal | undefined;
    const model = {
      async complete() {
        modelCalls += 1;
        return {
          text: '',
          toolCalls: [{ id: 'call-1', name: 'hang', arguments: {} }],
        };
      },
    };
    const tools = [
      tool('hang', async (_args, context) => {
        toolSignal = context?.signal;
        started.resolve();
        return new Promise<AgentToolResult>(() => undefined);
      }),
    ];

    const pending = runCodingAgent({
      task: 'hang the tool',
      model,
      tools,
      signal: controller.signal,
      toolTimeoutMs: 60_000,
      maxIterations: 4,
    });
    await started.promise;
    controller.abort();
    const result = await pending;

    expect(result.status).to.equal('cancelled');
    expect(modelCalls).to.equal(1);
    expect(toolSignal).to.not.equal(undefined);
    expect(toolSignal?.aborted).to.equal(true);
    expect(result.toolResults).to.have.length(1);
    expect(result.toolResults[0].ok).to.equal(false);
    expect(result.toolResults[0].error).to.equal('Tool "hang" was cancelled.');
  });

  test('a tool timeout is reported to the model as a failed tool result', async () => {
    let modelCalls = 0;
    const seen: string[] = [];
    const model = {
      async complete(messages: readonly { role: string; content: string }[]) {
        modelCalls += 1;
        if (modelCalls === 1) {
          return { text: '', toolCalls: [{ id: 'call-1', name: 'hang', arguments: {} }] };
        }
        seen.push(...messages.map((message) => message.role));
        return { text: '', toolCalls: [] , finishReason: 'stop' };
      },
    };
    const tools = [tool('hang', async () => new Promise<AgentToolResult>(() => undefined))];
    const events: string[] = [];

    const result = await runCodingAgent({
      task: 'time the tool out',
      model,
      tools,
      toolTimeoutMs: 1_000,
      maxIterations: 4,
      onEvent: (event) => events.push(event.type),
    });

    expect(result.toolResults).to.have.length(1);
    expect(result.toolResults[0].ok).to.equal(false);
    expect(result.toolResults[0].error).to.contain('timed out after 1000 ms');
    expect(modelCalls).to.equal(2);
    expect(seen).to.include('tool');
    expect(events).to.include('tool');
    expect(result.status).to.equal('completed');
  });
});