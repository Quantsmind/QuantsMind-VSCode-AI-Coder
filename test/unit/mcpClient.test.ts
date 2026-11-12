import { expect } from 'chai';
import * as path from 'node:path';
import { McpClient, McpError, mcpChildEnv } from '../../src/mcp/client';

const server = (mode?: string): { command: string; args: string[] } => ({
  command: process.execPath,
  args: [path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'mcp-server.cjs'), ...(mode !== undefined ? [mode] : [])],
});

suite('mcp client', () => {
  test('performs the initialize handshake, lists and calls tools', async () => {
    const client = new McpClient({ name: 'fixture', ...server(), timeoutMs: 5_000 });
    await client.connect();
    try {
      const tools = await client.listTools();
      expect(tools.map((tool) => tool.name)).to.deep.equal(['echo', 'fail', 'large', 'env']);

      const echo = await client.callTool('echo', { text: 'hello' });
      expect(echo.isError).to.equal(false);
      expect(echo.content).to.contain('hello');
      expect(echo.untrusted).to.equal(true);
    } finally {
      await client.close();
    }
  });

  test('surfaces tool-reported errors with isError', async () => {
    const client = new McpClient({ name: 'fixture', ...server(), timeoutMs: 5_000 });
    await client.connect();
    try {
      const result = await client.callTool('fail', {});
      expect(result.isError).to.equal(true);
      expect(result.content).to.contain('deliberate fixture failure');
    } finally {
      await client.close();
    }
  });

  test('truncates oversized tool output and marks it truncated', async () => {
    const client = new McpClient({ name: 'fixture', ...server(), timeoutMs: 5_000, maxToolOutputChars: 1_000 });
    await client.connect();
    try {
      const result = await client.callTool('large', {});
      expect(result.truncated).to.equal(true);
      expect(result.content.length).to.be.lessThanOrEqual(1_000);
    } finally {
      await client.close();
    }
  });

  test('times out when the server never answers', async () => {
    const client = new McpClient({ name: 'silent', ...server('silent'), timeoutMs: 1_000 });
    try {
      await client.connect();
      expect.fail('connect should not complete against a silent server');
    } catch (error) {
      expect(error).to.be.instanceOf(McpError);
      expect((error as McpError).code).to.equal('timeout');
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  test('reports a server that exits immediately', async () => {
    const client = new McpClient({ name: 'crash', ...server('crash'), timeoutMs: 5_000 });
    try {
      await client.connect();
      expect.fail('connect should not complete against a crashing server');
    } catch (error) {
      expect(error).to.be.instanceOf(McpError);
      expect(['connect', 'closed']).to.include((error as McpError).code);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  test('surfaces server-reported tool errors', async () => {
    const client = new McpClient({ name: 'fixture', ...server(), timeoutMs: 5_000 });
    await client.connect();
    try {
      let threw: unknown;
      try {
        await client.callTool('no-such-tool', {});
      } catch (error) {
        threw = error;
      }
      expect(threw).to.be.instanceOf(McpError);
      expect((threw as McpError).code).to.equal('server');
    } finally {
      await client.close();
    }
  });

  test('builds a sanitized child environment without ambient secrets', async () => {
    process.env.QUANTSMIND_TEST_SECRET_SHOULD_NOT_LEAK = 'super-secret-value-12345';
    try {
      const env = mcpChildEnv();
      expect(env.PATH ?? env.Path).to.not.equal(undefined);
      expect(env.QUANTSMIND_TEST_SECRET_SHOULD_NOT_LEAK).to.equal(undefined);

      const client = new McpClient({ name: 'fixture', ...server(), timeoutMs: 5_000 });
      await client.connect();
      try {
        const echoed = await client.callTool('env', {});
        expect(echoed.content).to.not.contain('super-secret-value-12345');
      } finally {
        await client.close();
      }
    } finally {
      delete process.env.QUANTSMIND_TEST_SECRET_SHOULD_NOT_LEAK;
    }
  });

  test('refuses commands with shell metacharacters', async () => {
    const client = new McpClient({ name: 'fixture', command: 'node; rm -rf x' });
    try {
      await client.connect();
      expect.fail('connect should refuse metacharacters');
    } catch (error) {
      expect(error).to.be.instanceOf(McpError);
      expect((error as McpError).code).to.equal('disabled');
    }
  });
});
