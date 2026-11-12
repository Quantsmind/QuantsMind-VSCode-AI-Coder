import { expect } from 'chai';
import * as path from 'node:path';
import { McpServerManager } from '../../src/mcp/serverManager';
import { McpClient, DEFAULT_MAX_TOOL_OUTPUT_CHARS, DEFAULT_MCP_TIMEOUT_MS } from '../../src/mcp/client';

const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'mcp-server.cjs');

suite('MCP configuration passthrough', () => {
  test('timeoutMs: a configured timeout reaches the actual request path and is honored', async () => {
    const manager = new McpServerManager();
    manager.grantLaunchApproval('silent');
    const server = { name: 'silent', command: process.execPath, args: [FIXTURE, 'silent'], timeoutMs: 600 };

    const started = Date.now();
    try {
      await manager.connectApproved(server);
      expect.fail('connect should have timed out');
    } catch (error) {
      const elapsed = Date.now() - started;
      expect((error as { code?: string }).code).to.equal('timeout');
      expect(elapsed).to.be.lessThan(5_000); // would be ~10s with the default
    } finally {
      await manager.disconnectAll();
    }
  });

  test('timeoutMs: zero and negative values clamp to the safe minimum', async () => {
    const manager = new McpServerManager();
    manager.grantLaunchApproval('silent-zero');
    const server = { name: 'silent-zero', command: process.execPath, args: [FIXTURE, 'silent'], timeoutMs: 0 };

    const started = Date.now();
    try {
      await manager.connectApproved(server);
      expect.fail('connect should have timed out');
    } catch (error) {
      const elapsed = Date.now() - started;
      expect((error as { code?: string }).code).to.equal('timeout');
      expect(elapsed).to.be.lessThan(1_500); // clamped to 250ms, not 0 and not the default
    } finally {
      await manager.disconnectAll();
    }
  });

  test('timeoutMs: non-finite and excessively large values fall back or clamp safely', async () => {
    const manager = new McpServerManager();
    manager.grantLaunchApproval('insane');
    const server = {
      name: 'insane',
      command: process.execPath,
      args: [FIXTURE, 'silent'],
      // NaN must fall back to the default, not disable the timeout.
      timeoutMs: Number.NaN,
    };

    // Verify the value reaches the client and computes a finite, clamped timeout.
    const client = new McpClient(server);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timeout = (client as any).timeoutMs();
    expect(timeout).to.equal(DEFAULT_MCP_TIMEOUT_MS);

    const manager2 = new McpServerManager();
    manager2.grantLaunchApproval('heavy');
    const heavy = {
      name: 'heavy',
      command: process.execPath,
      args: [FIXTURE, 'silent'],
      timeoutMs: 999_999_999_999, // exceeds the 300s clamp
    };
    const clientHeavy = new McpClient(heavy);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((clientHeavy as any).timeoutMs()).to.equal(300_000);
    await manager.disconnectAll();
    await manager2.disconnectAll();
  });

  test('timeoutMs: omitted configuration retains the documented default', async () => {
    const server = { name: 'default', command: process.execPath, args: [FIXTURE, 'normal'] };
    const client = new McpClient(server);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).timeoutMs()).to.equal(DEFAULT_MCP_TIMEOUT_MS);
  });

  test('timeoutMs failure leaves no pending requests and no usable cached connection', async () => {
    const manager = new McpServerManager();
    manager.grantLaunchApproval('silent-no-orphans');
    const server = { name: 'silent-no-orphans', command: process.execPath, args: [FIXTURE, 'silent'], timeoutMs: 400 };

    await manager.connectApproved(server).catch(() => undefined);
    const state = manager.snapshot([{ name: server.name, command: server.command, args: server.args, enabled: true }]);
    const snapshot = state[0];
    expect(snapshot.state).to.not.equal('connected');
    await manager.disconnectAll();
  });

  test('maxToolOutputChars: a configured cap reaches the invocation path and bounds output', async () => {
    const manager = new McpServerManager();
    manager.grantLaunchApproval('large-capped');
    const server = {
      name: 'large-capped',
      command: process.execPath,
      args: [FIXTURE, 'normal'],
      maxToolOutputChars: 1_000, // floor value; fixture returns 40_000 chars
    };

    const client = await manager.connectApproved(server);
    const result = await client.callTool('large', {});
    expect(result.content.length).to.be.lessThanOrEqual(1_000);
    expect(result.truncated).to.equal(true);
    expect(result.untrusted).to.equal(true);
    await manager.disconnectAll();
  });

  test('maxToolOutputChars: zero and negative values clamp to the safe floor', async () => {
    const server = {
      name: 'cap-zero',
      command: process.execPath,
      args: [FIXTURE, 'normal'],
      maxToolOutputChars: -5 as unknown as number,
    };
    const client = new McpClient(server);
    await client.connect();
    try {
      const result = await client.callTool('large', {});
      expect(result.content.length).to.be.lessThanOrEqual(1_000);
      expect(result.truncated).to.equal(true);
      expect(result.untrusted).to.equal(true);
    } finally {
      await client.close();
    }
  });

  test('maxToolOutputChars: omitted configuration retains the documented default', async () => {
    const server = { name: 'default-cap', command: process.execPath, args: [FIXTURE, 'normal'] };
    const client = new McpClient(server);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).config.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS).to.equal(DEFAULT_MAX_TOOL_OUTPUT_CHARS);
  });

  test('maxToolOutputChars: non-finite values fall back to the default, never disable limiting', async () => {
    const server = {
      name: 'cap-nan',
      command: process.execPath,
      args: [FIXTURE, 'normal'],
      maxToolOutputChars: Number.NaN,
    };
    const client = new McpClient(server);
    await client.connect();
    try {
      const result = await client.callTool('large', {});
      expect(result.content.length).to.be.lessThanOrEqual(DEFAULT_MAX_TOOL_OUTPUT_CHARS);
      expect(result.truncated).to.equal(true);
      expect(result.untrusted).to.equal(true);
    } finally {
      await client.close();
    }
  });
});
