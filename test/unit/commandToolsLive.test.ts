import { expect } from 'chai';
import { tmpdir } from 'node:os';
import { CommandTools, type CommandToolEnvironment } from '../../src/agent/commandTools';
import { AgentToolRegistry } from '../../src/agent/codingAgent';

const ALLOWED = 'node --version';
const VERBOSE = `node -e "process.stdout.write('x'.repeat(2000))"`;

interface LiveState {
  cwd: string;
  workspaceRoot: string;
  allowlist: readonly string[];
  timeoutMs: number;
  maxOutputChars: number | undefined;
  trusted: boolean;
}

function liveState(overrides: Partial<LiveState> = {}): LiveState {
  return {
    cwd: process.cwd(),
    workspaceRoot: process.cwd(),
    allowlist: [ALLOWED],
    timeoutMs: 15_000,
    maxOutputChars: undefined,
    trusted: true,
    ...overrides,
  };
}

function liveEnvironment(
  state: LiveState,
  approval: CommandToolEnvironment['approval'] = async () => true,
): CommandToolEnvironment {
  return {
    cwd: () => state.cwd,
    workspaceRoot: () => state.workspaceRoot,
    allowlist: () => state.allowlist,
    timeoutMs: () => state.timeoutMs,
    maxOutputChars: () => state.maxOutputChars,
    trusted: () => state.trusted,
    approval,
  };
}

function agentTool(tools: CommandTools, name: string) {
  const found = tools.toAgentTools().find((tool) => tool.name === name);
  expect(found, `tool ${name} must be registered`).to.not.equal(undefined);
  if (found === undefined) {
    throw new Error(`missing tool ${name}`);
  }
  return found;
}

suite('live command configuration and trust (D3)', () => {
  test('an allowlist edited after construction takes effect without a reload', async () => {
    const state = liveState({ allowlist: [] });
    const tools = new CommandTools(liveEnvironment(state));
    const check = agentTool(tools, 'check_command');

    const before = await check.execute({ command: ALLOWED });
    expect(before.ok).to.equal(false);
    expect(before.output).to.contain('not in the configured validation allowlist');

    state.allowlist = [ALLOWED];
    const after = await check.execute({ command: ALLOWED });
    expect(after.ok).to.equal(true);
    expect(after.output).to.contain('"allowed": true');
  });

  test('granting workspace trust after construction enables execution', async () => {
    const state = liveState({ trusted: false });
    const tools = new CommandTools(liveEnvironment(state));
    const run = agentTool(tools, 'run_command');

    const refused = await run.execute({ command: ALLOWED });
    expect(refused.ok).to.equal(false);
    expect(refused.error).to.equal('Workspace trust is required before running validation commands.');

    state.trusted = true;
    const granted = await run.execute({ command: ALLOWED });
    expect(granted.ok).to.equal(true);
    expect(granted.output).to.contain('"exitCode": 0');
  });

  test('revoking trust while the approval modal is open fails closed', async () => {
    const state = liveState({ trusted: true });
    const tools = new CommandTools(
      liveEnvironment(state, async () => {
        state.trusted = false;
        return true;
      }),
    );

    const result = await agentTool(tools, 'run_command').execute({ command: ALLOWED });
    expect(result.ok).to.equal(false);
    expect(result.error).to.equal('Workspace trust is required before running validation commands.');
  });

  test('narrowing the allowlist while the approval modal is open fails closed', async () => {
    const state = liveState();
    const tools = new CommandTools(
      liveEnvironment(state, async () => {
        state.allowlist = [];
        return true;
      }),
    );

    const result = await agentTool(tools, 'run_command').execute({ command: ALLOWED });
    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('not in the configured validation allowlist');
  });

  test('a working directory changed after construction is re-resolved and contained', async () => {
    const state = liveState();
    const tools = new CommandTools(liveEnvironment(state));
    const run = agentTool(tools, 'run_command');

    const inside = await run.execute({ command: ALLOWED });
    expect(inside.ok).to.equal(true);

    state.cwd = tmpdir();
    const outside = await run.execute({ command: ALLOWED });
    expect(outside.ok).to.equal(false);
    expect(outside.error).to.equal('The working directory is outside the workspace.');
  });

  test('the output limit is read at execution time', async () => {
    const state = liveState({ allowlist: [VERBOSE], maxOutputChars: 1_000 });
    const tools = new CommandTools(liveEnvironment(state));
    const run = agentTool(tools, 'run_command');

    const limited = await run.execute({ command: VERBOSE });
    expect(limited.ok).to.equal(true);
    expect(limited.output).to.contain('"truncated": true');

    state.maxOutputChars = 100_000;
    const unlimited = await run.execute({ command: VERBOSE });
    expect(unlimited.ok).to.equal(true);
    expect(unlimited.output).to.contain('"truncated": false');
  });

  test('the command timeout is read at execution time and exposed to the registry', () => {
    const state = liveState({ timeoutMs: 4_321 });
    const tools = new CommandTools(liveEnvironment(state));
    expect(agentTool(tools, 'run_command').timeoutMs).to.equal(4_321);
    expect(agentTool(tools, 'run_validation_command').timeoutMs).to.equal(4_321);

    state.timeoutMs = 9_876;
    expect(agentTool(tools, 'run_command').timeoutMs).to.equal(9_876);
    expect(agentTool(tools, 'run_validation_command').timeoutMs).to.equal(9_876);
  });

  test('the credential resolver runs after approval, never at construction', async () => {
    const state = liveState();
    let resolutions = 0;
    let approvedFirst = false;
    const tools = new CommandTools({
      ...liveEnvironment(state, async () => {
        approvedFirst = true;
        return true;
      }),
      secret: async () => {
        resolutions += 1;
        expect(approvedFirst).to.equal(true);
        return undefined;
      },
    });
    expect(resolutions).to.equal(0);

    const result = await agentTool(tools, 'run_command').execute({ command: ALLOWED });
    expect(result.ok).to.equal(true);
    expect(resolutions).to.equal(1);
  });

  test('approval is still mandatory with live settings', async () => {
    const state = liveState();
    const tools = new CommandTools(liveEnvironment(state, async () => false));
    const result = await agentTool(tools, 'run_command').execute({ command: ALLOWED });
    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('requires explicit approval');
  });

  test('a destructive command stays refused even when the live allowlist lists it', async () => {
    const state = liveState({ allowlist: ['rm -rf /'] });
    const tools = new CommandTools(liveEnvironment(state));
    const result = await agentTool(tools, 'run_command').execute({ command: 'rm -rf /' });
    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('Destructive commands are not permitted');
  });

  test('static configuration values are still accepted', async () => {
    const tools = new CommandTools({
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      allowlist: [ALLOWED],
      timeoutMs: 15_000,
      trusted: true,
      approval: async () => true,
    });
    const result = await agentTool(tools, 'run_command').execute({ command: ALLOWED });
    expect(result.ok).to.equal(true);
    expect(agentTool(tools, 'run_command').timeoutMs).to.equal(15_000);
  });
});

