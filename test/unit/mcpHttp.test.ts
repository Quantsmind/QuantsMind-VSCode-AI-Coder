import { expect } from 'chai';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpError } from '../../src/mcp/client';
import { McpServerManager } from '../../src/mcp/serverManager';
import { parseMcpEndpoint } from '../../src/mcp/endpoint';
import { MemorySecretStorage } from './helpers';
import { storeMcpCredential } from '../../src/mcp/credentials';

const HTTP_FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'mcp-http-server.cjs');

interface HttpFixture {
  readonly child: ChildProcess;
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const fixtures: HttpFixture[] = [];

function tempLog(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-http-')), 'spy.log');
}

/** Spawns the deterministic in-repo HTTP fixture and waits for its listening port. */
async function startFixture(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<HttpFixture> {
  const child = spawn(process.execPath, [HTTP_FIXTURE, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const port = await new Promise<number>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('fixture did not report listening in time')), 10_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const match = buffer.match(/listening (\d+)/);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited before listening (code ${String(code)})`));
    });
  });
  const fixture: HttpFixture = {
    child,
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.kill();
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // already gone
          }
          resolve();
        }, 2_000);
      }),
  };
  fixtures.push(fixture);
  return fixture;
}

const managers: McpServerManager[] = [];

function track(manager: McpServerManager): McpServerManager {
  managers.push(manager);
  return manager;
}

suiteTeardown(async () => {
  for (const manager of managers.splice(0)) {
    await manager.disconnectAll().catch(() => undefined);
  }
  for (const fixture of fixtures.splice(0)) {
    await fixture.close().catch(() => undefined);
  }
});

function remoteServer(url: string, overrides: Partial<{ auth: 'none' | 'bearer'; timeoutMs: number; maxToolOutputChars: number }> = {}) {
  return {
    name: 'remote',
    transport: 'streamable-http' as const,
    url,
    auth: overrides.auth ?? 'none',
    enabled: true,
    timeoutMs: overrides.timeoutMs,
    maxToolOutputChars: overrides.maxToolOutputChars,
  };
}

const readSpy = (logFile: string): string[] =>
  fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [];

suite('streamable HTTP transport (deterministic fixture)', () => {
  test('initializes, negotiates the protocol and reports the server identity', async () => {
    const fixture = await startFixture([]);
    const manager = track(new McpServerManager());
    manager.grantLaunchApproval('remote');

    const client = await manager.connectApproved(remoteServer(fixture.url));

    expect(client.isConnected()).to.equal(true);
    expect(client.protocolVersion()).to.equal('2025-06-18');
    expect(client.serverInfo()).to.deep.equal({ name: 'fixture-mcp-http', version: '1.0.0' });
    await manager.disconnectAll();
  });

  test('discovers tools and carries the protocol-version header on subsequent requests', async () => {
    const spy = tempLog();
    const fixture = await startFixture(['--spy', spy]);
    const manager = track(new McpServerManager());
    manager.grantLaunchApproval('remote');

    const tools = await manager.listTools(remoteServer(fixture.url));

    expect(tools.map((tool) => tool.name)).to.deep.equal(['echo', 'fail', 'large']);
    const log = readSpy(spy);
    expect(log).to.contain('method initialize');
    expect(log).to.contain('method tools/list');
    expect(log.filter((line) => line === 'protocol-version 2025-06-18').length).to.be.greaterThanOrEqual(2);
    await manager.disconnectAll();
  });

  test('invokes an approved read-only tool; output is marked untrusted', async () => {
    const spy = tempLog();
    const fixture = await startFixture(['--spy', spy]);
    const manager = track(new McpServerManager());
    manager.grantLaunchApproval('remote');

    const result = await manager.callTool(remoteServer(fixture.url), 'echo', { text: 'hello remote' });

    expect(result.isError).to.equal(false);
    expect(result.content).to.equal('hello remote');
    expect(result.untrusted).to.equal(true);
    expect(readSpy(spy)).to.contain('method tools/call');
    await manager.disconnectAll();
  });

  test('enforces the configured output cap on the HTTP path', async () => {
    const fixture = await startFixture([]);
    const manager = track(new McpServerManager());
    manager.grantLaunchApproval('remote');

    const result = await manager.callTool(remoteServer(fixture.url), 'large', {}, 2_000);

    expect(result.content.length).to.be.lessThanOrEqual(2_000);
    expect(result.truncated).to.equal(true);
    await manager.disconnectAll();
  });

  test('times out a non-responding tool call without hanging', async () => {
    const fixture = await startFixture(['--slow']);
    const manager = track(new McpServerManager());
    manager.grantLaunchApproval('remote');

    let failure: unknown;
    try {
      await manager.callTool(remoteServer(fixture.url, { timeoutMs: 250 }), 'large', {});
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(McpError);
    expect((failure as McpError).code).to.equal('timeout');
    await manager.disconnectAll();
  });

  test('cancels an in-flight HTTP request with an AbortSignal', async () => {
    const fixture = await startFixture(['--slow']);
    const manager = track(new McpServerManager());
    manager.grantLaunchApproval('remote');

    const controller = new AbortController();
    const pending = manager.callTool(remoteServer(fixture.url, { timeoutMs: 30_000 }), 'large', {}, undefined, controller.signal);
    setTimeout(() => controller.abort(), 100);

    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(McpError);
    expect((failure as McpError).code).to.equal('cancelled');
    await manager.disconnectAll();
  });

  test('a network drop fails the call and the next operation initializes a fresh session', async () => {
    const spy = tempLog();
    const fixture = await startFixture(['--destroy', '--spy', spy]);
    const manager = track(new McpServerManager());
    manager.grantLaunchApproval('remote');

    let failure: unknown;
    try {
      await manager.callTool(remoteServer(fixture.url), 'echo', { text: 'x' });
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(McpError);
    expect(['connect', 'closed']).to.include((failure as McpError).code);
    expect(readSpy(spy).filter((line) => line === 'method tools/call')).to.have.length(1); // no replay
    await manager.disconnectAll();
  });

  test('an expired session fails the call and reconnects with a fresh session', async () => {
    const spy = tempLog();
    const fixture = await startFixture(['--expire-session', '--spy', spy]);
    const manager = track(new McpServerManager());
    manager.grantLaunchApproval('remote');

    const first = await manager.callTool(remoteServer(fixture.url), 'echo', { text: 'one' });
    expect(first.content).to.equal('one');

    let failure: unknown;
    try {
      await manager.callTool(remoteServer(fixture.url), 'echo', { text: 'two' });
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(McpError);
    expect((failure as McpError).code).to.equal('closed');

    // The next operation transparently re-initializes a fresh session.
    const third = await manager.callTool(remoteServer(fixture.url), 'echo', { text: 'three' });
    expect(third.content).to.equal('three');

    const log = readSpy(spy);
    expect(log.filter((line) => line === 'method initialize').length).to.be.greaterThanOrEqual(2);
    await manager.disconnectAll();
  });

  test('an oversized HTTP response drops the connection instead of buffering without bound', async () => {
    const fixture = await startFixture(['--oversized']);
    const manager = track(new McpServerManager());
    manager.grantLaunchApproval('remote');
    const client = await manager.connectApproved(remoteServer(fixture.url));

    let failure: unknown;
    try {
      await client.callTool('large', {});
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(McpError);
    expect((failure as McpError).code).to.equal('protocol');
    expect((failure as McpError).message).to.contain('oversized');
    expect(client.isConnected()).to.equal(false);
    await manager.disconnectAll();
  });

  test('refuses redirects instead of bouncing to an unreviewed host', async () => {
    const spy = tempLog();
    const fixture = await startFixture(['--redirect', '--spy', spy]);
    const manager = track(new McpServerManager());
    manager.grantLaunchApproval('remote');

    let failure: unknown;
    try {
      await manager.connectApproved(remoteServer(fixture.url));
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(McpError);
    expect((failure as McpError).code).to.equal('protocol');
    expect((failure as McpError).message).to.match(/redirect/i);
    const log = readSpy(spy);
    expect(log.some((line) => line.startsWith('method'))).to.equal(false);
    expect(log).to.not.contain('method tools/call');
    await manager.disconnectAll();
  });

  test('SSE responses are parsed and mixed notifications/requests are handled safely', async () => {
    const spy = tempLog();
    const fixture = await startFixture(['--sse-response', '--spy', spy]);
    const manager = track(new McpServerManager());
    manager.grantLaunchApproval('remote');
    const client = await manager.connectApproved(remoteServer(fixture.url));

    const result = await client.callTool('echo', { text: 'stream' });

    expect(result.content).to.equal('stream');
    expect(client.notificationCount()).to.be.greaterThanOrEqual(1);
    // The client answers the server-initiated request with -32601 and never executes it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(readSpy(spy)).to.contain('client-error -32601');
    await manager.disconnectAll();
  });

  test('shutdown sends a session-terminating DELETE', async () => {
    const spy = tempLog();
    const fixture = await startFixture(['--spy', spy]);
    const manager = track(new McpServerManager());
    manager.grantLaunchApproval('remote');

    await manager.connectApproved(remoteServer(fixture.url));
    await manager.disconnectAll();

    expect(readSpy(spy)).to.contain('delete');
  });
});

suite('streamable HTTP authentication (fixture)', () => {
  test('succeeds with a stored bearer credential', async () => {
    const spy = tempLog();
    const fixture = await startFixture(['--auth', '--spy', spy]);
    const storage = new MemorySecretStorage();
    await storeMcpCredential(storage, 'remote', 'test-token-123');
    const manager = track(new McpServerManager({ credentials: storage }));
    manager.grantLaunchApproval('remote');

    const result = await manager.callTool(remoteServer(fixture.url, { auth: 'bearer' }), 'echo', { text: 'hi' });

    expect(result.content).to.equal('hi');
    expect(readSpy(spy)).to.contain('auth ok');
    expect(readSpy(spy)).to.not.contain('auth fail');
    await manager.disconnectAll();
  });

  test('fails with a wrong credential and never leaks the token', async () => {
    const fixture = await startFixture(['--auth']);
    const storage = new MemorySecretStorage();
    await storeMcpCredential(storage, 'remote', 'super-secret-token-abc123');
    const manager = track(new McpServerManager({ credentials: storage }));
    manager.grantLaunchApproval('remote');

    let failure: unknown;
    try {
      await manager.connectApproved(remoteServer(fixture.url, { auth: 'bearer' }));
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(McpError);
    expect((failure as McpError).code).to.equal('auth');
    expect((failure as McpError).message).to.not.contain('super-secret-token-abc123');
    expect(manager.lastError('remote') ?? '').to.not.contain('super-secret-token-abc123');
    await manager.disconnectAll();
  });

  test('fails closed when the credential is missing from SecretStorage', async () => {
    const fixture = await startFixture(['--auth']);
    const storage = new MemorySecretStorage();
    const manager = track(new McpServerManager({ credentials: storage }));
    manager.grantLaunchApproval('remote');

    let failure: unknown;
    try {
      await manager.connectApproved(remoteServer(fixture.url, { auth: 'bearer' }));
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(McpError);
    expect((failure as McpError).code).to.equal('auth');
    expect((failure as McpError).message).to.contain('No bearer credential');
    await manager.disconnectAll();
  });

  test('fails closed when no credential store is wired at all', async () => {
    const fixture = await startFixture(['--auth']);
    const manager = track(new McpServerManager());
    manager.grantLaunchApproval('remote');

    let failure: unknown;
    try {
      await manager.connectApproved(remoteServer(fixture.url, { auth: 'bearer' }));
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(McpError);
    expect((failure as McpError).code).to.equal('auth');
    expect((failure as McpError).message).to.contain('unavailable');
    await manager.disconnectAll();
  });

  test('a 500 body echoing the credential is scrubbed from errors and diagnostics', async () => {
    const fixture = await startFixture(['--leak-token-on-500']);
    const storage = new MemorySecretStorage();
    await storeMcpCredential(storage, 'remote', 'super-secret-token-abc123');
    const manager = track(new McpServerManager({ credentials: storage }));
    manager.grantLaunchApproval('remote');

    let failure: unknown;
    try {
      await manager.callTool(remoteServer(fixture.url, { auth: 'bearer' }), 'large', {});
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(McpError);
    expect((failure as McpError).message).to.not.contain('super-secret-token-abc123');
    expect((failure as McpError).message).to.match(/\[REDACTED\]|\[redacted\]/i);
    expect(manager.lastError('remote') ?? '').to.not.contain('super-secret-token-abc123');
    await manager.disconnectAll();
  });

  test('a 401 body echoing the Authorization header is never surfaced', async () => {
    const fixture = await startFixture(['--leak-token-on-401']);
    const storage = new MemorySecretStorage();
    await storeMcpCredential(storage, 'remote', 'super-secret-token-abc123');
    const manager = track(new McpServerManager({ credentials: storage }));
    manager.grantLaunchApproval('remote');

    let failure: unknown;
    try {
      await manager.connectApproved(remoteServer(fixture.url, { auth: 'bearer' }));
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(McpError);
    expect((failure as McpError).message).to.not.contain('super-secret-token-abc123');
    await manager.disconnectAll();
  });

  test('credential removal and replacement invalidate the cached connection and approval', async () => {
    const fixture = await startFixture(['--auth']);
    const storage = new MemorySecretStorage();
    await storeMcpCredential(storage, 'remote', 'test-token-123');
    const manager = track(new McpServerManager({ credentials: storage }));
    manager.grantLaunchApproval('remote');

    await manager.connectApproved(remoteServer(fixture.url, { auth: 'bearer' }));
    expect(manager.hasLaunchApproval('remote')).to.equal(true);

    // Simulate the management-UI credential replacement flow.
    await storeMcpCredential(storage, 'remote', 'rotated-token-456');
    await manager.disconnect('remote');
    manager.revokeLaunchApproval('remote');

    expect(manager.hasLaunchApproval('remote')).to.equal(false);
    await manager.disconnectAll();
  });
});

suite('streamable HTTP endpoint rules', () => {
  test('accepts https endpoints and loopback http endpoints', () => {
    expect(parseMcpEndpoint('https://mcp.example.com/v1/mcp').ok).to.equal(true);
    expect(parseMcpEndpoint('http://127.0.0.1:8734/mcp').ok).to.equal(true);
    expect(parseMcpEndpoint('http://localhost/mcp').ok).to.equal(true);
    expect(parseMcpEndpoint('http://[::1]:8734/mcp').ok).to.equal(true);
  });

  test('rejects plain http for non-loopback hosts', () => {
    const result = parseMcpEndpoint('http://mcp.internal.example.com/mcp');
    expect(result.ok).to.equal(false);
    if (!result.ok) {
      expect(result.error).to.contain('loopback');
    }
  });

  test('rejects unsupported schemes and malformed URLs', () => {
    for (const value of ['ftp://example.com/mcp', 'file:///etc/passwd', 'wss://example.com/mcp', 'not a url', '']) {
      expect(parseMcpEndpoint(value).ok).to.equal(false);
    }
  });

  test('rejects userinfo, query strings and fragments', () => {
    expect(parseMcpEndpoint('https://user:pass@example.com/mcp').ok).to.equal(false);
    expect(parseMcpEndpoint('https://example.com/mcp?token=abc').ok).to.equal(false);
    expect(parseMcpEndpoint('https://example.com/mcp#frag').ok).to.equal(false);
  });
});

suite('streamable HTTP approval invalidation', () => {
  test('an endpoint change evicts the cached connection and revokes launch approval', async () => {
    const fixtureA = await startFixture([]);
    const fixtureB = await startFixture([]);
    const manager = track(new McpServerManager());
    manager.grantLaunchApproval('remote');

    await manager.connectApproved(remoteServer(fixtureA.url));
    expect(manager.hasLaunchApproval('remote')).to.equal(true);

    // Same server name, different endpoint: stale connection and approval must not survive.
    await manager.connectApproved(remoteServer(fixtureB.url));

    expect(manager.hasLaunchApproval('remote')).to.equal(false);
    await manager.disconnectAll();
  });

  test('an auth-scheme change (none -> bearer) evicts the cached connection and approval', async () => {
    const fixture = await startFixture([]);
    const storage = new MemorySecretStorage();
    await storeMcpCredential(storage, 'remote', 'test-token-123');
    const manager = track(new McpServerManager({ credentials: storage }));
    manager.grantLaunchApproval('remote');

    await manager.connectApproved(remoteServer(fixture.url, { auth: 'none' }));
    expect(manager.hasLaunchApproval('remote')).to.equal(true);

    await manager.connectApproved(remoteServer(fixture.url, { auth: 'bearer' }));

    expect(manager.hasLaunchApproval('remote')).to.equal(false);
    await manager.disconnectAll();
  });

  test('snapshots carry the transport and endpoint without leaking credentials', async () => {
    const fixture = await startFixture([]);
    const storage = new MemorySecretStorage();
    await storeMcpCredential(storage, 'remote', 'super-secret-token-abc123');
    const manager = track(new McpServerManager({ credentials: storage }));

    await manager.connectApproved(remoteServer(fixture.url, { auth: 'bearer' }));
    const [snapshot] = manager.snapshot([{ ...remoteServer(fixture.url, { auth: 'bearer' }) }]);

    expect(snapshot.transport).to.equal('streamable-http');
    expect(snapshot.url).to.equal(fixture.url);
    expect(snapshot.auth).to.equal('bearer');
    expect(JSON.stringify(snapshot)).to.not.contain('super-secret-token-abc123');
    await manager.disconnectAll();
  });
});
