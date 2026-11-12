import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpTools, type McpToolEnvironment } from '../../src/mcp/mcpTools';
import { McpServerManager } from '../../src/mcp/serverManager';

const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'mcp-server.cjs');

const tempRoots: string[] = [];
const spawnedManagers: McpServerManager[] = [];

function trackManager<M extends McpServerManager>(manager: M): M {
  spawnedManagers.push(manager);
  return manager;
}

function tempLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantsmind-mcp-spy-'));
  tempRoots.push(dir);
  return path.join(dir, 'methods.log');
}

suiteTeardown(async () => {
  for (const manager of spawnedManagers.splice(0)) {
    await manager.disconnectAll().catch(() => undefined);
  }
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface Harness {
  readonly manager: McpServerManager;
  readonly tools: McpTools;
  readonly approvals: { operation: string }[];
}

function harness(env: {
  readonly logFile?: string;
  readonly launchApproved?: boolean;
  readonly callApproved?: boolean;
  readonly trusted?: boolean;
}): Harness {
  const manager = trackManager(new McpServerManager());
  const approvals: { operation: string }[] = [];
  const serverArgs = env.logFile !== undefined ? ['spy', env.logFile] : [];
  const tools = new McpTools({
    servers: () => [{ name: 'fixture', command: process.execPath, args: [FIXTURE, ...serverArgs], enabled: true }],
    trusted: () => env.trusted !== false,
    manager,
    approval: async (request) => {
      approvals.push(request);
      return env.callApproved !== false;
    },
    launchApproval: async (request) => {
      approvals.push({ operation: request.name ? `launch:${request.name}` : 'launch' });
      return env.launchApproved !== false;
    },
  } satisfies McpToolEnvironment);
  return { manager, tools, approvals };
}

const readLog = (logFile: string | undefined): string[] => {
  if (logFile === undefined || !fs.existsSync(logFile)) {
    return [];
  }
  return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
};

suite('MCP security boundaries', () => {
  test('launching a newly configured server without approval never starts it', async () => {
    const logFile = tempLog();
    const { tools, approvals } = harness({ logFile, launchApproved: false });

    const result = await tools.callTool({ server: 'fixture', tool: 'echo', arguments: { text: 'x' } });

    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('approval');
    expect(readLog(logFile)).to.deep.equal([]); // server was never spawned
    expect(approvals.some((request) => request.operation.startsWith('launch'))).to.equal(true);
  });

  test('an unapproved invocation never reaches the server tool handler', async () => {
    const logFile = tempLog();
    const { manager, tools } = harness({ logFile, launchApproved: true, callApproved: false });
    manager.grantLaunchApproval('fixture');

    const result = await tools.callTool({ server: 'fixture', tool: 'echo', arguments: { text: 'hello' } });

    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('explicit approval');
    const methods = readLog(logFile);
    expect(methods).to.contain('initialize');
    expect(methods).to.contain('tools/list');
    expect(methods).to.not.contain('tools/call');
  });

  test('discovering tools never invokes a tool', async () => {
    const logFile = tempLog();
    const { manager, tools } = harness({ logFile, launchApproved: true });
    manager.grantLaunchApproval('fixture');

    const result = await tools.listTools({ server: 'fixture' });

    expect(result.ok).to.equal(true);
    const methods = readLog(logFile);
    expect(methods).to.contain('initialize');
    expect(methods).to.contain('tools/list');
    expect(methods).to.not.contain('tools/call');
  });

  test('an approved invocation reaches the server and output is delimited and marked untrusted', async () => {
    const logFile = tempLog();
    const { manager, tools } = harness({ logFile, launchApproved: true, callApproved: true });
    manager.grantLaunchApproval('fixture');

    const result = await tools.callTool({ server: 'fixture', tool: 'echo', arguments: { text: 'hello world' } });

    expect(result.ok).to.equal(true);
    expect(result.output).to.contain('<untrusted-mcp-output');
    expect(result.output).to.contain('hello world');
    expect(readLog(logFile)).to.contain('tools/call');
  });

  test('calls to an unknown tool fail before the server tool handler runs', async () => {
    const logFile = tempLog();
    const { manager, tools } = harness({ logFile, launchApproved: true, callApproved: true });
    manager.grantLaunchApproval('fixture');

    const result = await tools.callTool({ server: 'fixture', tool: 'no-such-tool', arguments: {} });

    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('does not expose a tool');
    expect(readLog(logFile)).to.not.contain('tools/call');
  });

  test('workspace trust denial blocks every MCP operation', async () => {
    const logFile = tempLog();
    const { manager, tools } = harness({ logFile, trusted: false });
    manager.grantLaunchApproval('fixture');

    const list = await tools.listTools({});
    const call = await tools.callTool({ server: 'fixture', tool: 'echo', arguments: {} });

    expect(list.ok).to.equal(false);
    expect(list.error).to.contain('trust');
    expect(call.ok).to.equal(false);
    expect(call.error).to.contain('trust');
    expect(readLog(logFile)).to.deep.equal([]);
  });

  test('connections are cached: one process serves repeated calls', async () => {
    const logFile = tempLog();
    const { manager } = harness({ logFile, launchApproved: true });
    manager.grantLaunchApproval('fixture');
    const server = { name: 'fixture', command: process.execPath, args: [FIXTURE, 'spy', logFile] };

    const first = await manager.connectApproved(server);
    const second = await manager.connectApproved(server);

    expect(second).to.equal(first);
    await manager.disconnectAll();
    expect(readLog(logFile)).to.contain('initialize');
  });

  test('a crashed server is reconnected on the next operation', async () => {
    const logFile = tempLog();
    const manager = trackManager(new McpServerManager());
    manager.grantLaunchApproval('fixture');
    const server = { name: 'fixture', command: process.execPath, args: [FIXTURE, 'spy', logFile] };

    const first = await manager.connectApproved(server);
    await first.close(); // simulate a crash/disconnect
    const second = await manager.connectApproved(server);

    expect(second).to.not.equal(first);
    expect(second.isConnected()).to.equal(true);
    await manager.disconnectAll();
  });

  test('an oversized reply drops the connection without hanging', async () => {
    const manager = trackManager(new McpServerManager());
    manager.grantLaunchApproval('fixture');
    const server = { name: 'oversize', command: process.execPath, args: [FIXTURE, 'oversized'], timeoutMs: 5_000 };

    let failure: unknown;
    try {
      await manager.connectApproved(server);
    } catch (error) {
      failure = error;
    }
    expect(failure).to.not.equal(undefined);
    expect(String((failure as Error).message)).to.contain('oversized');
    await manager.disconnectAll();
  });

  test('non-JSON noise in the stream is tolerated', async () => {
    const manager = trackManager(new McpServerManager());
    manager.grantLaunchApproval('fixture');
    const server = { name: 'noise', command: process.execPath, args: [FIXTURE, 'noise'], timeoutMs: 5_000 };

    const client = await manager.connectApproved(server);
    const tools = await client.listTools();
    expect(tools.length).to.be.greaterThan(0);
    await manager.disconnectAll();
  });

  test('concurrent calls are all answered on one connection', async () => {
    const manager = trackManager(new McpServerManager());
    manager.grantLaunchApproval('fixture');
    const server = { name: 'fixture', command: process.execPath, args: [FIXTURE] };

    const client = await manager.connectApproved(server);
    const results = await Promise.all([
      client.callTool('echo', { text: 'a' }),
      client.callTool('echo', { text: 'b' }),
      client.callTool('echo', { text: 'c' }),
      client.callTool('echo', { text: 'd' }),
      client.callTool('echo', { text: 'e' }),
    ]);

    expect(results.map((result) => result.content)).to.deep.equal(['a', 'b', 'c', 'd', 'e']);
    await manager.disconnectAll();
  });

  test('manager disconnectAll cleans up children and state', async () => {
    const manager = trackManager(new McpServerManager());
    manager.grantLaunchApproval('fixture');
    const serverA = { name: 'fixture', command: process.execPath, args: [FIXTURE] };
    const serverB = { name: 'fixture2', command: process.execPath, args: [FIXTURE] };

    await manager.connectApproved(serverA);
    await manager.connectApproved(serverB);
    await manager.disconnectAll();

    expect(manager.snapshot([{ ...serverA, enabled: true }, { ...serverB, enabled: true }]).every((entry) => entry.state === 'disconnected' || entry.state === 'disabled')).to.equal(true);
  });

  test('tool output delimiter marks trusted boundaries even for error results', async () => {
    const logFile = tempLog();
    const { manager, tools } = harness({ logFile, launchApproved: true, callApproved: true });
    manager.grantLaunchApproval('fixture');

    const result = await tools.callTool({ server: 'fixture', tool: 'fail', arguments: {} });

    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('<untrusted-mcp-output');
  });

  test('revoking a cached launch approval forces the approval prompt again', async () => {
    const logFile = tempLog();
    let approvalCalls = 0;
    const manager = trackManager(new McpServerManager());
    const approvals: { operation: string }[] = [];
    const tools = new McpTools({
      servers: () => [{ name: 'fixture', command: process.execPath, args: [FIXTURE, 'spy', logFile], enabled: true }],
      trusted: () => true,
      manager,
      approval: async (request) => {
        approvals.push(request);
        return true;
      },
      launchApproval: async () => {
        approvalCalls += 1;
        return true;
      },
    });

    manager.grantLaunchApproval('fixture');
    const first = await tools.callTool({ server: 'fixture', tool: 'echo', arguments: { text: 'one' } });
    expect(first.ok).to.equal(true);
    expect(approvalCalls).to.equal(0); // cached approval short-circuits the prompt

    manager.revokeLaunchApproval('fixture');
    const second = await tools.callTool({ server: 'fixture', tool: 'echo', arguments: { text: 'two' } });
    expect(second.ok).to.equal(true);
    expect(approvalCalls).to.equal(1); // revocation forces the prompt to be consulted again
  });
});
