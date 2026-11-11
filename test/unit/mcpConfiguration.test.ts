import { expect } from 'chai';
import * as path from 'node:path';
import { resolveMcpSettings } from '../../src/config/resolve';
import { McpServerManager } from '../../src/mcp/serverManager';

const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'mcp-server.cjs');
const spawnedManagers: McpServerManager[] = [];

suiteTeardown(async () => {
  for (const manager of spawnedManagers.splice(0)) {
    await manager.disconnectAll().catch(() => undefined);
  }
});

function track<M extends McpServerManager>(manager: M): M {
  spawnedManagers.push(manager);
  return manager;
}

suite('mcp configuration parsing (v2.5.2)', () => {
  test('legacy configuration without overrides receives defaults', () => {
    const resolved = resolveMcpSettings({
      servers: [{ name: 'github', command: 'node', args: ['server.cjs'] }],
    });

    expect(resolved.servers[0]?.timeoutMs).to.equal(10_000);
    expect(resolved.servers[0]?.maxToolOutputChars).to.equal(20_000);
  });

  test('per-server timeoutMs and maxToolOutputChars are honored independently', () => {
    const resolved = resolveMcpSettings({
      servers: [
        { name: 'a', command: 'node', timeoutMs: 1_000, maxToolOutputChars: 1_500 },
        { name: 'b', command: 'node' }, // defaults
        { name: 'c', command: 'node', timeoutMs: 45_000, maxToolOutputChars: 50_000 },
      ],
    });

    expect(resolved.servers[0]?.timeoutMs).to.equal(1_000);
    expect(resolved.servers[0]?.maxToolOutputChars).to.equal(1_500);
    expect(resolved.servers[1]?.timeoutMs).to.equal(10_000);
    expect(resolved.servers[1]?.maxToolOutputChars).to.equal(20_000);
    expect(resolved.servers[2]?.timeoutMs).to.equal(45_000);
    expect(resolved.servers[2]?.maxToolOutputChars).to.equal(50_000);
  });

  test('out-of-range numbers clamp to documented bounds', () => {
    const resolved = resolveMcpSettings({
      servers: [
        { name: 'low', command: 'node', timeoutMs: 1, maxToolOutputChars: 1 },
        { name: 'high', command: 'node', timeoutMs: 9_999_999, maxToolOutputChars: 9_999_999 },
      ],
    });

    expect(resolved.servers[0]?.timeoutMs).to.equal(250);
    expect(resolved.servers[0]?.maxToolOutputChars).to.equal(1_000);
    expect(resolved.servers[1]?.timeoutMs).to.equal(300_000);
    expect(resolved.servers[1]?.maxToolOutputChars).to.equal(200_000);
  });

  test('non-finite numbers fall back to the documented defaults', () => {
    const resolved = resolveMcpSettings({
      servers: [
        { name: 'nan', command: 'node', timeoutMs: Number.NaN, maxToolOutputChars: Number.NaN },
        { name: 'inf', command: 'node', timeoutMs: Number.POSITIVE_INFINITY, maxToolOutputChars: Number.POSITIVE_INFINITY },
      ],
    });

    expect(resolved.servers[0]?.timeoutMs).to.equal(10_000);
    expect(resolved.servers[0]?.maxToolOutputChars).to.equal(20_000);
    expect(resolved.servers[1]?.timeoutMs).to.equal(10_000);
    expect(resolved.servers[1]?.maxToolOutputChars).to.equal(20_000);
  });

  test('non-numeric values fall back to defaults rather than disabling runtime guards', () => {
    const resolved = resolveMcpSettings({
      servers: [
        { name: 'n', command: 'node', timeoutMs: '15000' as unknown as number, maxToolOutputChars: '30000' as unknown as number },
      ],
    });

    expect(resolved.servers[0]?.timeoutMs).to.equal(10_000);
    expect(resolved.servers[0]?.maxToolOutputChars).to.equal(20_000);
  });

  test('mixed legacy and configured servers resolve consistently in one document', () => {
    const resolved = resolveMcpSettings({
      servers: [
        { name: 'stream-min', command: 'node', timeoutMs: 250 },
        { name: 'defaults', command: 'node' },
        { name: 'stream-max', command: 'node', timeoutMs: 300_000, maxToolOutputChars: 200_000 },
      ],
    });

    expect(resolved.servers.map((server) => server.timeoutMs)).to.deep.equal([250, 10_000, 300_000]);
    expect(resolved.servers.map((server) => server.maxToolOutputChars)).to.deep.equal([20_000, 20_000, 200_000]);
  });
});

suite('McpServerManager configuration passthrough (v2.5.2)', () => {
  test('a configured timeoutMs reaches the client and bounds output', async () => {
    const manager = track(new McpServerManager());
    manager.grantLaunchApproval('capped');
    const server = { name: 'capped', command: process.execPath, args: [FIXTURE], timeoutMs: 1_500, maxToolOutputChars: 1_111 };

    const client = await manager.connectApproved(server);
    const tools = await client.listTools();
    expect(tools.length).to.be.greaterThan(0);

    const result = await client.callTool('large', {});
    expect(result.content.length).to.be.lessThanOrEqual(1_111);
    expect(result.truncated).to.equal(true);
  });

  test('configuration change evicts the stale connection and revokes launch approval', async () => {
    const manager = track(new McpServerManager());
    manager.grantLaunchApproval('reload');
    const base = { name: 'reload', command: process.execPath, args: [FIXTURE] };
    const first = await manager.connectApproved({ ...base, timeoutMs: 1_500 });
    expect(manager.hasLaunchApproval('reload')).to.equal(true);

    // Same name/command/args but a different timeoutMs must force a fresh connection.
    const second = await manager.connectApproved({ ...base, timeoutMs: 2_500 });

    expect(second).to.not.equal(first);
    expect(first.isConnected()).to.equal(false);
    expect(manager.hasLaunchApproval('reload')).to.equal(false);
  });

  test('identical configuration reuses the cached connection', async () => {
    const manager = track(new McpServerManager());
    manager.grantLaunchApproval('cached');
    const server = { name: 'cached', command: process.execPath, args: [FIXTURE], timeoutMs: 1_000, maxToolOutputChars: 5_000 };

    const first = await manager.connectApproved(server);
    const second = await manager.connectApproved(server);

    expect(second).to.equal(first);
    expect(first.isConnected()).to.equal(true);
  });

  test('per-server independent settings coexist in one manager', async () => {
    const manager = track(new McpServerManager());
    manager.grantLaunchApproval('small');
    manager.grantLaunchApproval('large');

    const small = await manager.connectApproved({ name: 'small', command: process.execPath, args: [FIXTURE], maxToolOutputChars: 1_000 });
    const large = await manager.connectApproved({ name: 'large', command: process.execPath, args: [FIXTURE], maxToolOutputChars: 200_000 });

    const smallResult = await small.callTool('large', {});
    const largeResult = await large.callTool('large', {});

    expect(smallResult.content.length).to.be.lessThanOrEqual(1_000);
    expect(smallResult.truncated).to.equal(true);
    expect(largeResult.content.length).to.be.greaterThan(20_000);
    expect(largeResult.truncated).to.equal(false);
  });
});