suite('command tool cancellation (D3, D2)', () => {
  test('an already aborted signal refuses before approval is requested', async () => {
    const controller = new AbortController();
    let approvals = 0;
    const tools = new CommandTools(
      liveEnvironment(liveState(), async () => {
        approvals += 1;
        return true;
      }),
    );
    controller.abort();

    const result = await tools.runCommand(ALLOWED, undefined, controller.signal);
    expect(result.ok).to.equal(false);
    expect(result.error).to.equal('The command was cancelled before it started.');
    expect(approvals).to.equal(0);
  });

  test('cancelling while the approval modal is open refuses execution', async () => {
    const controller = new AbortController();
    const tools = new CommandTools(
      liveEnvironment(liveState(), async () => {
        controller.abort();
        return true;
      }),
    );

    const result = await tools.runCommand(ALLOWED, undefined, controller.signal);
    expect(result.ok).to.equal(false);
    expect(result.error).to.equal('The command was cancelled while awaiting approval.');
  });

  test('the registry forwards its execution signal into the command tool', async () => {
    const controller = new AbortController();
    const tools = new CommandTools(liveEnvironment(liveState()));
    const registry = new AgentToolRegistry();
    for (const tool of tools.toAgentTools()) {
      registry.register(tool);
    }
    controller.abort();

    const result = await registry.execute(
      { id: 'call-1', name: 'run_validation_command', arguments: { command: ALLOWED } },
      { signal: controller.signal },
    );
    expect(result.ok).to.equal(false);
    expect(result.error).to.equal('Tool "run_validation_command" was cancelled before it started.');
  });

  test('the registry grants the command tool its own timeout plus a grace margin', async () => {
    const state = liveState({ timeoutMs: 2_000 });
    const tools = new CommandTools(liveEnvironment(state));
    const registry = new AgentToolRegistry();
    for (const tool of tools.toAgentTools()) {
      registry.register(tool);
    }

    const result = await registry.execute({
      id: 'call-1',
      name: 'run_command',
      arguments: { command: ALLOWED },
    });
    expect(result.ok).to.equal(true);
    expect(result.output).to.contain('"exitCode": 0');
  });
});