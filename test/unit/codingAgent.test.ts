import { expect } from 'chai';
// Focused tests for the coding-agent runtime. Filesystem access is injected.
import {
  runCodingAgent,
  normalizeModelResponse,
  parseToolCallsFromText,
  AgentToolRegistry,
} from '../../src/agent/codingAgent';
import { WorkspaceTools, normalizeWorkspacePath } from '../../src/agent/workspaceTools';
import { ChangeTools } from '../../src/agent/changeTools';
import { CommandTools } from '../../src/agent/commandTools';

suite('coding agent runtime', () => {
  test('normalizes a native tool call response', () => {
    const normalized = normalizeModelResponse({
      text: '',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.txt' } }],
    });
    expect(normalized.toolCalls).to.have.length(1);
    expect(normalized.toolCalls[0].name).to.equal('read_file');
  });

  test('parses tool calls from a JSON text response', () => {
    const calls = parseToolCallsFromText('{"tool_calls":[{"name":"search_files","arguments":{"query":"foo"}}]}');
    expect(calls).to.have.length(1);
    expect(calls[0].name).to.equal('search_files');
    expect(calls[0].arguments.query).to.equal('foo');
  });

  test('rejects unknown tool kinds in the registry', async () => {
    const registry = new AgentToolRegistry();
    const result = await registry.execute({ id: '1', name: 'missing', arguments: {} });
    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('Unknown tool');
  });

  test('runs a single tool round and then returns a final answer', async () => {
    let calls = 0;
    const model = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          return { text: '{"tool_calls":[{"name":"read_file","arguments":{"path":"a.txt"}}]}' };
        }
        return { text: '{"final":"read complete"}' };
      },
    };
    const fs = {
      async readFile(path: string) {
        return `contents of ${path}`;
      },
      async listDirectory() {
        return [];
      },
    };
    const tools = new WorkspaceTools('/workspace', fs).toAgentTools();
    const result = await runCodingAgent({ task: 'read a.txt', model, tools, maxIterations: 5 });

    expect(result.status).to.equal('completed');
    expect(result.finalText).to.equal('read complete');
    expect(result.iterations).to.equal(2);
    expect(result.toolResults).to.have.length(1);
    expect(result.toolResults[0].ok).to.equal(true);
    expect(result.toolResults[0].output).to.equal('contents of a.txt');
  });

  test('supports multiple sequential tool rounds', async () => {
    let calls = 0;
    const model = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          return { text: '{"tool_calls":[{"name":"list_files","arguments":{"path":""}}]}' };
        }
        if (calls === 2) {
          return { text: '{"tool_calls":[{"name":"search_files","arguments":{"query":"needle"}}]}' };
        }
        return { text: '{"final":"search complete"}' };
      },
    };
    const fs = {
      async readFile() {
        return 'needle here';
      },
      async listDirectory() {
        return [{ name: 'a.txt', type: 'file' as const }];
      },
    };
    const tools = new WorkspaceTools('/workspace', fs).toAgentTools();
    const result = await runCodingAgent({ task: 'find needle', model, tools, maxIterations: 5 });

    expect(result.status).to.equal('completed');
    expect(result.finalText).to.equal('search complete');
    expect(result.iterations).to.equal(3);
    expect(result.toolResults).to.have.length(2);
  });

  test('records invalid tool requests without crashing the loop', async () => {
    let calls = 0;
    const model = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          return { text: '{"tool_calls":[{"name":"does_not_exist","arguments":{}}]}' };
        }
        return { text: '{"final":"handled invalid tool"}' };
      },
    };
    const fs = {
      async readFile() {
        return '';
      },
      async listDirectory() {
        return [];
      },
    };
    const tools = new WorkspaceTools('/workspace', fs).toAgentTools();
    const result = await runCodingAgent({ task: 'use missing tool', model, tools, maxIterations: 5 });

    expect(result.status).to.equal('completed');
    expect(result.toolResults).to.have.length(1);
    expect(result.toolResults[0].ok).to.equal(false);
    expect(result.toolResults[0].error).to.contain('Unknown tool');
  });

  test('returns an error status when the model request fails', async () => {
    const model = {
      async complete() {
        throw new Error('provider down');
      },
    };
    const fs = {
      async readFile() {
        return '';
      },
      async listDirectory() {
        return [];
      },
    };
    const tools = new WorkspaceTools('/workspace', fs).toAgentTools();
    const result = await runCodingAgent({ task: 'fail', model, tools, maxIterations: 2 });

    expect(result.status).to.equal('error');
    expect(result.finalText).to.equal('provider down');
  });

  test('returns cancelled when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const model = {
      async complete() {
        return { text: '{"final":"should not happen"}' };
      },
    };
    const fs = {
      async readFile() {
        return '';
      },
      async listDirectory() {
        return [];
      },
    };
    const tools = new WorkspaceTools('/workspace', fs).toAgentTools();
    const result = await runCodingAgent({ task: 'cancel', model, tools, signal: controller.signal, maxIterations: 2 });

    expect(result.status).to.equal('cancelled');
    expect(result.iterations).to.equal(0);
  });

  test('stops at the iteration limit', async () => {
    const model = {
      async complete() {
        return { text: '{"tool_calls":[{"name":"list_files","arguments":{"path":""}}]}' };
      },
    };
    const fs = {
      async readFile() {
        return '';
      },
      async listDirectory() {
        return [];
      },
    };
    const tools = new WorkspaceTools('/workspace', fs).toAgentTools();
    const result = await runCodingAgent({ task: 'loop', model, tools, maxIterations: 2 });

    expect(result.status).to.equal('limit');
    expect(result.iterations).to.equal(2);
    expect(result.toolResults).to.have.length(2);
  });
});

