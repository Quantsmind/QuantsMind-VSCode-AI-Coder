import { expect } from 'chai';
import { resolveMcpSettings } from '../../src/config/resolve';
import {
  mcpCredentialSecretKey,
  storeMcpCredential,
  readMcpCredential,
  hasMcpCredential,
  deleteMcpCredential,
} from '../../src/mcp/credentials';
import { MemorySecretStorage } from './helpers';
import { McpServerManager } from '../../src/mcp/serverManager';
import { McpTools, type McpToolEnvironment } from '../../src/mcp/mcpTools';
import type { LiveValue } from '../../src/agent/commandTools';

suite('remote MCP configuration resolution (v2.5.3)', () => {
  test('legacy stdio entries resolve unchanged with no auth and no url', () => {
    const resolved = resolveMcpSettings({
      servers: [{ name: 'legacy', command: 'node', args: ['server.cjs'] }],
    });

    expect(resolved.servers).to.have.length(1);
    expect(resolved.servers[0]).to.deep.include({
      name: 'legacy',
      transport: 'stdio',
      command: 'node',
      enabled: true,
      auth: 'none',
      timeoutMs: 10_000,
      maxToolOutputChars: 20_000,
    });
    expect(resolved.servers[0]?.url).to.equal(undefined);
  });

  test('explicit transport: stdio resolves like a legacy entry', () => {
    const resolved = resolveMcpSettings({
      servers: [{ name: 'stdio-explicit', transport: 'stdio', command: 'node' }],
    });

    expect(resolved.servers[0]?.transport).to.equal('stdio');
  });

  test('streamable-http entries resolve with endpoint and auth', () => {
    const resolved = resolveMcpSettings({
      servers: [{ name: 'remote', transport: 'streamable-http', url: 'https://mcp.example.com/v1/mcp', auth: 'bearer', enabled: false }],
    });

    expect(resolved.servers[0]).to.deep.include({
      name: 'remote',
      transport: 'streamable-http',
      enabled: false,
      auth: 'bearer',
      url: 'https://mcp.example.com/v1/mcp',
    });
    expect(resolved.servers[0]?.command).to.equal(undefined);
  });

  test('streamable-http defaults auth to none and normalizes the endpoint', () => {
    const resolved = resolveMcpSettings({
      servers: [{ name: 'remote', transport: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
    });

    expect(resolved.servers[0]?.auth).to.equal('none');
  });

  test('unknown transport and unknown auth values reject the entry', () => {
    const resolved = resolveMcpSettings({
      servers: [
        { name: 'bad-transport', transport: 'http', url: 'https://mcp.example.com/mcp' },
        { name: 'bad-transport-2', transport: 'sse', command: 'node' },
        { name: 'bad-auth', transport: 'streamable-http', url: 'https://mcp.example.com/mcp', auth: 'basic' },
        { name: 'bad-auth-2', transport: 'streamable-http', url: 'https://mcp.example.com/mcp', auth: 'oauth' },
      ],
    });

    expect(resolved.servers).to.deep.equal([]);
  });

  test('bearer authentication on a stdio server rejects the entry', () => {
    const resolved = resolveMcpSettings({
      servers: [{ name: 'wrong', transport: 'stdio', command: 'node', auth: 'bearer' }],
    });

    expect(resolved.servers).to.deep.equal([]);
  });

  test('streamable-http entries reject stdio launch fields as ambiguous', () => {
    const withCommand = resolveMcpSettings({
      servers: [{ name: 'ambiguous', transport: 'streamable-http', url: 'https://mcp.example.com/mcp', command: 'node' }],
    });
    const withArgs = resolveMcpSettings({
      servers: [{ name: 'ambiguous-2', transport: 'streamable-http', url: 'https://mcp.example.com/mcp', args: ['x'] }],
    });

    expect(withCommand.servers).to.deep.equal([]);
    expect(withArgs.servers).to.deep.equal([]);
  });

  test('endpoints must satisfy https/loopback rules; userinfo/query/fragment are rejected', () => {
    const rejected = [
      'http://mcp.example.com/mcp',
      'https://user:pass@mcp.example.com/mcp',
      'https://mcp.example.com/mcp?token=abc',
      'https://mcp.example.com/mcp#frag',
      'ftp://mcp.example.com/mcp',
      'file:///tmp/x',
      'not a url',
      '',
    ];
    for (const url of rejected) {
      const resolved = resolveMcpSettings({ servers: [{ name: 'remote', transport: 'streamable-http', url }] });
      expect(resolved.servers, `expected rejection for ${url}`).to.deep.equal([]);
    }

    const accepted = resolveMcpSettings({
      servers: [
        { name: 'https-ok', transport: 'streamable-http', url: 'https://mcp.example.com/mcp' },
        { name: 'loopback', transport: 'streamable-http', url: 'http://127.0.0.1:8734/mcp' },
        { name: 'loopback2', transport: 'streamable-http', url: 'http://localhost/mcp' },
      ],
    });
    expect(accepted.servers.map((server) => server.name)).to.deep.equal(['https-ok', 'loopback', 'loopback2']);
  });

  test('streamable-http entries without a url are rejected', () => {
    const resolved = resolveMcpSettings({ servers: [{ name: 'remote', transport: 'streamable-http' }] });

    expect(resolved.servers).to.deep.equal([]);
  });

  test('mixed legacy stdio and remote entries coexist with independent limits', () => {
    const resolved = resolveMcpSettings({
      servers: [
        { name: 'local', command: 'node', args: ['server.cjs'], timeoutMs: 5_000 },
        { name: 'remote', transport: 'streamable-http', url: 'https://mcp.example.com/mcp', auth: 'bearer', maxToolOutputChars: 50_000 },
      ],
    });

    expect(resolved.servers).to.have.length(2);
    expect(resolved.servers[0]).to.deep.include({ transport: 'stdio', timeoutMs: 5_000, maxToolOutputChars: 20_000 });
    expect(resolved.servers[1]).to.deep.include({ transport: 'streamable-http', auth: 'bearer', maxToolOutputChars: 50_000, timeoutMs: 10_000 });
  });

  test('a stray url on a stdio entry is ignored (legacy fallback stays stdio)', () => {
    const resolved = resolveMcpSettings({
      servers: [{ name: 'legacy', command: 'node', url: 'https://mcp.example.com/mcp' }],
    });

    expect(resolved.servers[0]?.transport).to.equal('stdio');
    expect(resolved.servers[0]?.url).to.equal(undefined);
  });
});

suite('mcp credential storage (SecretStorage-backed)', () => {
  test('stores and deletes the credential under the namespaced per-server key', async () => {
    const storage = new MemorySecretStorage();

    expect(await hasMcpCredential(storage, 'remote')).to.equal(false);
    await storeMcpCredential(storage, 'remote', 'token-value');
    expect(await hasMcpCredential(storage, 'remote')).to.equal(true);
    expect(await readMcpCredential(storage, 'remote')).to.equal('token-value');
    expect(storage.values.has('quantsmind.mcp.credential.remote')).to.equal(true);

    await deleteMcpCredential(storage, 'remote');
    expect(await hasMcpCredential(storage, 'remote')).to.equal(false);
    expect(storage.values.size).to.equal(0);
  });

  test('rejects invalid credentials without writing to storage', async () => {
    const storage = new MemorySecretStorage();

    let failure: unknown;
    try {
      await storeMcpCredential(storage, 'remote', 'has spaces in it');
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(Error);
    expect(storage.values.size).to.equal(0);
  });

  test('a server name cannot escape the namespaced key', () => {
    expect(() => mcpCredentialSecretKey('../other')).to.throw();
    expect(() => mcpCredentialSecretKey('ok-name_1.2')).to.not.throw();
  });
});

suite('remote approval flow (McpTools)', () => {
  const REMOTE_SERVER = {
    name: 'remote',
    transport: 'streamable-http',
    url: 'http://127.0.0.1:1/mcp',
    auth: 'bearer',
    enabled: true,
  } as const;
  const staticLive = <T,>(value: T): LiveValue<T> => () => value;

  function harness(env: { launchApproved?: boolean; callApproved?: boolean; trusted?: boolean }) {
    const approvals: { operation: string }[] = [];
    const launchRequests: { endpoint?: string; transport?: string; auth?: string }[] = [];
    const manager = new McpServerManager();
    const tools = new McpTools({
      servers: staticLive([REMOTE_SERVER] as const),
      trusted: staticLive(env.trusted !== false),
      manager,
      approval: async () => env.callApproved !== false,
      launchApproval: async (request) => {
        launchRequests.push(request);
        approvals.push({ operation: `launch:${request.name}` });
        return env.launchApproved !== false;
      },
    } satisfies McpToolEnvironment);
    return { manager, tools, approvals, launchRequests };
  }

  test('the approval request carries the endpoint, transport and auth scheme', async () => {
    const { tools, launchRequests } = harness({ launchApproved: false });

    const result = await tools.callTool({ server: 'remote', tool: 'echo', arguments: {} });

    expect(result.ok).to.equal(false);
    expect(launchRequests).to.have.length(1);
    expect(launchRequests[0]?.endpoint).to.equal('http://127.0.0.1:1/mcp');
    expect(launchRequests[0]?.transport).to.equal('streamable-http');
    expect(launchRequests[0]?.auth).to.equal('bearer');
  });

  test('workspace trust blocks MCP operations before any network access', async () => {
    const { tools, launchRequests } = harness({ trusted: false });

    const result = await tools.callTool({ server: 'remote', tool: 'echo', arguments: {} });

    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('trust');
    expect(launchRequests).to.have.length(0);
  });

  test('a denied launch approval never opens a connection', async () => {
    const { tools, manager, launchRequests } = harness({ launchApproved: false });

    const result = await tools.listTools({ server: 'remote' });

    expect(launchRequests).to.have.length(1);
    expect(manager.hasLaunchApproval('remote')).to.equal(false);
    expect(result.output ?? '').to.contain('not approved');
  });
});
