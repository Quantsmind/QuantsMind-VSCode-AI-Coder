import { expect } from 'chai';
import {
  runAgentEngine,
  canTransitionAgentEngineState,
  isTerminalAgentEngineState,
  type AgentEngineResult,
} from '../../src/agent/engine';
import { validateAgentExecutionLimits, AGENT_LIMIT_DEFAULTS, AGENT_LIMIT_BOUNDS } from '../../src/agent/limits';
import type { ChatMessage } from '../../src/providers/types';
import type { AgentTool, AgentModelResponse } from '../../src/agent/codingAgent';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface ScriptedModel {
  complete(messages: readonly ChatMessage[]): Promise<AgentModelResponse>;
  readonly script: Array<(messages: readonly ChatMessage[]) => AgentModelResponse>;
  readonly calls: ChatMessage[][];
}

function scriptedModel(script: Array<(messages: readonly ChatMessage[]) => AgentModelResponse>): ScriptedModel {
  const model: ScriptedModel = {
    script: [...script],
    calls: [],
    complete(messages: readonly ChatMessage[]) {
      model.calls.push([...messages]);
      const step = model.script.shift();
      if (step === undefined) {
        return Promise.resolve({ text: '{"final":"done"}' });
      }
      return Promise.resolve(step(messages));
    },
  };
  return model;
}

const finalResponse: AgentModelResponse = { text: '{"final":"all done"}' };
const toolCall = (name: string, args: Record<string, unknown> = {}, id = 'call-1'): AgentModelResponse => ({
  text: '',
  toolCalls: [{ id, name, arguments: args }],
});

function makeTool(
  name: string,
  handler: (args: Readonly<Record<string, unknown>>) => Promise<{ ok: boolean; output?: string; error?: string }>,
): AgentTool {
  return {
    name,
    description: `${name} tool`,
    parameters: {},
    execute: async (args) => ({ ...(await handler(args)), tool: name, durationMs: 1 }),
  };
}

const silentTool = (name: string, ok = true): AgentTool =>
  makeTool(name, async () => ({ ok, ...(ok ? { output: `${name} ran` } : { error: `${name} failed` }) }));

async function run(engine: Parameters<typeof runAgentEngine>[0]): Promise<AgentEngineResult> {
  return runAgentEngine(engine);
}

const baseTools = [silentTool('noop')];

suite('agent execution limits', () => {
  test('defaults are conservative and documented bounds hold', () => {
    const limits = validateAgentExecutionLimits({});
    expect(limits).to.deep.equal(AGENT_LIMIT_DEFAULTS);
    expect(AGENT_LIMIT_DEFAULTS.maxIterations).to.equal(10);
    expect(AGENT_LIMIT_DEFAULTS.maxToolCalls).to.equal(40);
    expect(AGENT_LIMIT_DEFAULTS.maxPlanRevisions).to.equal(2);
    expect(AGENT_LIMIT_DEFAULTS.maxChangedFiles).to.equal(25);
  });

  test('invalid, non-finite and huge values clamp instead of disabling', () => {
    const limits = validateAgentExecutionLimits({
      maxIterations: Number.NaN,
      maxToolCalls: -1,
      maxPlanRevisions: Number.POSITIVE_INFINITY,
      maxProviderRequests: 1e12,
      maxDurationMs: 0,
      maxToolOutputChars: 'large' as unknown as number,
      maxChangedFiles: 999_999,
      maxConsecutiveFailures: 0,
    });

    expect(limits.maxIterations).to.equal(AGENT_LIMIT_DEFAULTS.maxIterations);
    expect(limits.maxToolCalls).to.equal(AGENT_LIMIT_BOUNDS.maxToolCalls.min);
    expect(limits.maxPlanRevisions).to.equal(AGENT_LIMIT_DEFAULTS.maxPlanRevisions);
    expect(limits.maxProviderRequests).to.equal(AGENT_LIMIT_BOUNDS.maxProviderRequests.max);
    expect(limits.maxDurationMs).to.equal(AGENT_LIMIT_BOUNDS.maxDurationMs.min);
    expect(limits.maxToolOutputChars).to.equal(AGENT_LIMIT_DEFAULTS.maxToolOutputChars);
    expect(limits.maxChangedFiles).to.equal(AGENT_LIMIT_BOUNDS.maxChangedFiles.max);
    expect(limits.maxConsecutiveFailures).to.equal(AGENT_LIMIT_BOUNDS.maxConsecutiveFailures.min);
  });
});