suite('workspace tools', () => {
  test('normalizes and rejects unsafe paths', () => {
    expect(normalizeWorkspacePath('src/file.ts')).to.equal('src/file.ts');
    expect(normalizeWorkspacePath('')).to.equal('');
    expect(normalizeWorkspacePath('../secret.txt')).to.equal(undefined);
    expect(normalizeWorkspacePath('/absolute/path')).to.equal(undefined);
    expect(normalizeWorkspacePath('C:\\Windows\\system.ini')).to.equal(undefined);
    expect(normalizeWorkspacePath('a/../../b')).to.equal(undefined);
  });

  test('reads a file through the injected file system', async () => {
    const fs = {
      async readFile(path: string) {
        return `content:${path}`;
      },
      async listDirectory() {
        return [];
      },
    };
    const tools = new WorkspaceTools('/workspace', fs);
    const result = await tools.readFile('src/file.ts');
    expect(result.ok).to.equal(true);
    expect(result.output).to.equal('content:src/file.ts');
  });

  test('returns an error for invalid read paths', async () => {
    const fs = {
      async readFile() {
        return '';
      },
      async listDirectory() {
        return [];
      },
    };
    const tools = new WorkspaceTools('/workspace', fs);
    const result = await tools.readFile('../secret.txt');
    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('outside the workspace');
  });

  test('lists files recursively', async () => {
    const fs = {
      async readFile() {
        return '';
      },
      async listDirectory(path: string) {
        if (path === '') {
          return [
            { name: 'src', type: 'directory' as const },
            { name: 'README.md', type: 'file' as const },
          ];
        }
        if (path === 'src') {
          return [{ name: 'index.ts', type: 'file' as const }];
        }
        return [];
      },
    };
    const tools = new WorkspaceTools('/workspace', fs);
    const result = await tools.listFiles('');
    expect(result.ok).to.equal(true);
    expect(result.output).to.contain('README.md');
    expect(result.output).to.contain('src/index.ts');
  });

  test('searches file contents', async () => {
    const fs = {
      async readFile(path: string) {
        return path === 'src/index.ts' ? 'const needle = 1;' : '';
      },
      async listDirectory(path: string) {
        if (path === '') {
          return [{ name: 'src', type: 'directory' as const }];
        }
        if (path === 'src') {
          return [{ name: 'index.ts', type: 'file' as const }];
        }
        return [];
      },
    };
    const tools = new WorkspaceTools('/workspace', fs);
    const result = await tools.searchFiles('needle');
    expect(result.ok).to.equal(true);
    expect(result.output).to.contain('src/index.ts:1');
  });
});

suite('coding agent repair workflow', () => {
  test('proposes, applies, validates, repairs, and revalidates', async () => {
    let calls = 0;
    const model = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          return { text: '{"tool_calls":[{"name":"prepare_file_change","arguments":{"changes":[{"kind":"create","path":"a.txt","content":"hello"}],"summary":"create a.txt"}}]}' };
        }
        if (calls === 2) {
          return { text: '{"tool_calls":[{"name":"apply_prepared_change","arguments":{}}]}' };
        }
        if (calls === 3) {
          return { text: '{"tool_calls":[{"name":"run_validation_command","arguments":{"command":"node -e \\"process.exit(1)\\""}}]}' };
        }
        if (calls === 4) {
          return { text: '{"tool_calls":[{"name":"prepare_file_change","arguments":{"changes":[{"kind":"modify","path":"a.txt","content":"hello repaired"}],"summary":"repair a.txt"}}]}' };
        }
        if (calls === 5) {
          return { text: '{"tool_calls":[{"name":"apply_prepared_change","arguments":{}}]}' };
        }
        if (calls === 6) {
          return { text: '{"tool_calls":[{"name":"run_validation_command","arguments":{"command":"node --version"}}]}' };
        }
        return { text: '{"final":"repair complete"}' };
      },
    };

    const service = {
      async prepare(plan: any) {
        return { plan, beforeByPath: new Map(), review: [{ kind: 'create', path: 'a.txt', summary: 'add file', diff: '+hello' }], errors: [], warnings: [] };
      },
      async apply() {
        return { outcome: { applied: [{ changeId: 'change-1', kind: 'create', path: 'a.txt', backupName: 'backup' }], conflicts: [], failed: [] }, entry: {} };
      },
      async undo() {
        return { restored: 1, conflicts: 0 };
      },
    };

    const fs = {
      async readFile() { return ''; },
      async listDirectory() { return []; },
    };
    const tools = [
      ...new WorkspaceTools('/workspace', fs).toAgentTools(),
      ...new ChangeTools(service as any, async () => ['change-1']).toAgentTools(),
      ...new CommandTools({
        cwd: process.cwd(),
        workspaceRoot: process.cwd(),
        allowlist: ['node -e "process.exit(1)"', 'node --version'],
        timeoutMs: 5000,
        trusted: true,
        approval: async () => true,
      }).toAgentTools(),
    ];

    const result = await runCodingAgent({ task: 'repair the change', model, tools, maxIterations: 10 });

    expect(result.status).to.equal('completed');
    expect(result.finalText).to.equal('repair complete');
    expect(result.iterations).to.equal(7);
    expect(result.toolResults).to.have.length(6);
    expect(result.toolResults[2].ok).to.equal(false);
    expect(result.toolResults[5].ok).to.equal(true);
  });
});

