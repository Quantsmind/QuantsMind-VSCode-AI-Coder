import { expect } from 'chai';
import * as path from 'node:path';
import {
  MAX_COMMAND_LENGTH,
  isWithinWorkspace,
  runApprovedCommand,
  tokenizeCommand,
  validateCommand,
} from '../../src/commands/runner';

const NODE = 'node';

function baseOptions(allowlist: string[]) {
  return {
    cwd: process.cwd(),
    workspaceRoot: process.cwd(),
    allowlist,
    timeoutMs: 10_000,
  };
}

suite('command tokenization', () => {
  test('splits plain commands', () => {
    expect(tokenizeCommand('npm run compile')).to.deep.equal(['npm', 'run', 'compile']);
    expect(tokenizeCommand('   ')).to.deep.equal([]);
  });

  test('groups quoted arguments and keeps escaped spaces', () => {
    expect(tokenizeCommand('node -e "console.log(1)"')).to.deep.equal([
      'node',
      '-e',
      'console.log(1)',
    ]);
    expect(tokenizeCommand("node -e 'a b'")).to.deep.equal(['node', '-e', 'a b']);
    expect(tokenizeCommand('cmd a\\ b')).to.deep.equal(['cmd', 'a b']);
    expect(tokenizeCommand('node "a\\"b"')).to.deep.equal(['node', 'a"b']);
  });

  test('rejects unterminated quotes', () => {
    expect(tokenizeCommand('node "unterminated')).to.equal(undefined);
    expect(tokenizeCommand("node 'unterminated")).to.equal(undefined);
  });
});

suite('command validation', () => {
  const allowlist = ['npm test', 'npm run compile'];

  test('accepts allowlisted commands after whitespace normalization', () => {
    const result = validateCommand('   npm    test   ', allowlist);
    expect(result.ok).to.equal(true);
    expect(result.normalized).to.equal('npm test');
    expect(result.tokens).to.deep.equal(['npm', 'test']);
  });

  test('rejects commands outside the allowlist', () => {
    expect(validateCommand('rm -rf /', allowlist).reason).to.contain('allowlist');
    expect(validateCommand('npm test -- --watch', allowlist).ok).to.equal(false);
  });

  test('rejects every shell metacharacter', () => {
    for (const command of [
      'npm test; rm -rf /',
      'npm test && rm -rf /',
      'npm test || true',
      'npm test | tee out',
      'npm test > out',
      'npm test < in',
      'npm test $(whoami)',
      'npm test `whoami`',
    ]) {
      const result = validateCommand(command, [command]);
      expect(result.ok, command).to.equal(false);
      expect(result.reason).to.contain('metacharacters');
    }
  });

  test('rejects empty, overlong, and control-character commands', () => {
    expect(validateCommand('   ', allowlist).reason).to.equal('The command is empty.');
    expect(validateCommand('a'.repeat(MAX_COMMAND_LENGTH + 1), allowlist).reason).to.equal(
      'The command is too long.',
    );
    expect(validateCommand('npm\u0000test', allowlist).reason).to.contain('control characters');
  });

  test('rejects executable paths', () => {
    expect(validateCommand('/usr/bin/npm test', ['/usr/bin/npm test']).reason).to.contain(
      'bare command name',
    );
    expect(validateCommand('C:\\npm test', ['C:\\npm test']).reason).to.contain(
      'bare command name',
    );
  });

  test('containment rejects paths outside the workspace', () => {
    const root = process.cwd();
    expect(isWithinWorkspace(root, root)).to.equal(true);
    expect(isWithinWorkspace(path.join(root, 'src'), root)).to.equal(true);
    expect(isWithinWorkspace(path.resolve(root, '..'), root)).to.equal(false);
  });
});

suite('approved command execution', () => {
  test('does not spawn a command that is not allowlisted', async () => {
    const result = await runApprovedCommand('echo hello', baseOptions(['npm test']));
    expect(result.exitCode).to.equal(null);
    expect(result.output).to.equal('');
    expect(result.error).to.contain('allowlist');
  });

  test('refuses to run outside the workspace', async () => {
    const result = await runApprovedCommand(
      `${NODE} -v`,
      { ...baseOptions([`${NODE} -v`]), cwd: path.resolve(process.cwd(), '..') },
    );
    expect(result.error).to.contain('outside the workspace');
  });

  test('returns cancelled immediately when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runApprovedCommand(`${NODE} -v`, {
      ...baseOptions([`${NODE} -v`]),
      signal: controller.signal,
    });
    expect(result.cancelled).to.equal(true);
    expect(result.exitCode).to.equal(null);
  });

  test('runs an allowlisted command with a sanitized environment', async () => {
    const result = await runApprovedCommand(
      'node -p process.env.CI',
      baseOptions(['node -p process.env.CI']),
    );
    expect(result.exitCode).to.equal(0);
    expect(result.output.trim()).to.equal('1');
    expect(result.timedOut).to.equal(false);
    expect(result.cancelled).to.equal(false);
  });

  test('does not pass unrelated parent environment variables', async () => {
    process.env.QM_TEST_LEAK = 'leaked-value';
    try {
      const command = 'node -p process.env.QM_TEST_LEAK';
      const result = await runApprovedCommand(command, baseOptions([command]));
      expect(result.exitCode).to.equal(0);
      expect(result.output).to.contain('undefined');
      expect(result.output).to.not.contain('leaked-value');
    } finally {
      delete process.env.QM_TEST_LEAK;
    }
  });

  test('caps output length', async () => {
    const command = 'node test/fixtures/output.js';
    const result = await runApprovedCommand(command, {
      ...baseOptions([command]),
      maxOutputChars: 1_000,
    });
    expect(result.exitCode).to.equal(0);
    expect(result.truncated).to.equal(true);
    expect(result.output.length).to.be.at.most(1_000);
  });

  test('redacts the configured secret from command output', async () => {
    const secret = '1234567890';
    const command = `node -p ${secret}`;
    const result = await runApprovedCommand(command, {
      ...baseOptions([command]),
      secret,
    });
    expect(result.exitCode).to.equal(0);
    expect(result.output).to.contain('[REDACTED]');
    expect(result.output).to.not.contain(secret);
  });

  test('times out a long-running command', async () => {
    const command = 'node test/fixtures/sleep.js';
    const result = await runApprovedCommand(command, {
      ...baseOptions([command]),
      timeoutMs: 250,
    });
    expect(result.timedOut).to.equal(true);
    expect(result.exitCode).to.not.equal(0);
  });

  test('cancels a running command through an AbortSignal', async () => {
    const command = 'node test/fixtures/sleep.js';
    const controller = new AbortController();
    const running = runApprovedCommand(command, {
      ...baseOptions([command]),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await running;
    expect(result.cancelled).to.equal(true);
    expect(result.timedOut).to.equal(false);
  });

  test('reports a missing executable without throwing', async () => {
    const command = 'quantsmind-command-that-does-not-exist --version';
    const result = await runApprovedCommand(command, baseOptions([command]));
    expect(result.exitCode !== 0 || result.error !== undefined).to.equal(true);
  });
});
