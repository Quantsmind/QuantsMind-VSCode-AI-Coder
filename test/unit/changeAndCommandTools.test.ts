import { expect } from 'chai';
import { ChangeTools } from '../../src/agent/changeTools';
import { CommandTools } from '../../src/agent/commandTools';

suite('change tools', () => {
  test('prepares a reviewable change set', async () => {
    const service = {
      async prepare(plan: any) {
        return {
          plan,
          beforeByPath: new Map(),
          review: [{ kind: 'create', path: 'a.txt', summary: 'add file', diff: '', additions: 1, deletions: 0, diffTruncated: false }],
          errors: [],
          warnings: [],
        };
      },
      async apply() {
        return { outcome: { applied: [{ changeId: 'change-1', kind: 'create', path: 'a.txt', backupName: 'backup' }], conflicts: [], failed: [] }, entry: {} };
      },
      async undo() {
        return { restored: 1, conflicts: 0 };
      },
    };
    const tools = new ChangeTools(service as any, async () => ['change-1']);
    const tool = tools.toAgentTools().find((item) => item.name === 'prepare_file_change')!;
    const result = await tool.execute({ changes: [{ kind: 'create', path: 'a.txt', content: 'hello' }], summary: 'add file' });

    expect(result.ok).to.equal(true);
    expect(result.output).to.contain('a.txt');
  });

  test('rejects invalid change paths', async () => {
    const service = {
      async prepare() { return { plan: {}, beforeByPath: new Map(), review: [], errors: [], warnings: [] }; },
      async apply() { return { outcome: { applied: [], conflicts: [], failed: [] }, entry: {} }; },
      async undo() { return { restored: 0, conflicts: 0 }; },
    };
    const tools = new ChangeTools(service as any, async () => []);
    const tool = tools.toAgentTools().find((item) => item.name === 'prepare_file_change')!;
    const result = await tool.execute({ changes: [{ kind: 'create', path: '../secret.txt', content: 'x' }] });

    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('invalid or unsafe path');
  });

  test('applies a prepared change set after approval', async () => {
    const service = {
      async prepare(plan: any) {
        return { plan, beforeByPath: new Map(), review: [{ kind: 'create', path: 'a.txt', summary: 'add file' }], errors: [], warnings: [] };
      },
      async apply() {
        return { outcome: { applied: [{ changeId: 'change-1', kind: 'create', path: 'a.txt', backupName: 'backup' }], conflicts: [], failed: [] }, entry: {} };
      },
      async undo() {
        return { restored: 1, conflicts: 0 };
      },
    };
    const tools = new ChangeTools(service as any, async () => ['change-1']);
    const prepareTool = tools.toAgentTools().find((item) => item.name === 'prepare_file_change')!;
    const applyTool = tools.toAgentTools().find((item) => item.name === 'apply_prepared_change')!;
    await prepareTool.execute({ changes: [{ kind: 'create', path: 'a.txt', content: 'hello' }] });
    const result = await applyTool.execute({});

    expect(result.ok).to.equal(true);
    expect(result.output).to.contain('a.txt');
  });

  test('does not apply without approval', async () => {
    const service = {
      async prepare(plan: any) {
        return { plan, beforeByPath: new Map(), review: [{ kind: 'create', path: 'a.txt', summary: 'add file' }], errors: [], warnings: [] };
      },
      async apply() {
        return { outcome: { applied: [], conflicts: [], failed: [] }, entry: {} };
      },
      async undo() {
        return { restored: 0, conflicts: 0 };
      },
    };
    const tools = new ChangeTools(service as any, async () => undefined);
    const prepareTool = tools.toAgentTools().find((item) => item.name === 'prepare_file_change')!;
    const applyTool = tools.toAgentTools().find((item) => item.name === 'apply_prepared_change')!;
    await prepareTool.execute({ changes: [{ kind: 'create', path: 'a.txt', content: 'hello' }] });
    const result = await applyTool.execute({});

    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('requires explicit approval');
  });
});

suite('command tools', () => {
  test('reports allowlisted command policy', async () => {
    const tools = new CommandTools({
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      allowlist: ['node --version'],
      timeoutMs: 1000,
      trusted: true,
      approval: async () => true,
    });
    const tool = tools.toAgentTools().find((item) => item.name === 'check_command')!;
    const result = await tool.execute({ command: 'node --version' });

    expect(result.ok).to.equal(true);
    expect(result.output).to.contain('"allowed": true');
  });

  test('rejects commands outside the allowlist', async () => {
    const tools = new CommandTools({
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      allowlist: ['node --version'],
      timeoutMs: 1000,
      trusted: true,
      approval: async () => true,
    });
    const tool = tools.toAgentTools().find((item) => item.name === 'run_command')!;
    const result = await tool.execute({ command: 'rm -rf /' });

    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('Destructive commands are not permitted');
  });

  test('diagnoses validation failures without running a command', async () => {
    const tools = new CommandTools({
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      allowlist: ['node --version'],
      timeoutMs: 1000,
      trusted: true,
      approval: async () => true,
    });
    const tool = tools.toAgentTools().find((item) => item.name === 'diagnose_validation_failure')!;
    const result = await tool.execute({ output: 'test.ts(42,1): error TS2304: Cannot find name test' });

    expect(result.ok).to.equal(true);
    expect(result.output).to.contain('TS2304');
  });

  test('does not run without approval', async () => {
    const tools = new CommandTools({
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      allowlist: ['node --version'],
      timeoutMs: 1000,
      trusted: true,
      approval: async () => false,
    });
    const tool = tools.toAgentTools().find((item) => item.name === 'run_command')!;
    const result = await tool.execute({ command: 'node --version' });

    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('requires explicit approval');
  });

  test('runs an approved allowlisted command', async () => {
    const tools = new CommandTools({
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      allowlist: ['node --version'],
      timeoutMs: 5000,
      trusted: true,
      approval: async () => true,
    });
    const tool = tools.toAgentTools().find((item) => item.name === 'run_command')!;
    const result = await tool.execute({ command: 'node --version' });

    expect(result.ok).to.equal(true);
    expect(result.output).to.contain('"exitCode": 0');
  });
});