suite('coding agent lifecycle and safety controls', () => {
  test('cancellation during tool execution stops the loop', async () => {
    const controller = new AbortController();
    const model = {
      async complete() {
        return {
          text: '{"tool_calls":[{"name":"read_file","arguments":{"path":"a.txt"}}]}',
        };
      },
    };
    const fs = {
      async readFile() {
        // Simulate a slow tool that gets cancelled.
        return new Promise<string>((_resolve) => {
          controller.signal.addEventListener(
            'abort',
            () => {
              // No-op: the caller will not await this promise after abort.
            },
            { once: true },
          );
        });
      },
      async listDirectory() {
        return [];
      },
    };
    const tools = new WorkspaceTools('/workspace', fs).toAgentTools();
    // Abort before the first model request.
    controller.abort();
    const result = await runCodingAgent({
      task: 'cancelled task',
      model,
      tools,
      signal: controller.signal,
      maxIterations: 5,
    });
    expect(result.status).to.equal('cancelled');
    expect(result.iterations).to.equal(0);
  });

  test('iteration limit stops the loop with limit status', async () => {
    const model = {
      async complete() {
        return {
          text: '{"tool_calls":[{"name":"list_files","arguments":{"path":""}}]}',
        };
      },
    };
    const fs = {
      async readFile() {
        return '';
      },
      async listDirectory() {
        return [];
      },
    };
    const tools = new WorkspaceTools('/workspace', fs).toAgentTools();
    const result = await runCodingAgent({
      task: 'loop forever',
      model,
      tools,
      maxIterations: 2,
    });
    expect(result.status).to.equal('limit');
    expect(result.iterations).to.equal(2);
    expect(result.toolResults).to.have.length(2);
  });

  test('model error returns error status with message', async () => {
    const model = {
      async complete() {
        throw new Error('provider connection lost');
      },
    };
    const fs = {
      async readFile() {
        return '';
      },
      async listDirectory() {
        return [];
      },
    };
    const tools = new WorkspaceTools('/workspace', fs).toAgentTools();
    const result = await runCodingAgent({
      task: 'fail',
      model,
      tools,
      maxIterations: 2,
    });
    expect(result.status).to.equal('error');
    expect(result.finalText).to.equal('provider connection lost');
    expect(result.iterations).to.equal(1);
  });

  test('repeated identical failing operations are recorded but do not crash', async () => {
    let failures = 0;
    const model = {
      async complete() {
        failures += 1;
        if (failures <= 2) {
          return {
            text: '{"tool_calls":[{"name":"read_file","arguments":{"path":"missing.txt"}}]}',
          };
        }
        return { text: '{"final":"gave up"}' };
      },
    };
    const fs = {
      async readFile() {
        throw new Error('file not found');
      },
      async listDirectory() {
        return [];
      },
    };
    const tools = new WorkspaceTools('/workspace', fs).toAgentTools();
    const result = await runCodingAgent({
      task: 'read missing file',
      model,
      tools,
      maxIterations: 5,
    });
    expect(result.status).to.equal('completed');
    expect(result.finalText).to.equal('gave up');
    expect(result.toolResults).to.have.length(2);
    for (const r of result.toolResults) {
      expect(r.ok).to.equal(false);
      expect(r.error).to.contain('file not found');
    }
  });

  test('get_workspace_context returns combined listing and search', async () => {
    const fs = {
      async readFile(path: string) {
        if (path === 'src/index.ts') {
          return 'export function main() { return 1; }';
        }
        return '';
      },
      async listDirectory(path: string) {
        if (path === '') {
          return [
            { name: 'src', type: 'directory' as const },
            { name: 'README.md', type: 'file' as const },
          ];
        }
        if (path === 'src') {
          return [{ name: 'index.ts', type: 'file' as const }];
        }
        return [];
      },
    };
    const tools = new WorkspaceTools('/workspace', fs);
    const result = await tools.getWorkspaceContext('main');
    expect(result.ok).to.equal(true);
    expect(result.output).to.contain('src/index.ts');
    expect(result.output).to.contain('README.md');
    expect(result.output).to.contain('Workspace root: /workspace');
  });
});


