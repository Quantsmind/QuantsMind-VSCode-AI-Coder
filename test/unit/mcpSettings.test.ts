import { expect } from 'chai';
import { resolveMcpSettings } from '../../src/config/resolve';

suite('mcp settings resolution', () => {
  test('defaults to no servers', () => {
    expect(resolveMcpSettings({}).servers).to.deep.equal([]);
    expect(resolveMcpSettings({ servers: 'nope' }).servers).to.deep.equal([]);
  });

  test('parses valid servers and applies the enabled default', () => {
    const resolved = resolveMcpSettings({
      servers: [
        { name: 'github', command: 'node', args: ['server.cjs'] },
        { name: 'lint', command: 'eslint', enabled: false },
      ],
    });

    expect(resolved.servers).to.have.length(2);
    expect(resolved.servers[0]?.enabled).to.equal(true);
    expect(resolved.servers[1]?.enabled).to.equal(false);
  });

  test('rejects invalid entries: bad names, duplicates, bad commands, oversized args', () => {
    const resolved = resolveMcpSettings({
      servers: [
        { name: 'ok-server', command: 'node' },
        { name: 'bad name!', command: 'node' },
        { name: 'ok-server', command: 'python' }, // duplicate name dropped
        { name: 'ok2', command: 'node; rm -rf ~' }, // command rejected
        { name: 'ok3', command: 'node', args: ['fine.cjs'] },
        { name: 'ok4', command: 'node', args: ['fine.cjs', 42 as unknown as string] }, // non-string arg rejects entry
        { name: 'ok5', command: 'node', args: ['x'.repeat(600)] }, // oversized arg rejects entry
      ],
    });

    expect(resolved.servers.map((server) => server.name)).to.deep.equal(['ok-server', 'ok3']);
    expect(resolved.servers[1]?.args).to.deep.equal(['fine.cjs']);
  });
});