suite('agent engine state machine', () => {
  test('valid and terminal transitions behave', () => {
    expect(canTransitionAgentEngineState('created', 'planning')).to.equal(true);
    expect(canTransitionAgentEngineState('observing', 'evaluating')).to.equal(true);
    expect(canTransitionAgentEngineState('executing', 'observing')).to.equal(true);
    expect(canTransitionAgentEngineState('observing', 'observing')).to.equal(false);
    expect(canTransitionAgentEngineState('completed', 'executing')).to.equal(false);
    expect(canTransitionAgentEngineState('cancelled', 'executing')).to.equal(false);
    expect(isTerminalAgentEngineState('completed')).to.equal(true);
    expect(isTerminalAgentEngineState('cancelled')).to.equal(true);
    expect(isTerminalAgentEngineState('executing')).to.equal(false);
  });
});

suite('agent engine execution loop', () => {
  test('a final answer completes the run with a complete assessment and no dispatched tools', async () => {
    const model = scriptedModel([() => finalResponse]);
    const result = await run({ task: 'do it', model, tools: baseTools });

    expect(result.status).to.equal('completed');
    expect(result.evaluation).to.equal('complete');
    expect(result.iterations).to.equal(1);
    expect(result.toolCalls).to.equal(0);
    expect(result.finalText).to.equal('all done');
  });

  test('system prompt carries hard-limit and untrusted-output rules', async () => {
    const model = scriptedModel([() => finalResponse]);
    await run({ task: 'x', model, tools: [silentTool('noop')] });

    const system = model.calls[0]?.[0];
    expect(system?.role).to.equal('system');
    expect(system?.content).to.contain('hard limits');
    expect(system?.content).to.contain('untrusted data');
  });

  test('tool calls are dispatched in order and the changed-file set is tracked', async () => {
    const dispatched: string[] = [];
    const spy = makeTool('write_file', async (args) => {
      dispatched.push(String(args['path']));
      return { ok: true, output: 'written' };
    });
    const model = scriptedModel([
      () => toolCall('write_file', { path: 'src/a.ts' }, 'c1'),
      () => toolCall('write_file', { path: 'src/b.ts' }, 'c2'),
      () => finalResponse,
    ]);
    const result = await run({ task: 'x', model, tools: [spy] });

    expect(dispatched).to.deep.equal(['src/a.ts', 'src/b.ts']);
    expect(result.filesChanged).to.deep.equal(['src/a.ts', 'src/b.ts']);
    expect(result.status).to.equal('completed');
  });

  test('iteration limit stops the loop with an honest outcome, not fake success', async () => {
    const model = scriptedModel(Array.from({ length: 20 }, () => () => toolCall('noop')));
    const result = await run({ task: 'x', model, tools: baseTools, limits: { maxIterations: 3 } });

    expect(result.status).to.equal('limit');
    expect(result.limitReached).to.equal('iterations');
    expect(result.iterations).to.equal(3);
    expect(result.evaluation).to.not.equal('complete');
  });

  test('tool call budget stops dispatch and is model-independent', async () => {
    const spy: string[] = [];
    const tool = makeTool('noop', async () => {
      spy.push('ran');
      return { ok: true, output: 'ran' };
    });
    const model = scriptedModel(Array.from({ length: 20 }, () => () => {
      let n = 0;
      return {
        text: '',
        toolCalls: [0, 1, 2].map(() => ({ id: `c${(n += 1)}`, name: 'noop', arguments: {} })),
      };
    }));
    const result = await run({ task: 'x', model, tools: [tool], limits: { maxToolCalls: 4, maxIterations: 32 } });

    expect(spy.length).to.equal(4);
    expect(result.status).to.equal('limit');
    expect(result.limitReached).to.equal('tool-calls');
    // `toolCalls` counts attempts including the refused one (4 dispatched + 1 refused).
    expect(result.toolCalls).to.equal(5);
  });

  test('consecutive failures stop the run as blocked', async () => {
    const failing = silentTool('always-fails', false);
    const model = scriptedModel(Array.from({ length: 10 }, (_, index) => () => toolCall('always-fails', {}, `c${index}`)));
    const result = await run({ task: 'x', model, tools: [failing], limits: { maxConsecutiveFailures: 2 } });

    expect(result.status).to.equal('blocked');
    expect(result.limitReached).to.equal('consecutive-failures');
  });

  test('repeated identical failures trigger bounded revision, then stop when the revision budget is exhausted', async () => {
    const failing = silentTool('flaky', false);
    const model = scriptedModel(Array.from({ length: 30 }, (_, index) => () => toolCall('flaky', {}, `c${index}`)));
    const result = await run({ task: 'x', model, tools: [failing], limits: { maxPlanRevisions: 1, maxConsecutiveFailures: 40 } });

    expect(result.revisions).to.equal(1);
    expect(result.status).to.equal('blocked');
    expect(result.limitReached).to.equal('revisions');
  });

  test('revision notes appear in the transcript and reference the revision budget', async () => {
    const failing = silentTool('boom', false);
    const model = scriptedModel(Array.from({ length: 6 }, () => () => toolCall('boom', {}, `c${Math.random()}`)));
    const result = await run({ task: 'x', model, tools: [failing], limits: { maxPlanRevisions: 1, maxConsecutiveFailures: 10 } });

    const joined = result.messages.map((message) => message.content).join('\n');
    expect(joined).to.contain('Revision 1 of 1');
    expect(joined).to.contain('Do not repeat');
  });

  test('an uncertain mutating failure becomes recovery-required, never a blind retry', async () => {
    const timeoutTool = makeTool('write_file', async () => ({ ok: false, error: 'Tool "write_file" timed out after 5000 ms. It was signalled to stop.' }));
    const model = scriptedModel([() => toolCall('write_file', { path: 'src/a.ts' }, 'c1')]);
    const result = await run({ task: 'x', model, tools: [timeoutTool] });

    expect(result.status).to.equal('recovery-required');
    expect(result.evaluation).to.equal('inconclusive');
    const dispatches = model.calls.length;
    expect(dispatches).to.equal(1);
  });

  test('completed after failures reports partial, never complete; with no successes it reports failed', async () => {
    const failing = silentTool('sometimes-fails', false);
    const good = silentTool('noop', true);
    const model = scriptedModel([
      () => toolCall('noop', {}, 'ok-1'),
      () => toolCall('sometimes-fails', {}, 'bad-1'),
      () => finalResponse,
    ]);
    const result = await run({ task: 'x', model, tools: [failing, good] });

    expect(result.status).to.equal('completed');
    expect(result.evaluation).to.equal('partial');

    const failingOnly = scriptedModel([
      () => toolCall('sometimes-fails', {}, 'bad-2'),
      () => finalResponse,
    ]);
    const failed = await run({ task: 'x', model: failingOnly, tools: [failing, good] });
    expect(failed.status).to.equal('completed');
    expect(failed.evaluation).to.equal('failed');
  });

  test('authorizer denial prevents dispatch and surfaces the reason', async () => {
    let dispatched = false;
    const spy = makeTool('write_file', async () => {
      dispatched = true;
      return { ok: true, output: 'written' };
    });
    const model = scriptedModel([() => toolCall('write_file', { path: 'src/a.ts' }, 'c1'), () => finalResponse]);
    const result = await run({
      task: 'x',
      model,
      tools: [spy],
      authorize: async () => ({ approved: false, reason: 'policy says no' }),
    });

    expect(dispatched).to.equal(false);
    expect(result.status).to.equal('completed');
    expect(result.toolResults.some((r) => !r.ok && (r.error ?? '').includes('policy says no'))).to.equal(true);
  });

  test('cancellation before dispatch prevents tool execution', async () => {
    let dispatched = false;
    const spy = makeTool('write_file', async () => {
      dispatched = true;
      return { ok: true, output: 'written' };
    });
    const controller = new AbortController();
    controller.abort();
    const model = scriptedModel([() => toolCall('write_file', { path: 'x.ts' }, 'c1')]);
    const result = await run({ task: 'x', model, tools: [spy], signal: controller.signal });

    expect(result.status).to.equal('cancelled');
    expect(dispatched).to.equal(false);
  });

  test('shouldPause stops the run at the step boundary without dispatching further work', async () => {
    let dispatched = 0;
    const spy = makeTool('noop', async () => {
      dispatched += 1;
      return { ok: true, output: 'ran' };
    });
    const model = scriptedModel(Array.from({ length: 5 }, () => () => toolCall('noop', {}, `c${dispatched}`)));
    let pauseCalls = 0;
    const result = await run({
      task: 'x',
      model,
      tools: [spy],
      shouldPause: () => (pauseCalls += 1) > 2,
    });

    expect(result.status).to.equal('paused');
    expect(dispatched).to.be.lessThan(5);
  });

  test('provider request budget stops the run with limit/provider-requests', async () => {
    const model = scriptedModel(Array.from({ length: 20 }, () => () => toolCall('noop', {}, `c${Math.random()}`)));
    const result = await run({ task: 'x', model, tools: baseTools, limits: { maxProviderRequests: 1, maxIterations: 32 } });

    expect(result.status).to.equal('limit');
    expect(result.limitReached).to.equal('provider-requests');
    expect(result.providerRequests).to.equal(1);
  });

  test('provider errors fail the run and are reported', async () => {
    const model: ScriptedModel = {
      script: [],
      calls: [],
      complete: () => Promise.reject(new Error('Rate limit exceeded')),
    };
    const result = await run({ task: 'x', model, tools: baseTools });

    expect(result.status).to.equal('error');
    expect(result.finalText).to.contain('Rate limit');
  });

  test('per-result output budget truncates with an explicit marker', async () => {
    const bigTool = silentTool('bigoutput', true);
    const giant = 'x'.repeat(5_000);
    const oversized = makeTool('bigoutput', async () => ({ ok: true, output: giant }));
    void bigTool;
    const model = scriptedModel([() => toolCall('bigoutput', {}, 'c1'), () => finalResponse]);
    const result = await run({ task: 'x', model, tools: [oversized], limits: { maxToolOutputChars: 1_000 } });

    const stored = result.toolResults.find((entry) => entry.tool === 'bigoutput');
    expect(stored?.output).to.contain('[output truncated by agent budget');
    expect(stored?.output?.length).to.be.lessThanOrEqual(1_000 + 80);
  });

  test('cumulative patch-size budget refuses the offending write before dispatch', async () => {
    let dispatched = false;
    const spy = makeTool('write_file', async () => {
      dispatched = true;
      return { ok: true, output: 'written' };
    });
    const model = scriptedModel([() => toolCall('write_file', { path: 'src/big.ts', content: 'y'.repeat(2_000) }, 'c1')]);
    const result = await run({ task: 'x', model, tools: [spy], limits: { maxPatchSizeChars: 1_000 } });

    expect(dispatched).to.equal(false);
    expect(result.status).to.equal('blocked');
    expect(result.limitReached).to.equal('patch-size');
    expect(result.filesChanged).to.deep.equal([]);
  });

  test('changed-file budget refuses mutation of another distinct file', async () => {
    let dispatchedCount = 0;
    const spy = makeTool('write_file', async () => {
      dispatchedCount += 1;
      return { ok: true, output: 'written' };
    });
    const model = scriptedModel([
      () => toolCall('write_file', { path: 'src/one.ts' }, 'c1'),
      () => toolCall('write_file', { path: 'src/two.ts' }, 'c2'),
    ]);
    const result = await run({ task: 'x', model, tools: [spy], limits: { maxChangedFiles: 1 } });

    expect(dispatchedCount).to.equal(1);
    expect(result.status).to.equal('blocked');
    expect(result.limitReached).to.equal('changed-files');
    expect(result.filesChanged).to.deep.equal(['src/one.ts']);
  });
});
